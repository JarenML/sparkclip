"""
Video Downloader Service - Downloads videos from YouTube, Twitch, Kick or S3.

Uses yt-dlp through guarded Python sockets for YouTube, Twitch and Kick and a pinned HTTP
client for direct URLs. Native network handlers and proxies are disabled for
caller-supplied URLs so redirects cannot reach private destinations.
"""

import asyncio
import copy
import glob
import json
import logging
import math
import os
import random
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Optional
from urllib.parse import quote, unquote, urljoin, urlparse

import boto3
import yt_dlp
from botocore.config import Config as BotocoreConfig

from clip_engine.config import get_settings
from clip_engine.error_policy import is_disk_full
from clip_engine.network_policy import guarded_public_connections, resolve_public_destination
from clip_engine.services.media_process import (guarded_ytdlp_children, run_media,
                                                validate_video_dimensions, MediaProcessError)

logger = logging.getLogger(__name__)

MAX_SOURCE_BYTES = 20 * 1000 ** 3
DOWNLOAD_DEADLINE_SECONDS = 4 * 60 * 60
# Stop a download before it leaves the disk this close to full.
MIN_FREE_BYTES = 1000 ** 3
PROBE_TIMEOUT_SECONDS = 30
MAX_PROBE_OUTPUT_BYTES = 1024 * 1024

# A trimmed Twitch or Kick job downloads only the HLS segments covering its
# window, plus this much on each side for sentence snapping and transcription.
SECTION_PAD_SECONDS = 30
MAX_PLAYLIST_BYTES = 8 * 1024 * 1024
# A clip window is final when it's downloaded, so it needs only a small margin
# (it rounds out to whole segments anyway).
WINDOW_PAD_SECONDS = 2
# Enough of a segment's start to hold its first audio and video packets.
SEGMENT_PROBE_BYTES = 1024 * 1024
# Save-space jobs transcribe and plan from this variant. On Kick, 480p and up
# carry bit-identical audio; 360p and below are more compressed.
SAVE_SPACE_HEIGHT = 480
# Playlist-wide tags that only appear before the first segment.
HLS_HEADER_TAGS = (
    "#EXTM3U", "#EXT-X-VERSION", "#EXT-X-TARGETDURATION", "#EXT-X-MEDIA-SEQUENCE",
    "#EXT-X-DISCONTINUITY-SEQUENCE", "#EXT-X-PLAYLIST-TYPE", "#EXT-X-INDEPENDENT-SEGMENTS",
    "#EXT-X-START", "#EXT-X-ALLOW-CACHE", "#EXT-X-TWITCH-", "#ID3-EQUIV-TDTG",
)
# Segments that depend on state set earlier in the playlist (keys, init
# sections, byte offsets) can't be cut out of it safely.
UNTRIMMABLE_HLS_TAGS = ("#EXT-X-KEY", "#EXT-X-SESSION-KEY", "#EXT-X-MAP", "#EXT-X-BYTERANGE", "#EXT-X-PART")


@dataclass
class HlsSection:
    """A media playlist cut down to the segments around a time window."""

    playlist: str
    # Where the kept segments start and how long they last, and the whole
    # playlist's length, in seconds on the timeline a full download produces.
    start_seconds: float
    duration_seconds: float
    total_seconds: float
    # URIs of the first kept segment and of the playlist's first segment.
    first_uri: str = ""
    zero_uri: str = ""


