"""
YouTube save-space windows: reading a DASH MP4's sidx, choosing the bytes
around a clip, and joining video and audio on the full video's timeline.
"""

import asyncio
import contextlib
import io
import json
import os
import shutil
import struct
import subprocess

import pytest

from clip_engine.services import video_downloader as module
from clip_engine.services.dash_window import (DashIndex, Fragment, IndexNeedsMoreBytes, parse_dash_index,
                                              pick_window_formats, window_bytes)
from clip_engine.services.video_downloader import VideoDownloaderService, VideoDownloadError

FFMPEG = os.environ.get("TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("TEST_FFPROBE") or shutil.which("ffprobe")


def box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(body), kind) + body


def sidx(references: list[tuple[int, int]], timescale=1000, earliest=0, first_offset=0, version=0, hierarchical=False) -> bytes:
    times = struct.pack(">II", earliest, first_offset) if version == 0 else struct.pack(">QQ", earliest, first_offset)
    body = bytes([version, 0, 0, 0]) + struct.pack(">II", 1, timescale) + times + struct.pack(">HH", 0, len(references))
    for size, duration in references:
        body += struct.pack(">III", (1 << 31 if hierarchical else 0) | size, duration, 0x90000000)
    return box(b"sidx", body)


HEAD = box(b"ftyp", b"dash" + bytes(4)) + box(b"moov", bytes(100))


@pytest.mark.parametrize("version", [0, 1])
def test_sidx_gives_each_fragment_its_bytes_and_time(version):
    index_box = sidx([(1000, 5000), (2000, 5000), (1500, 2500)], earliest=1000, first_offset=10, version=version)
    index = parse_dash_index(HEAD + index_box)
    assert index.init_size == len(HEAD)
    first = len(HEAD) + len(index_box) + 10
    # Times count from the first fragment, as in a full download.
    assert [(f.offset, f.size, f.start_seconds, f.duration_seconds) for f in index.fragments] == [
        (first, 1000, 0.0, 5.0), (first + 1000, 2000, 5.0, 5.0), (first + 3000, 1500, 10.0, 2.5),
    ]


def test_index_reports_how_many_bytes_it_needs_and_rejects_what_it_cannot_cut():
    data = HEAD + sidx([(1000, 5000)] * 50)
    with pytest.raises(IndexNeedsMoreBytes) as more:
        parse_dash_index(data[:len(HEAD) + 40])
    assert more.value.needed == len(data)
    assert parse_dash_index(HEAD + sidx([(1000, 5000)], hierarchical=True)) is None
    assert parse_dash_index(HEAD + box(b"moof", bytes(8))) is None
    # A sidx before the init section ends.
    assert parse_dash_index(box(b"ftyp", bytes(8)) + sidx([(1000, 5000)])) is None


def test_window_keeps_whole_fragments_around_the_clip():
    index = DashIndex(init_size=100, fragments=[Fragment(1000 + 10 * i, 10, 5.0 * i, 5.0) for i in range(10)])
    window = window_bytes(index, 12.0, 18.0, 2.0)
    assert (window.first_byte, window.last_byte, window.start_seconds, window.end_seconds) == (1020, 1039, 10.0, 20.0)
    assert window_bytes(index, 0.0, 1.0, 0.0).start_seconds == 0.0
    assert window_bytes(index, 80.0, 90.0, 0.0) is None


