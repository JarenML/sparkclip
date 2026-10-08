"""
Cut a clip's stretch out of YouTube's DASH files with byte ranges.

YouTube serves video and audio as separate fragmented MP4 files that open
with ftyp, moov and a sidx box indexing every fragment (moof + mdat) by byte
size and duration. The init section (ftyp + moov) followed by any run of
whole fragments is itself a playable file, so a clip's window needs only the
init bytes and one byte range per stream: no playlist, and no FFmpeg network
access (which would bypass the socket guard).
"""

import struct
from dataclasses import dataclass
from typing import Optional

# Bytes read from a file's start to find its sidx. A 3-hour stream's index is
# ~25 KB; the reader retries once with the size the box header asks for.
INDEX_PROBE_BYTES = 256 * 1024
MAX_INDEX_BYTES = 4 * 1024 * 1024
# Clip windows come from H.264 + AAC: both mux into mp4 without re-encoding,
# and YouTube's VP9/Opus streams use WebM, which has no sidx.
WINDOW_VIDEO_CODEC = "avc1"
WINDOW_AUDIO_CODEC = "mp4a"
MAX_WINDOW_SHORT_SIDE = 2160


@dataclass
class Fragment:
    """Seconds are from the first fragment's start: the timeline of a full
    download, which starts each stream at zero (yt-dlp's merge drops a
    stream's leading delay, such as H.264 reordering)."""

    offset: int
    size: int
    start_seconds: float
    duration_seconds: float


@dataclass
class DashIndex:
    """Where a DASH MP4's init section ends and its fragments are."""

    init_size: int
    fragments: list[Fragment]


@dataclass
class ByteWindow:
    """The fragments covering a time window: one byte range and where it starts and ends."""

    first_byte: int
    last_byte: int
    start_seconds: float
    end_seconds: float


class IndexNeedsMoreBytes(Exception):
    """The sidx ends past the bytes read; `needed` is how many to read."""

    def __init__(self, needed: int):
        super().__init__(needed)
        self.needed = needed


def _boxes(data: bytes):
    """Top-level (type, start, end) boxes, stopping at the first one that runs past `data`."""
    position = 0
    while position + 8 <= len(data):
        size, kind = struct.unpack_from(">I4s", data, position)
        header = 8
        if size == 1:
            if position + 16 > len(data):
                return
            size = struct.unpack_from(">Q", data, position + 8)[0]
            header = 16
        if size < header:
            return
        yield kind, position, position + size, header
        position += size


def parse_dash_index(data: bytes) -> Optional[DashIndex]:
    """Read the init section and sidx at the start of a YouTube DASH MP4.

    Returns None for a file this can't cut (no sidx right after moov, a
    hierarchical index, empty fragments). Raises IndexNeedsMoreBytes when the
    sidx doesn't fit in `data`.
    """
    init_size: Optional[int] = None
    for kind, start, end, header in _boxes(data):
        if kind == b"moov":
            init_size = end
        elif kind == b"sidx":
            if init_size is None:
                return None
            if end > len(data):
                raise IndexNeedsMoreBytes(end)
            return _parse_sidx(data[start + header:end], end, init_size)
        elif kind in (b"moof", b"mdat"):
            return None
        if end > len(data):
            if kind in (b"ftyp", b"moov", b"free", b"styp"):
                raise IndexNeedsMoreBytes(end + 1024)
            return None
    return None


def _parse_sidx(body: bytes, sidx_end: int, init_size: int) -> Optional[DashIndex]:
    if len(body) < 12:
        return None
    version = body[0]
    timescale = struct.unpack_from(">I", body, 8)[0]
    if timescale == 0:
        return None
    if version == 0:
        if len(body) < 24:
            return None
        earliest, first_offset = struct.unpack_from(">II", body, 12)
        position = 20
    else:
        if len(body) < 32:
            return None
        earliest, first_offset = struct.unpack_from(">QQ", body, 12)
        position = 28
    count = struct.unpack_from(">H", body, position + 2)[0]
    position += 4
    if count == 0 or len(body) < position + 12 * count:
        return None
    del earliest  # Times count from the first fragment (see Fragment).
    fragments: list[Fragment] = []
    offset = sidx_end + first_offset
    elapsed = 0
    for _ in range(count):
        reference, duration = struct.unpack_from(">II", body, position)
        position += 12
        size = reference & 0x7FFFFFFF
        # A reference to another sidx (hierarchical index) isn't a fragment.
        if reference >> 31 or size == 0 or duration == 0:
            return None
        fragments.append(Fragment(offset, size, elapsed / timescale, duration / timescale))
        offset += size
        elapsed += duration
    return DashIndex(init_size=init_size, fragments=fragments)


def window_bytes(index: DashIndex, start_seconds: float, end_seconds: float, pad_seconds: float) -> Optional[ByteWindow]:
    """The run of whole fragments overlapping [start - pad, end + pad], or None if none do."""
    low = max(0.0, start_seconds - pad_seconds)
    high = end_seconds + pad_seconds
    kept = [f for f in index.fragments if f.start_seconds + f.duration_seconds > low and f.start_seconds < high]
    if not kept:
        return None
    first, last = kept[0], kept[-1]
    return ByteWindow(
        first_byte=first.offset,
        last_byte=last.offset + last.size - 1,
        start_seconds=first.start_seconds,
        end_seconds=last.start_seconds + last.duration_seconds,
    )


def _is_https(fmt: dict) -> bool:
    return fmt.get("protocol") == "https" and isinstance(fmt.get("url"), str)


def pick_window_formats(info: dict) -> Optional[tuple[dict, dict]]:
    """The best H.264 video-only and AAC audio-only DASH streams in yt-dlp's info.

    Video: the highest resolution up to 2160 on the shorter side, SDR first
    (renders are SDR), then frame rate and bitrate. Audio: the original
    language track, without YouTube's dynamic range compression, best bitrate.
    """
    formats = [f for f in info.get("formats") or [] if isinstance(f, dict) and _is_https(f)]
    videos = [
        f for f in formats
        if str(f.get("vcodec") or "").startswith(WINDOW_VIDEO_CODEC) and f.get("acodec") in (None, "none")
        and f.get("ext") == "mp4" and isinstance(f.get("height"), int) and isinstance(f.get("width"), int)
        and min(f["width"], f["height"]) <= MAX_WINDOW_SHORT_SIDE
    ]
    audios = [
        f for f in formats
        if str(f.get("acodec") or "").startswith(WINDOW_AUDIO_CODEC) and f.get("vcodec") in (None, "none")
        and f.get("ext") == "m4a"
    ]
    if not videos or not audios:
        return None
    video = max(videos, key=lambda f: (
        min(f["width"], f["height"]), (f.get("dynamic_range") or "SDR") == "SDR", f.get("fps") or 0, f.get("tbr") or 0,
    ))
    audio = max(audios, key=lambda f: (
        f.get("language_preference") or 0, "drc" not in str(f.get("format_id") or "").lower(), f.get("abr") or f.get("tbr") or 0,
    ))
    return video, audio