def trim_hls_playlist(
    text: str, start_seconds: Optional[float], end_seconds: Optional[float], pad_seconds: float = SECTION_PAD_SECONDS,
) -> Optional[HlsSection]:
    """Keep the segments of a finished VOD playlist that overlap the window, padded.

    Times are the running sum of #EXTINF durations. That is the timeline of a
    full download, which joins discontinuities without a gap, so a segment
    starts at the same second in both. Returns None when the playlist can't be
    trimmed safely or the window already covers all of it.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines or lines[0] != "#EXTM3U" or "#EXT-X-ENDLIST" not in lines:
        return None
    if any(line.startswith(UNTRIMMABLE_HLS_TAGS) for line in lines):
        return None

    header: list[str] = []
    segments: list[tuple[list[str], float]] = []
    pending: list[str] = []
    duration: Optional[float] = None
    for line in lines:
        if line == "#EXT-X-ENDLIST":
            continue
        if line.startswith("#EXTINF:"):
            try:
                duration = float(line[len("#EXTINF:"):].split(",")[0])
            except ValueError:
                return None
            if not math.isfinite(duration) or duration <= 0:
                return None
            pending.append(line)
        elif line.startswith("#"):
            if not segments and not pending and line.startswith(HLS_HEADER_TAGS):
                header.append(line)
            else:
                pending.append(line)
        else:
            if duration is None:
                return None
            segments.append((pending + [line], duration))
            pending, duration = [], None
    if not segments or duration is not None:
        return None

    low = max(0.0, (start_seconds or 0.0) - pad_seconds)
    high = math.inf if end_seconds is None else end_seconds + pad_seconds
    kept: list[int] = []
    elapsed = 0.0
    starts: list[float] = []
    for index, (_, length) in enumerate(segments):
        starts.append(elapsed)
        if elapsed + length > low and elapsed < high:
            kept.append(index)
        elapsed += length
    if not kept or len(kept) == len(segments):
        return None

    first = kept[0]
    out: list[str] = []
    for line in header:
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                line = f"#EXT-X-MEDIA-SEQUENCE:{int(line.split(':', 1)[1]) + first}"
            except ValueError:
                return None
        out.append(line)
    for index in kept:
        out.extend(segments[index][0])
    out.append("#EXT-X-ENDLIST")
    last = kept[-1]
    return HlsSection(
        playlist="\n".join(out) + "\n",
        start_seconds=round(starts[first], 3),
        duration_seconds=round(starts[last] + segments[last][1] - starts[first], 3),
        total_seconds=round(elapsed, 3),
        first_uri=segments[first][0][-1],
        zero_uri=segments[0][0][-1],
    )


class SectionYoutubeDL(yt_dlp.YoutubeDL):
    """Hands yt-dlp's native HLS downloader a playlist trimmed to a time window.

    yt-dlp's own download_ranges switches to FFmpeg, which opens its own
    connections and would bypass the socket guard; this keeps every request
    on the guarded Python network stack. Anything that can't be trimmed is
    downloaded in full, as before, unless `require_trim` is set.
    """

    def __init__(
        self, params: dict, section: tuple[Optional[float], Optional[float]],
        pad_seconds: float = SECTION_PAD_SECONDS, require_trim: bool = False,
    ):
        super().__init__(params)
        self.section = section
        self.pad_seconds = pad_seconds
        self.require_trim = require_trim
        self.trimmed: Optional[HlsSection] = None

    def dl(self, name, info, subtitle=False, test=False):
        if not subtitle and not test and info.get("protocol") in ("m3u8", "m3u8_native") \
                and not info.get("hls_media_playlist_data"):
            trimmed = self._trim(info)
            if trimmed:
                info = {**info, "hls_media_playlist_data": trimmed.playlist}
                self.trimmed = trimmed
        if self.require_trim and not self.trimmed:
            raise VideoDownloadError("VOD window unavailable", reason="window_unavailable")
        return super().dl(name, info, subtitle, test)

    def _read(self, url: str, info: dict, limit: int) -> bytes:
        request = yt_dlp.networking.Request(url, headers=info.get("http_headers") or {})
        with self.urlopen(request) as response:
            return response.read(limit)

    def _trim(self, info: dict) -> Optional[HlsSection]:
        try:
            body = self._read(info["url"], info, MAX_PLAYLIST_BYTES + 1)
            if len(body) > MAX_PLAYLIST_BYTES:
                return None
            trimmed = trim_hls_playlist(body.decode("utf-8", "replace"), *self.section, pad_seconds=self.pad_seconds)
        except Exception as error:
            logger.warning("Could not trim the VOD playlist (%s)", type(error).__name__)
            return None
        if not trimmed:
            logger.info("The VOD playlist can't be trimmed to the selected range")
            return None
        # A file's time zero is its earliest audio or video packet, and video
        # can start a few ms after audio. Measure that lead in the first kept
        # segment and in the playlist's first one (a full download's zero) so
        # the offset is exact rather than off by up to a couple of frames.
        first = self._video_lead(urljoin(info["url"], trimmed.first_uri), info)
        zero = first if trimmed.zero_uri == trimmed.first_uri else \
            self._video_lead(urljoin(info["url"], trimmed.zero_uri), info)
        if first is not None and zero is not None:
            trimmed.start_seconds = round(trimmed.start_seconds - first + zero, 3)
        logger.info(
            "Downloading %.0fs of the %.0fs VOD, from %.3fs",
            trimmed.duration_seconds, trimmed.total_seconds, trimmed.start_seconds,
        )
        return trimmed

    def _video_lead(self, url: str, info: dict) -> Optional[float]:
        """Seconds a segment's video starts after its earliest audio or video packet."""
        try:
            data = self._read(url, info, SEGMENT_PROBE_BYTES)
            with tempfile.TemporaryDirectory(prefix="clip-probe-") as directory:
                path = os.path.join(directory, "segment.ts")
                with open(path, "wb") as handle:
                    handle.write(data)
                result = run_media(
                    ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json", path],
                    timeout=PROBE_TIMEOUT_SECONDS, max_output=MAX_PROBE_OUTPUT_BYTES, check=True,
                )
            starts: dict[str, float] = {}
            for stream in json.loads(result.stdout).get("streams", []):
                kind, value = stream.get("codec_type"), stream.get("start_time")
                if kind in ("audio", "video") and kind not in starts and value not in (None, "N/A"):
                    starts[kind] = float(value)
            if "video" not in starts:
                return None
            lead = starts["video"] - min(starts.values())
            return lead if 0 <= lead < 1 else None
        except Exception as error:
            logger.debug("Could not measure a segment's start (%s)", type(error).__name__)
            return None

# YouTube format selection. Filters only exclude AV1, which the bundled FFmpeg
# cannot decode in software; the sort picks the best remaining stream.
# H.264 tops out at 1080p on YouTube, so 1440p/2160p arrives as VP9.
#
# Vertical clips crop a 9:16 window from 16:9 sources: a 1080p source gives a
# ~608px-wide crop upscaled to 1080x1920, while 2160p gives ~1215px. "res"
# measures the shorter side, so 2160 covers both landscape 4K and vertical
# 2160x3840. SDR is preferred because renders are SDR H.264 without tone mapping.
YOUTUBE_FORMAT_SORT = ["hdr:SDR", "res:2160", "fps"]
YOUTUBE_FORMAT_SELECTORS = [
    # Best separate video + audio streams (the only way to get >720p).
    "bv*[vcodec!^=av01]+ba/b[vcodec!^=av01]",
    # If VP9/Opus fails to merge or convert, retry with H.264 + AAC (native to
    # mp4, up to 1080p), then any non-AV1 stream that already includes audio.
    "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec!^=av01]",
]


TWITCH_HOSTS = {"twitch.tv", "www.twitch.tv", "m.twitch.tv", "go.twitch.tv"}


def twitch_vod_url(url: str) -> Optional[str]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host.rstrip(".") != "twitch.tv" and not host.rstrip(".").endswith(".twitch.tv"):
        return None
    match = re.fullmatch(r"/videos/([0-9]+)/?", parsed.path)
    try:
        valid_port = parsed.port in {None, 443 if parsed.scheme == "https" else 80}
    except ValueError:
        valid_port = False
    if (host not in TWITCH_HOSTS or not match or parsed.scheme not in {"http", "https"}
            or parsed.username or parsed.password or not valid_port):
        raise VideoDownloadError("Unsupported Twitch source", reason="twitch_unsupported")
    return f"https://www.twitch.tv/videos/{match[1]}"


KICK_HOSTS = {"kick.com", "www.kick.com"}
KICK_VOD_PATH = re.compile(r"/([A-Za-z0-9_-]+)/videos/([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})/?")


def kick_vod_url(url: str) -> Optional[str]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host.rstrip(".") != "kick.com" and not host.rstrip(".").endswith(".kick.com"):
        return None
    match = KICK_VOD_PATH.fullmatch(parsed.path)
    try:
        valid_port = parsed.port in {None, 443 if parsed.scheme == "https" else 80}
    except ValueError:
        valid_port = False
    if (host not in KICK_HOSTS or not match or parsed.scheme not in {"http", "https"}
            or parsed.username or parsed.password or not valid_port):
        raise VideoDownloadError("Unsupported Kick source", reason="kick_unsupported")
    return f"https://kick.com/{match[1].lower()}/videos/{match[2].lower()}"