def test_window_formats_are_the_best_h264_video_and_original_aac_audio():
    def fmt(format_id, **fields):
        return {"format_id": format_id, "protocol": "https", "url": f"https://r.googlevideo.com/{format_id}", **fields}

    info = {"formats": [
        fmt("313", ext="webm", vcodec="vp9", acodec="none", width=3840, height=2160),
        fmt("298", ext="mp4", vcodec="avc1.640020", acodec="none", width=1280, height=720, fps=60),
        fmt("299", ext="mp4", vcodec="avc1.64002a", acodec="none", width=1920, height=1080, fps=60),
        fmt("hls", ext="mp4", vcodec="avc1.64002a", acodec="none", width=1920, height=1080, fps=60, protocol="m3u8_native"),
        fmt("251", ext="webm", vcodec="none", acodec="opus", abr=130),
        fmt("140-drc", ext="m4a", vcodec="none", acodec="mp4a.40.2", abr=129),
        fmt("140", ext="m4a", vcodec="none", acodec="mp4a.40.2", abr=129),
        fmt("139", ext="m4a", vcodec="none", acodec="mp4a.40.5", abr=49),
    ]}
    video, audio = pick_window_formats(info)
    assert (video["format_id"], audio["format_id"]) == ("299", "140")
    # A dubbed track loses to the original language.
    info["formats"].append(fmt("140-dub", ext="m4a", vcodec="none", acodec="mp4a.40.2", abr=200, language_preference=-1))
    info["formats"].append(fmt("139-orig", ext="m4a", vcodec="none", acodec="mp4a.40.5", abr=49, language_preference=10))
    assert pick_window_formats(info)[1]["format_id"] == "139-orig"
    assert pick_window_formats({"formats": [f for f in info["formats"] if f["format_id"] != "299" and f["format_id"] != "298"]}) is None


class RangeServer:
    """Stands in for yt-dlp's YoutubeDL: serves byte ranges of local files by URL."""

    files: dict[str, bytes] = {}
    requests: list[tuple[str, str]] = []
    ignore_range = False

    def __init__(self, params):
        self.params = params

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def urlopen(self, request):
        data = self.files[request.url]
        RangeServer.requests.append((request.url, request.headers["Range"]))
        if not self.ignore_range:
            first, last = (int(part) for part in request.headers["Range"].removeprefix("bytes=").split("-"))
            data = data[first:last + 1]
        return contextlib.closing(io.BytesIO(data))


def encode(path, args):
    subprocess.run([FFMPEG, "-v", "error", "-y", *args, "-movflags", "frag_keyframe+empty_moov+global_sidx+default_base_moof", path], check=True)


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not (FFMPEG and FFPROBE):
        pytest.skip("FFmpeg and FFprobe required")
    video, audio = tmp_path / "v.mp4", tmp_path / "a.m4a"
    # 2 s video fragments and 3 s audio fragments, like YouTube's uneven ones.
    encode(str(video), ["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-t", "60", "-c:v", "libx264", "-g", "60",
                        "-keyint_min", "60", "-sc_threshold", "0", "-an", "-frag_duration", "2000000"])
    encode(str(audio), ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "60", "-c:a", "aac",
                        "-frag_duration", "3000000"])
    RangeServer.files = {"https://yt.test/v": video.read_bytes(), "https://yt.test/a": audio.read_bytes()}
    RangeServer.requests = []
    RangeServer.ignore_range = False
    monkeypatch.setattr(module.yt_dlp, "YoutubeDL", RangeServer)
    monkeypatch.setattr(module, "guarded_public_connections", contextlib.nullcontext)
    info = {"title": "Stream", "duration": 60, "formats": [
        {"format_id": "299", "protocol": "https", "url": "https://yt.test/v", "ext": "mp4", "vcodec": "avc1.64000d",
         "acodec": "none", "width": 320, "height": 180, "filesize": len(RangeServer.files["https://yt.test/v"]),
         "downloader_options": {"http_chunk_size": 4096}},
        {"format_id": "140", "protocol": "https", "url": "https://yt.test/a", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2"},
    ]}
    return info, tmp_path


def packet_times(path, stream):
    result = subprocess.run([FFPROBE, "-v", "error", "-select_streams", stream, "-show_entries", "packet=pts_time,flags",
                             "-of", "json", path], check=True, capture_output=True)
    return [(float(p["pts_time"]), "K" in p.get("flags", "")) for p in json.loads(result.stdout)["packets"]]


def test_window_is_the_clip_stretch_on_a_full_downloads_timeline(served):
    info, tmp_path = served
    result = asyncio.run(VideoDownloaderService().download_vod_window(info, "youtube", 30.5, 35.0, str(tmp_path / "w")))
    # A normal download: yt-dlp merges the two streams with FFmpeg.
    merged = tmp_path / "merged.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-i", str(tmp_path / "v.mp4"), "-i", str(tmp_path / "a.m4a"), "-c", "copy", str(merged)], check=True)
    offset = result.timeline_offset_seconds
    window_video = [(t + offset, key) for t, key in packet_times(result.video_path, "v")]
    full_video = packet_times(str(merged), "v")
    # The 2 s video fragments around 28.5-37 s, at the same times as in the full download.
    first = min(t for t, _ in window_video)
    assert first == pytest.approx(28.0, abs=0.001)
    assert max(t for t, _ in window_video) == pytest.approx(max(t for t, _ in full_video if t < 38.0), abs=0.001)
    assert any(abs(t - first) < 0.001 and key for t, key in full_video)
    # Audio starts at one of the full download's audio packets, no later than the video.
    window_audio = [t + offset for t, _ in packet_times(result.video_path, "a")]
    full_audio = [t for t, _ in packet_times(str(merged), "a")]
    assert min(window_audio) <= first
    assert min(abs(t - min(window_audio)) for t in full_audio) < 0.001
    assert result.source_duration_seconds == 60
    assert result.metadata.title == "Stream"
    # Past each file's start (init and index), only the window's fragments
    # were fetched, in chunks no bigger than the format allows.
    ranges = [(url, int(first), int(last)) for url, r in RangeServer.requests
              for first, last in [r.removeprefix("bytes=").split("-")] if first != "0"]
    for url in RangeServer.files:
        assert 0 < sum(last - first + 1 for u, first, last in ranges if u == url) < len(RangeServer.files[url]) / 4
    assert all(last - first < 4096 for url, first, last in ranges if url.endswith("/v"))
    assert sorted(os.listdir(tmp_path / "w")) == ["window.mp4"]