KICK_API_HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
MAX_KICK_LISTING_BYTES = 4 * 1024 * 1024
KICK_START_TOLERANCE_MS = 5000
UUID_PATTERN = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")


def uuidv7_millis(value: str) -> Optional[int]:
    """Milliseconds since the epoch encoded in a UUIDv7, or None for other versions."""
    if not UUID_PATTERN.fullmatch(value) or value[14] != "7":
        return None
    return int(value.replace("-", "")[:12], 16)


def kick_start_millis(value) -> Optional[int]:
    """Kick's "2026-09-23 03:31:33" start_time is UTC."""
    if not isinstance(value, str):
        return None
    try:
        start = datetime.strptime(value.strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return int(start.timestamp() * 1000)


def find_kick_vod_by_start(vods, start_ms: int) -> Optional[dict]:
    """The listed VOD whose start_time matches the UUIDv7 timestamp."""
    best, best_delta = None, KICK_START_TOLERANCE_MS + 1
    for vod in vods if isinstance(vods, list) else []:
        start = kick_start_millis(vod.get("start_time")) if isinstance(vod, dict) else None
        if start is not None and abs(start - start_ms) < best_delta:
            best, best_delta = vod, abs(start - start_ms)
    return best


# Saved-broadcast platforms downloaded with a single yt-dlp extractor:
# platform -> (canonical URL function, extractor, display name).
VOD_PLATFORMS = {
    "twitch": (twitch_vod_url, "twitch:vod", "Twitch"),
    "kick": (kick_vod_url, "kick:vod", "Kick"),
}


def vod_platform(url: str) -> tuple[Optional[str], Optional[str]]:
    """(platform, canonical VOD URL) for a supported VOD link, else (None, None).

    Raises VideoDownloadError for other pages on a supported platform's domain.
    """
    for platform, (canonical, _, _) in VOD_PLATFORMS.items():
        vod_url = canonical(url)
        if vod_url:
            return platform, vod_url
    return None, None


def finite_number(value, default=0):
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError, OverflowError):
        return default


# User-Agent rotation list for avoiding detection
UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:89.0) Gecko/20100101 Firefox/89.0",
]


# Source types for videos
VideoSourceType = Literal["youtube", "twitch", "kick", "s3", "direct_url", "local"]


@dataclass
class VideoMetadata:
    """Metadata extracted from downloaded video."""
    
    title: str
    duration_seconds: float
    width: int
    height: int
    fps: float
    format_id: str
    extractor: str
    uploader: Optional[str] = None
    upload_date: Optional[str] = None
    description: Optional[str] = None
    thumbnail_url: Optional[str] = None
    source_type: VideoSourceType = "youtube"


@dataclass
class DownloadResult:
    """Result of video download operation."""
    
    video_path: str
    metadata: VideoMetadata
    file_size_bytes: int
    source_type: VideoSourceType
    # Set when only part of a VOD was downloaded: where the file starts on the
    # full VOD's timeline, and the full VOD's length (metadata has the file's).
    timeline_offset_seconds: float = 0.0
    source_duration_seconds: Optional[float] = None
    # yt-dlp's info for a VOD downloaded with keep_info, for download_vod_window.
    vod_info: Optional[dict] = None