def test_window_falls_back_when_a_range_is_ignored_or_formats_are_missing(served):
    info, tmp_path = served
    RangeServer.ignore_range = True
    with pytest.raises(VideoDownloadError) as error:
        asyncio.run(VideoDownloaderService().download_vod_window(info, "youtube", 30.0, 35.0, str(tmp_path / "w")))
    assert error.value.reason == "window_unavailable"
    assert os.listdir(tmp_path / "w") == []
    with pytest.raises(VideoDownloadError) as error:
        asyncio.run(VideoDownloaderService().download_vod_window({"formats": info["formats"][:1]}, "youtube", 30.0, 35.0, str(tmp_path / "w")))
    assert error.value.reason == "window_unavailable"


def test_youtube_save_space_plans_from_a_small_copy(monkeypatch, tmp_path):
    seen = {}

    async def fake_download(self, url, output_path, output_dir, max_duration_seconds=None, **options):
        seen.update(options)
        return module.DownloadResult(video_path=output_path, file_size_bytes=1, source_type="youtube", vod_info={"formats": []},
                                     metadata=module.VideoMetadata(title="t", duration_seconds=60, width=854, height=480,
                                                                   fps=30, format_id="mp4", extractor="youtube"))

    monkeypatch.setattr(VideoDownloaderService, "_download_from_youtube", fake_download)
    result = asyncio.run(VideoDownloaderService().download_video("https://www.youtube.com/watch?v=SOW3qCJJSlQ", str(tmp_path), save_space=True))
    assert seen == {"max_height": module.SAVE_SPACE_HEIGHT, "keep_info": True}
    assert result.vod_info == {"formats": []}
    seen.clear()
    asyncio.run(VideoDownloaderService().download_video("https://www.youtube.com/watch?v=SOW3qCJJSlQ", str(tmp_path)))
    assert seen == {"max_height": None, "keep_info": False}