class VideoDownloaderService:
    """
    Service for downloading videos from various sources.
    
    Supported sources:
    - YouTube URLs (via yt-dlp)
    - S3 URLs or keys (via boto3)
    - Direct video URLs (via httpx)
    
    Features:
    - Downloads video in best available quality up to 2160p
    - Extracts metadata (title, duration, dimensions)
    - Handles various URL formats
    - Configurable via environment variables
    """

    def __init__(self):
        self.settings = get_settings()
        self._s3_client: Optional[boto3.client] = None

        # Log yt-dlp version for diagnostics.
        try:
            logger.info(f"VideoDownloaderService initialized with yt-dlp {yt_dlp.version.__version__}")
        except Exception:
            logger.info("VideoDownloaderService initialized with yt-dlp library")

        logger.info("Guarded Python HTTP handler enabled for YouTube")

        logger.info("YouTube proxy and native networking disabled for destination checks")

    def _get_format_selector(self) -> str:
        """
        Returns the primary format selector: the highest-resolution non-AV1
        stream (up to 2160p, per YOUTUBE_FORMAT_SORT) merged with the best audio.

        IMPORTANT: Excludes AV1 codec (vcodec=av01) because the bundled FFmpeg
        has no software AV1 decoder. H.264 (avc1) and VP9 decode everywhere.
        """
        return YOUTUBE_FORMAT_SELECTORS[0]

    def _build_ytdlp_opts(
        self,
        output_path: Optional[str] = None,
        download: bool = True,
    ) -> dict:
        """
        Build yt-dlp options dictionary for downloading.

        Uses the guarded Python network stack.

        Args:
            output_path: Optional output file path
            download: Whether these options are for downloading (vs just info extraction)

        Returns:
            Dictionary of yt-dlp options
        """
        # Native handlers and proxies can fetch a private redirect without
        # passing through the socket guard. An empty proxy disables yt-dlp's
        # inherited proxy configuration as well.
        opts = {"proxy": "", "external_downloader": "native", "hls_prefer_native": True}

        # Add our custom options - keep it simple to avoid format issues
        opts.update({
            "format": self._get_format_selector(),
            "format_sort": YOUTUBE_FORMAT_SORT,
            "quiet": True,
            "noprogress": True,  # quiet alone still prints [download] bars to stdout
            "no_warnings": True,
            "noplaylist": True,
            "socket_timeout": 30,
            "http_headers": {
                "User-Agent": random.choice(UA_LIST),
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            "nocheckcertificate": False,
            "geo_bypass": True,
        })

        if output_path:
            opts["outtmpl"] = output_path

        if download:
            opts["merge_output_format"] = "mp4"
            opts["postprocessors"] = [
                {
                    'key': 'FFmpegVideoConvertor',
                    'preferedformat': 'mp4',
                }
            ]
            opts["retries"] = 10
            opts["fragment_retries"] = 10
            opts["force_overwrites"] = True
            opts["max_filesize"] = MAX_SOURCE_BYTES

        return opts

    @property
    def s3_client(self) -> boto3.client:
        """Lazy-initialize S3 client."""
        if self._s3_client is None:
            config = {
                "region_name": self.settings.aws_region,
                "config": BotocoreConfig(
                    retries={"max_attempts": 10, "mode": "adaptive"},
                    max_pool_connections=self.settings.s3_max_pool_connections,
                    connect_timeout=self.settings.s3_connect_timeout_seconds,
                    read_timeout=self.settings.s3_read_timeout_seconds,
                ),
            }
            if self.settings.aws_access_key_id and self.settings.aws_secret_access_key:
                config["aws_access_key_id"] = self.settings.aws_access_key_id
                config["aws_secret_access_key"] = self.settings.aws_secret_access_key
            
            self._s3_client = boto3.client("s3", **config)
        
        return self._s3_client

    def detect_source_type(self, url_or_key: str) -> VideoSourceType:
        """
        Detect the source type from URL or key.
        
        Args:
            url_or_key: URL or S3 key
            
        Returns:
            VideoSourceType
        """
        # Local file (desktop app). Only honoured in LOCAL_MODE so the server
        # API can't be pointed at arbitrary files on the host.
        if self.settings.local_mode and (
            url_or_key.startswith("file://") or os.path.isfile(url_or_key)
        ):
            return "local"

        # S3 key (no protocol)
        if not url_or_key.startswith("http"):
            return "s3"
        
        parsed = urlparse(url_or_key)
        
        platform, _ = vod_platform(url_or_key)
        if platform:
            return platform

        # S3 URL formats
        if parsed.hostname and (
            ".s3." in parsed.hostname or
            parsed.hostname.endswith(".amazonaws.com") or
            parsed.hostname == "s3.amazonaws.com"
        ):
            return "s3"
        
        # YouTube URLs
        host = (parsed.hostname or "").lower()
        if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"}:
            return "youtube"
        
        # Direct video URL
        return "direct_url"

    async def download_video(
        self,
        url: str,
        output_dir: str,
        output_filename: str = "source.mp4",
        max_duration_seconds: Optional[int] = None,
        s3_bucket: Optional[str] = None,
        section: Optional[tuple[Optional[float], Optional[float]]] = None,
        save_space: bool = False,
    ) -> DownloadResult:
        """
        Download a video from various sources.

        Args:
            url: Video URL (YouTube, S3, direct) or S3 key
            output_dir: Directory to save the video
            output_filename: Output filename (default: source.mp4)
            max_duration_seconds: Maximum duration to download
            s3_bucket: S3 bucket (required if url is an S3 key)
            section: Optional (start, end) seconds the job will use. Twitch and
                Kick VODs then download only that part (see SectionYoutubeDL);
                the result's timeline_offset_seconds says where it starts.
            save_space: For a Twitch or Kick VOD, download a small copy for
                transcription and planning (SAVE_SPACE_HEIGHT, whose audio
                matches full quality) and keep its info in vod_info, so each
                clip's window can then come from download_vod_window.
            
        Returns:
            DownloadResult with path and metadata
            
        Raises:
            VideoDownloadError: If download fails
        """
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, output_filename)
        
        source_type = self.detect_source_type(url)
        logger.info("Detected source type: %s", source_type)

        try:
            if source_type == "local":
                result = await self._use_local_file(url)
            elif source_type == "s3":
                result = await self._download_from_s3(url, output_path, s3_bucket)
            elif source_type in VOD_PLATFORMS:
                vod_url = vod_platform(url)[1]
                if source_type == "kick":
                    vod_url = await self._resolve_kick_vod(vod_url)
                result = await self._download_from_youtube(
                    vod_url, output_path, output_dir, max_duration_seconds, source_type=source_type, section=section,
                    max_height=SAVE_SPACE_HEIGHT if save_space else None, keep_info=save_space,
                )
            elif source_type == "youtube":
                result = await self._download_from_youtube(url, output_path, output_dir, max_duration_seconds)
            else:
                result = await self._download_direct_url(url, output_path)

            duration_limit = min(
                max_duration_seconds or self.settings.max_download_duration_seconds,
                self.settings.max_download_duration_seconds,
            )
            if not 0 < result.metadata.duration_seconds <= duration_limit:
                raise VideoDownloadError("Video duration is invalid or exceeds the allowed limit")
            return result
        except Exception:
            if source_type != "local":
                self._remove_partial_files(output_path)
            raise

    @staticmethod
    def _check_source_size(size: int) -> None:
        if size > MAX_SOURCE_BYTES:
            raise VideoDownloadError("Video exceeds the 20 GB source limit")

    @staticmethod
    def _check_free_space(directory: str, remaining_bytes: int) -> None:
        """Fail early, and say why, rather than filling the disk mid-download."""
        if shutil.disk_usage(directory).free - max(remaining_bytes, 0) < MIN_FREE_BYTES:
            raise VideoDownloadError("No space left on device for this video")

    @staticmethod
    def _download_paths(output_path: str) -> list[str]:
        source_prefix = os.path.splitext(output_path)[0]
        return [
            path for path in glob.glob(glob.escape(source_prefix) + "*")
            if os.path.isfile(path) and (
                path == output_path or path.startswith(output_path + ".")
                or path.startswith(source_prefix + ".f")
            )
        ]

    @classmethod
    def _remove_partial_files(cls, output_path: str) -> None:
        for path in cls._download_paths(output_path):
            os.remove(path)

    async def _download_from_youtube(
        self,
        url: str,
        output_path: str,
        output_dir: str,
        max_duration_seconds: Optional[int] = None,
        source_type: VideoSourceType = "youtube",
        section: Optional[tuple[Optional[float], Optional[float]]] = None,
        max_height: Optional[int] = None,
        keep_info: bool = False,
        info: Optional[dict] = None,
        pad_seconds: float = SECTION_PAD_SECONDS,
        require_trim: bool = False,
    ) -> DownloadResult:
        """
        Download video from YouTube, Twitch or Kick using yt-dlp Python library.

        Downloads through guarded Python sockets:
        - Uses flexible format selectors that work reliably
        - Picks the highest-resolution non-AV1 stream (up to 2160p)

        VODs can also be capped at `max_height`, return their yt-dlp info for
        reuse (`keep_info`), or be downloaded again from that `info` without
        asking the platform's API (clip windows; see download_vod_window).
        """
        deadline = time.monotonic() + DOWNLOAD_DEADLINE_SECONDS
        # First, get video metadata to check duration.
        if info is not None:
            metadata = self._metadata_from_info(info, source_type)
        else:
            metadata = await asyncio.wait_for(
                self._get_video_info(url, deadline=deadline), timeout=DOWNLOAD_DEADLINE_SECONDS
            )

        max_duration = min(max_duration_seconds or self.settings.max_download_duration_seconds, self.settings.max_download_duration_seconds)
        if metadata.duration_seconds > max_duration:
            raise VideoDownloadError(
                f"Video duration ({metadata.duration_seconds}s) exceeds maximum "
                f"allowed duration ({max_duration}s)"
            )

        logger.info("Downloading video from %s", source_type)
        def check_progress(progress: dict) -> None:
            if time.monotonic() > deadline:
                raise VideoDownloadError("Video download deadline exceeded")
            self._check_source_size(int(progress.get("downloaded_bytes") or 0))
            total_bytes = int(progress.get("total_bytes") or progress.get("total_bytes_estimate") or 0)
            self._check_source_size(total_bytes)
            self._check_free_space(
                output_dir, total_bytes - int(progress.get("downloaded_bytes") or 0)
            )
            # yt-dlp downloads video and audio separately, so each stream can
            # be smaller than the limit while their combined files exceed it.
            stored_bytes = sum(
                os.path.getsize(path)
                for path in self._download_paths(output_path)
            )
            self._check_source_size(stored_bytes)

        # Highest available quality first; see YOUTUBE_FORMAT_SELECTORS.
        # CRITICAL: All selectors MUST exclude AV1 (the bundled FFmpeg can't decode it).
        format_selectors = ["b[vcodec!^=av01]"] if source_type in VOD_PLATFORMS else YOUTUBE_FORMAT_SELECTORS
        if max_height and source_type in VOD_PLATFORMS:
            # Falls back to the best stream if no variant is that small.
            format_selectors = [f"b[height<={max_height}][vcodec!^=av01]", *format_selectors]

        # Run download in thread pool to not block event loop
        loop = asyncio.get_event_loop()
        if source_type not in VOD_PLATFORMS or not section or section == (None, None):
            section = None
        trimmed: Optional[HlsSection] = None
        kept_info: Optional[dict] = None

        def do_download() -> None:
            """Try compatible formats through the guarded Python network stack."""
            nonlocal trimmed, kept_info
            logger.info("Attempting video download")

            last_error = None

            for fmt_idx, format_selector in enumerate(format_selectors):
                try:
                    logger.info(f"Format attempt {fmt_idx + 1}/{len(format_selectors)}: {format_selector[:50]}...")

                    ydl_opts = self._build_ytdlp_opts(
                        output_path=output_path,
                        download=True,
                    )
                    if source_type in VOD_PLATFORMS:
                        ydl_opts["allowed_extractors"] = [VOD_PLATFORMS[source_type][1]]
                        ydl_opts["skip_unavailable_fragments"] = False
                        ydl_opts["match_filter"] = lambda info, *, incomplete=False: self._validate_vod_info(info, max_duration, incomplete, platform=source_type)
                    ydl_opts["format"] = format_selector
                    ydl_opts["progress_hooks"] = [check_progress]
                    ydl_opts["postprocessor_hooks"] = [check_progress]

                    if time.monotonic() > deadline:
                        raise VideoDownloadError("Video download deadline exceeded")

                    trimmed = None
                    with guarded_ytdlp_children(deadline), guarded_public_connections():
                        with (
                            SectionYoutubeDL(ydl_opts, section, pad_seconds=pad_seconds, require_trim=require_trim)
                            if section else yt_dlp.YoutubeDL(ydl_opts)
                        ) as ydl:
                            if info is not None:
                                # yt-dlp's own --load-info-json path: no new extraction.
                                ydl.process_ie_result(ydl.sanitize_info(copy.deepcopy(info)), download=True)
                            elif keep_info:
                                kept_info = ydl.sanitize_info(ydl.extract_info(url, download=True))
                            else:
                                ydl.download([url])
                            trimmed = getattr(ydl, "trimmed", None)

                    # If we get here, download succeeded
                    logger.info("Video download succeeded")
                    return

                except VideoDownloadError:
                    raise
                except Exception as e:
                    # yt-dlp can wrap an error raised inside a download.
                    cause = (getattr(e, "exc_info", None) or (None, None))[1]
                    if isinstance(cause, VideoDownloadError):
                        raise cause from None
                    last_error = e
                    error_str = str(e)

                    # A full disk affects every format selector.
                    if is_disk_full(e):
                        raise

                    # Bot detection will affect every format selector.
                    if "Sign in to confirm" in error_str or "bot" in error_str.lower():
                        logger.warning("Bot detection triggered")
                        raise

                    # Check if it's a format issue - try next selector
                    if "Requested format" in error_str or "No video formats" in error_str:
                        logger.warning("Format not available, trying next")
                        continue

                    # Network and HTTP failures affect every format selector.
                    lowered = error_str.lower()
                    if any(m in lowered for m in ("unable to download", "http error", "timed out", "connection")):
                        logger.warning("Format attempt %d failed at the network level", fmt_idx + 1)
                        raise

                    # For other errors (e.g. merge/conversion), try the next format
                    logger.warning("Format attempt %d failed", fmt_idx + 1)
                    continue

            # All format attempts failed.
            raise last_error or VideoDownloadError("All format attempts failed")

        try:
            await loop.run_in_executor(None, do_download)
        except Exception as e:
            self._remove_partial_files(output_path)
            if isinstance(e, VideoDownloadError):
                raise
            if source_type in VOD_PLATFORMS and not is_disk_full(e):
                name = VOD_PLATFORMS[source_type][2]
                raise VideoDownloadError(f"{name} VOD download failed", reason=f"{source_type}_unavailable") from e
            raise VideoDownloadError(f"Failed to download video: {e}") from e

        # Verify output exists
        if not os.path.isfile(output_path):
            # yt-dlp might have added extension
            possible_paths = [
                output_path,
                f"{output_path}.mp4",
                f"{output_path}.webm",
                f"{output_path}.mkv",
            ]
            for path in possible_paths:
                if os.path.isfile(path):
                    if path != output_path:
                        os.rename(path, output_path)
                    break
            else:
                raise VideoDownloadError(f"Download completed but output file not found: {output_path}")

        file_size = os.path.getsize(output_path)
        try:
            self._check_source_size(file_size)
        except VideoDownloadError:
            self._remove_partial_files(output_path)
            raise
        logger.info(f"Video downloaded: {output_path} ({file_size / 1024 / 1024:.1f} MB)")

        # CRITICAL: Get ACTUAL video metadata using ffprobe after download
        # This ensures we have the real dimensions of the downloaded file,
        # not the pre-download estimates from yt-dlp info
        actual_metadata = await self._get_video_metadata_ffprobe(output_path)
        if time.monotonic() > deadline:
            self._remove_partial_files(output_path)
            raise VideoDownloadError("Video download deadline exceeded")

        # Log the actual downloaded resolution for debugging
        logger.info(
            f"Downloaded video quality: {actual_metadata.width}x{actual_metadata.height} "
            f"@ {actual_metadata.fps}fps ({file_size / 1024 / 1024:.1f} MB)"
        )
        
        # Warn if we got low quality (less than 720p)
        if actual_metadata.height < 720:
            logger.warning(
                f"WARNING: Downloaded video is only {actual_metadata.height}p! "
                "Expected 720p or higher"
            )

        # Preserve useful info from yt-dlp metadata (title, uploader, etc.)
        # but use actual dimensions from ffprobe
        actual_metadata.title = metadata.title
        actual_metadata.uploader = metadata.uploader
        actual_metadata.upload_date = metadata.upload_date
        actual_metadata.description = metadata.description
        actual_metadata.thumbnail_url = metadata.thumbnail_url
        actual_metadata.source_type = source_type

        logger.info(f"Actual video dimensions: {actual_metadata.width}x{actual_metadata.height} @ {actual_metadata.fps}fps")

        return DownloadResult(
            video_path=output_path,
            metadata=actual_metadata,
            file_size_bytes=file_size,
            source_type=source_type,
            timeline_offset_seconds=trimmed.start_seconds if trimmed else 0.0,
            source_duration_seconds=trimmed.total_seconds if trimmed else None,
            vod_info=kept_info,
        )

    async def download_vod_window(
        self, info: dict, source_type: VideoSourceType, start_seconds: float, end_seconds: float,
        output_dir: str, output_filename: str = "window.mp4",
    ) -> DownloadResult:
        """Download one clip's stretch of a VOD at full quality.

        `info` is the yt-dlp info kept from the job's first download, so no
        platform API is asked again. Raises VideoDownloadError with reason
        "window_unavailable" if the playlist can't be cut to the window; the
        caller then falls back to the whole video.
        """
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, output_filename)
        try:
            return await self._download_from_youtube(
                info.get("webpage_url") or "", output_path, output_dir, source_type=source_type,
                section=(start_seconds, end_seconds), info=info,
                pad_seconds=WINDOW_PAD_SECONDS, require_trim=True,
            )
        except Exception:
            self._remove_partial_files(output_path)
            raise

    async def _download_from_s3(
        self,
        url_or_key: str,
        output_path: str,
        s3_bucket: Optional[str] = None,
    ) -> DownloadResult:
        """Download video from S3."""
        # Parse S3 URL or use key directly
        bucket, key = self._parse_s3_url(url_or_key, s3_bucket)
        
        logger.info("Downloading video from S3")
        
        # Download file
        loop = asyncio.get_event_loop()
        deadline = time.monotonic() + DOWNLOAD_DEADLINE_SECONDS
        downloaded = 0
        progress_lock = threading.Lock()

        def check_progress(chunk_size: int) -> None:
            nonlocal downloaded
            with progress_lock:
                downloaded += chunk_size
                self._check_source_size(downloaded)
            if time.monotonic() > deadline:
                raise VideoDownloadError("Video download deadline exceeded")

        try:
            size = (await loop.run_in_executor(
                None, lambda: self.s3_client.head_object(Bucket=bucket, Key=key)
            )).get("ContentLength")
            if size is not None:
                self._check_source_size(int(size))
            await loop.run_in_executor(
                None,
                lambda: self.s3_client.download_file(bucket, key, output_path, Callback=check_progress),
            )
        except Exception as e:
            self._remove_partial_files(output_path)
            raise VideoDownloadError("Failed to download video from S3") from e
        
        if not os.path.isfile(output_path):
            raise VideoDownloadError(f"S3 download completed but file not found: {output_path}")
        
        file_size = os.path.getsize(output_path)
        self._check_source_size(file_size)
        logger.info(f"S3 video downloaded: {output_path} ({file_size / 1024 / 1024:.1f} MB)")
        
        # Get video metadata using ffprobe
        metadata = await self._get_video_metadata_ffprobe(output_path)
        metadata.source_type = "s3"
        
        return DownloadResult(
            video_path=output_path,
            metadata=metadata,
            file_size_bytes=file_size,
            source_type="s3",
        )

    def _parse_s3_url(
        self,
        url_or_key: str,
        default_bucket: Optional[str] = None,
    ) -> tuple[str, str]:
        """
        Parse S3 URL or key into bucket and key.
        
        Supports formats:
        - s3://bucket/key
        - https://bucket.s3.region.amazonaws.com/key
        - https://s3.region.amazonaws.com/bucket/key
        - just-a-key (uses default bucket)
        """
        # Plain key
        if not url_or_key.startswith("http") and not url_or_key.startswith("s3://"):
            bucket = default_bucket or self.settings.s3_bucket
            return bucket, url_or_key
        
        # s3:// URL
        if url_or_key.startswith("s3://"):
            parts = url_or_key[5:].split("/", 1)
            if len(parts) != 2:
                raise VideoDownloadError(f"Invalid S3 URL: {url_or_key}")
            return parts[0], parts[1]
        
        # HTTP(S) URL
        parsed = urlparse(url_or_key)
        
        # Virtual-hosted style: bucket.s3.region.amazonaws.com/key
        if parsed.hostname and ".s3." in parsed.hostname:
            bucket = parsed.hostname.split(".s3.")[0]
            key = parsed.path.lstrip("/")
            return bucket, key
        
        # Path style: s3.region.amazonaws.com/bucket/key
        if parsed.hostname and parsed.hostname.startswith("s3."):
            path_parts = parsed.path.lstrip("/").split("/", 1)
            if len(path_parts) != 2:
                raise VideoDownloadError(f"Invalid S3 URL: {url_or_key}")
            return path_parts[0], path_parts[1]
        
        raise VideoDownloadError(f"Unable to parse S3 URL: {url_or_key}")

    async def _download_direct_url(
        self,
        url: str,
        output_path: str,
    ) -> DownloadResult:
        """Download video from a direct URL using httpx."""
        import httpx
        
        logger.info("Downloading video from direct URL")
        deadline = time.monotonic() + DOWNLOAD_DEADLINE_SECONDS
        try:
            return await self._stream_direct_url(url, output_path, deadline)
        except Exception:
            self._remove_partial_files(output_path)
            raise

    async def _stream_direct_url(self, url: str, output_path: str, deadline: float) -> DownloadResult:
        import httpx

        async with httpx.AsyncClient(timeout=300, follow_redirects=False, trust_env=False,
                                     limits=httpx.Limits(max_keepalive_connections=0)) as client:
            current_url = url
            for redirect_count in range(6):
                try:
                    destination = await asyncio.to_thread(resolve_public_destination, current_url)
                except ValueError as exc:
                    raise VideoDownloadError("Video destination is not public") from exc

                async with client.stream(
                    "GET", destination.url,
                    headers={"Host": destination.host_header},
                    extensions={"sni_hostname": destination.hostname},
                ) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location")
                        if not location or redirect_count == 5:
                            raise VideoDownloadError("Video redirect could not be followed")
                        current_url = urljoin(current_url, location)
                        continue
                    response.raise_for_status()

                    content_length = response.headers.get("content-length")
                    if content_length:
                        try:
                            self._check_source_size(int(content_length))
                        except ValueError as exc:
                            raise VideoDownloadError("Invalid source size") from exc

                    with open(output_path, "wb") as f:
                        downloaded = 0
                        async for chunk in response.aiter_bytes():
                            downloaded += len(chunk)
                            self._check_source_size(downloaded)
                            if time.monotonic() > deadline:
                                raise VideoDownloadError("Video download deadline exceeded")
                            f.write(chunk)
                    break
        
        if not os.path.isfile(output_path):
            raise VideoDownloadError(f"Direct download completed but file not found: {output_path}")
        
        file_size = os.path.getsize(output_path)
        self._check_source_size(file_size)
        logger.info(f"Video downloaded: {output_path} ({file_size / 1024 / 1024:.1f} MB)")
        
        # Get video metadata using ffprobe
        metadata = await self._get_video_metadata_ffprobe(output_path)
        metadata.source_type = "direct_url"
        
        return DownloadResult(
            video_path=output_path,
            metadata=metadata,
            file_size_bytes=file_size,
            source_type="direct_url",
        )

    async def _use_local_file(self, path_or_url: str) -> DownloadResult:
        """Use a local video in place (no copy; sources can be many GB)."""
        path = unquote(urlparse(path_or_url).path) if path_or_url.startswith("file://") else path_or_url
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise VideoDownloadError(f"Local video not found: {path}")
        self._check_source_size(os.path.getsize(path))

        metadata = await self._get_video_metadata_ffprobe(path)
        metadata.source_type = "local"
        metadata.title = os.path.splitext(os.path.basename(path))[0]
        logger.info("Using local video (%.1fs)", metadata.duration_seconds)

        return DownloadResult(
            video_path=path,
            metadata=metadata,
            file_size_bytes=os.path.getsize(path),
            source_type="local",
        )

    def _run_ffprobe_sync(self, video_path: str) -> tuple[int, bytes, bytes]:
        """Run ffprobe synchronously (for use with run_in_executor on Windows)."""
        cmd = [
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_entries", "format=duration,filename,format_name:stream=codec_type,width,height,r_frame_rate",
            "-show_format",
            "-show_streams",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts",
            video_path,
        ]

        try:
            result = run_media(cmd, timeout=PROBE_TIMEOUT_SECONDS, max_output=MAX_PROBE_OUTPUT_BYTES)
            if result.returncode != 0:
                raise VideoDownloadError("Video metadata probe failed")
            return result.returncode, result.stdout, result.stderr
        except MediaProcessError:
            raise VideoDownloadError("Video metadata probe failed") from None

    async def _get_video_metadata_ffprobe(self, video_path: str) -> VideoMetadata:
        """Get video metadata using ffprobe."""
        # Use run_in_executor for Windows compatibility
        # asyncio.create_subprocess_exec doesn't work on Windows without ProactorEventLoop
        loop = asyncio.get_event_loop()
        returncode, stdout, stderr = await loop.run_in_executor(
            None, self._run_ffprobe_sync, video_path
        )
        
        if returncode != 0 or len(stdout) > MAX_PROBE_OUTPUT_BYTES:
            raise VideoDownloadError("Video metadata probe failed")
        
        try:
            info = json.loads(stdout.decode())
            
            # Find video stream
            video_stream = None
            for stream in info.get("streams", []):
                if stream.get("codec_type") == "video":
                    video_stream = stream
                    break
            
            format_info = info.get("format", {})
            
            if not video_stream:
                raise VideoDownloadError("Source has no video stream")
            duration = float(format_info.get("duration", 0))
            width = int(video_stream.get("width", 0))
            height = int(video_stream.get("height", 0))
            if not math.isfinite(duration) or duration <= 0 or width <= 0 or height <= 0:
                raise VideoDownloadError("Invalid video metadata")

            validate_video_dimensions(width, height)

            # Extract FPS from r_frame_rate (e.g., "30/1" -> 30.0)
            fps = 30.0
            if "r_frame_rate" in video_stream:
                fps_str = video_stream["r_frame_rate"]
                if "/" in fps_str:
                    num, den = fps_str.split("/")
                    fps = float(num) / float(den) if float(den) != 0 else 30.0
                else:
                    fps = float(fps_str)
            
            return VideoMetadata(
                title=format_info.get("filename", os.path.basename(video_path)),
                duration_seconds=duration,
                width=width,
                height=height,
                fps=fps,
                format_id=format_info.get("format_name", "mp4"),
                extractor="file",
            )
        except (json.JSONDecodeError, KeyError, TypeError, ValueError, OverflowError) as e:
            raise VideoDownloadError("Invalid video metadata") from e

    async def _resolve_kick_vod(self, url: str) -> str:
        """Map a current Kick link to the video uuid yt-dlp's kick:vod understands.

        Links on kick.com now carry a UUIDv7 whose 48-bit prefix is the VOD's
        start time; the API behind kick:vod only knows the older video uuid.
        List the channel's recent VODs, pick the one that started at that
        moment, and use its video uuid. Older links pass through unchanged.
        """
        match = KICK_VOD_PATH.fullmatch(urlparse(url).path)
        channel, vod_id = match[1], match[2]
        start_ms = uuidv7_millis(vod_id)
        if start_ms is None:
            return url

        def fetch_listing():
            request = urllib.request.Request(
                f"https://kick.com/api/v2/channels/{quote(channel, safe='')}/videos", headers=KICK_API_HEADERS
            )
            with guarded_public_connections():
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = response.read(MAX_KICK_LISTING_BYTES + 1)
            if len(body) > MAX_KICK_LISTING_BYTES:
                raise ValueError("Kick listing too large")
            return json.loads(body)

        try:
            vods = await asyncio.get_event_loop().run_in_executor(None, fetch_listing)
        except Exception as e:
            raise VideoDownloadError("Kick VOD unavailable", reason="kick_unavailable") from e
        vod = find_kick_vod_by_start(vods, start_ms)
        video_uuid = vod.get("video", {}).get("uuid") if vod else None
        if not isinstance(video_uuid, str) or not UUID_PATTERN.fullmatch(video_uuid.lower()):
            raise VideoDownloadError("Kick VOD unavailable", reason="kick_unavailable")
        logger.info("Resolved a current Kick link to its video id")
        return f"https://kick.com/{channel}/videos/{video_uuid.lower()}"

    @staticmethod
    def _validate_vod_info(info: dict, max_duration: float, incomplete: bool = False, platform: str = "twitch"):
        name = VOD_PLATFORMS[platform][2]
        if not isinstance(info, dict):
            raise VideoDownloadError(f"{name} VOD unavailable", reason=f"{platform}_unavailable")
        # Archived broadcasts often have was_live=True and is_live=None.
        if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming", "post_live", "processing"}:
            raise VideoDownloadError(f"{name} VOD is not completed", reason=f"{platform}_not_completed")
        if incomplete:
            return None
        duration = finite_number(info.get("duration"))
        if not 0 < duration <= max_duration:
            raise VideoDownloadError(f"{name} VOD duration is invalid or too long", reason=f"{platform}_duration")
        return None

    @classmethod
    def _validate_twitch_info(cls, info: dict, max_duration: float, incomplete: bool = False):
        return cls._validate_vod_info(info, max_duration, incomplete, platform="twitch")

    async def _get_video_info(self, url: str, deadline: Optional[float] = None) -> VideoMetadata:
        """
        Get video metadata without downloading using yt-dlp Python library.

        Uses guarded Python sockets for metadata requests and redirects.
        """
        logger.debug("Getting video info")
        platform, vod_url = vod_platform(url)
        if vod_url:
            url = vod_url

        # Run in thread pool to not block event loop
        loop = asyncio.get_event_loop()

        def do_extract() -> dict:
            """Extract video info through guarded Python sockets."""
            opts = {"proxy": "", "external_downloader": "native", "hls_prefer_native": True}

            # Add metadata-specific options (no format specification to avoid errors)
            opts.update({
                "skip_download": True,
                "noplaylist": True,
                "socket_timeout": 30,
                "nocheckcertificate": False,
                "geo_bypass": True,
                "quiet": True,
                "no_warnings": True,
            })

            if platform:
                opts["allowed_extractors"] = [VOD_PLATFORMS[platform][1]]
            with guarded_ytdlp_children(deadline), guarded_public_connections():
                with yt_dlp.YoutubeDL(opts) as ydl:
                    return ydl.extract_info(url, download=False)

        try:
            info = await loop.run_in_executor(None, do_extract)
        except Exception as e:
            if platform and not is_disk_full(e):
                raise VideoDownloadError(f"{VOD_PLATFORMS[platform][2]} VOD unavailable", reason=f"{platform}_unavailable") from e
            error_str = str(e)
            # Provide user-friendly error for YouTube bot detection
            if "Sign in to confirm" in error_str or "bot" in error_str.lower():
                logger.error("YouTube bot detection triggered for metadata")
                raise VideoDownloadError(
                    "YouTube is temporarily blocking this request. Please try again in a few moments, "
                    "or try a different video URL."
                )
            raise VideoDownloadError(f"Failed to get video info: {e}")

        if platform:
            self._validate_vod_info(info, self.settings.max_download_duration_seconds, platform=platform)

        return self._metadata_from_info(info, platform or "youtube")

    @staticmethod
    def _metadata_from_info(info: dict, source_type: VideoSourceType) -> VideoMetadata:
        return VideoMetadata(
            source_type=source_type,
            title=info.get("title", "Unknown"),
            duration_seconds=float(finite_number(info.get("duration"), 0)),
            width=int(finite_number(info.get("width"), 1920)),
            height=int(finite_number(info.get("height"), 1080)),
            fps=float(finite_number(info.get("fps"), 30)),
            format_id=info.get("format_id", "unknown"),
            extractor=info.get("extractor", "unknown"),
            uploader=info.get("uploader"),
            upload_date=info.get("upload_date"),
            description=info.get("description"),
            thumbnail_url=info.get("thumbnail"),
        )

class VideoDownloadError(Exception):
    """Exception raised when video download fails."""
    def __init__(self, message: str, reason: Optional[str] = None):
        super().__init__(message)
        self.reason = reason
