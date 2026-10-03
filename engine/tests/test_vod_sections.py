"""
Partial VOD downloads: trimming an HLS playlist to the selected range, handing
it to yt-dlp's native downloader, and reporting times on the full VOD's timeline.
"""

import asyncio
import json
from types import SimpleNamespace

import pytest
import yt_dlp

from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment
from clip_engine.services.rendering_service import RenderingService, RenderResult
from clip_engine.services.transcription_service import TranscriptionResult, TranscriptSegment, TranscriptWord
from clip_engine.services.video_downloader import SectionYoutubeDL, trim_hls_playlist

# Shaped like a real Kick VOD playlist: per-segment dates, an ad marker, and a
# stream restart (a discontinuity, with a missing segment number) mid-way.
PLAYLIST = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:13
#ID3-EQUIV-TDTG:2026-09-18T03:03:23
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-TWITCH-ELAPSED-SECS:0.000
#EXT-X-PROGRAM-DATE-TIME:2026-09-18T02:25:00.726Z
#EXTINF:10.000,
0.ts
#EXT-X-PROGRAM-DATE-TIME:2026-09-18T02:25:10.726Z
#EXTINF:10.000,
1.ts
#EXT-X-DATERANGE:ID="ad",START-DATE="2026-09-18T02:25:20.726Z",PLANNED-DURATION=30.000
#EXT-X-PROGRAM-DATE-TIME:2026-09-18T02:25:20.726Z
#EXTINF:10.000,
2.ts
#EXTINF:5.500,
3.ts
#EXT-X-DISCONTINUITY
#EXT-X-TWITCH-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2026-09-18T02:26:20.000Z
#EXTINF:10.000,
5.ts
#EXTINF:10.000,
6.ts
#EXT-X-ENDLIST
"""


def segment_names(playlist: str) -> list[str]:
    return [line for line in playlist.splitlines() if line and not line.startswith("#")]


class TestTrimPlaylist:
    def test_keeps_the_padded_window_and_reports_where_it_starts(self):
        section = trim_hls_playlist(PLAYLIST, 22, 28, pad_seconds=0)
        assert segment_names(section.playlist) == ["2.ts"]
        assert (section.start_seconds, section.duration_seconds, section.total_seconds) == (20.0, 10.0, 55.5)
        lines = section.playlist.splitlines()
        assert lines[0] == "#EXTM3U" and lines[-1] == "#EXT-X-ENDLIST"
        assert "#EXT-X-MEDIA-SEQUENCE:2" in lines
        # A segment keeps the tags written before it.
        assert lines.index("#EXT-X-PROGRAM-DATE-TIME:2026-09-18T02:25:20.726Z") < lines.index("2.ts")
        assert any(line.startswith("#EXT-X-DATERANGE") for line in lines)

    def test_padding_widens_the_window(self):
        section = trim_hls_playlist(PLAYLIST, 22, 28, pad_seconds=5)
        assert segment_names(section.playlist) == ["1.ts", "2.ts", "3.ts"]
        assert section.start_seconds == 10.0

    def test_times_run_straight_across_a_discontinuity(self):
        # A full download joins the restart without a gap, so 5.ts starts at 35.5 s.
        section = trim_hls_playlist(PLAYLIST, 40, 50, pad_seconds=0)
        assert segment_names(section.playlist) == ["5.ts", "6.ts"]
        assert section.start_seconds == 35.5
        assert "#EXT-X-DISCONTINUITY" in section.playlist

    def test_open_ended_windows(self):
        assert segment_names(trim_hls_playlist(PLAYLIST, None, 15, pad_seconds=0).playlist) == ["0.ts", "1.ts"]
        tail = trim_hls_playlist(PLAYLIST, 38, None, pad_seconds=0)
        assert segment_names(tail.playlist) == ["5.ts", "6.ts"] and tail.start_seconds == 35.5

    @pytest.mark.parametrize("start, end", [(0, 60), (None, None), (100, 200)])
    def test_nothing_to_save_returns_none(self, start, end):
        assert trim_hls_playlist(PLAYLIST, start, end, pad_seconds=0) is None

    @pytest.mark.parametrize("change", [
        lambda p: p.replace("#EXT-X-ENDLIST\n", ""),  # still live
        lambda p: p.replace("#EXT-X-VERSION:3", '#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="k"'),
        lambda p: p.replace("#EXT-X-VERSION:3", '#EXT-X-VERSION:3\n#EXT-X-MAP:URI="init.mp4"'),
        lambda p: p.replace("#EXTINF:5.500,", "#EXTINF:5.500,\n#EXT-X-BYTERANGE:100@0"),
        lambda p: p.replace("#EXTINF:5.500,", "#EXTINF:nan,"),
        lambda p: p.replace("#EXTINF:5.500,", "#EXTINF:abc,"),
        lambda p: p.replace("#EXTM3U", "not a playlist"),
    ])
    def test_unsafe_playlists_are_not_trimmed(self, change):
        assert trim_hls_playlist(change(PLAYLIST), 22, 28, pad_seconds=0) is None


class TestSectionDownloader:
    def make(self, monkeypatch, body=PLAYLIST.encode(), fail=None):
        # With the default 30 s padding this keeps 2.ts onwards.
        ydl = SectionYoutubeDL({"quiet": True}, (52, 54))
        requests, downloads = [], []

        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, limit): return body[:limit]

        def urlopen(request):
            requests.append(request)
            if fail:
                raise fail
            return Response()

        monkeypatch.setattr(ydl, "urlopen", urlopen)
        monkeypatch.setattr(yt_dlp.YoutubeDL, "dl", lambda self, name, info, subtitle=False, test=False: downloads.append(info))
        return ydl, requests, downloads

    def test_hls_download_gets_the_trimmed_playlist(self, monkeypatch):
        ydl, requests, downloads = self.make(monkeypatch)
        info = {"protocol": "m3u8_native", "url": "https://cdn.example/v/playlist.m3u8", "http_headers": {"Referer": "x"}}
        ydl.dl("source.mp4", info)
        assert requests[0].url == info["url"] and requests[0].headers["Referer"] == "x"
        assert segment_names(downloads[0]["hls_media_playlist_data"]) == ["2.ts", "3.ts", "5.ts", "6.ts"]
        assert downloads[0]["url"] == info["url"]  # segments still resolve against the real playlist
        assert ydl.trimmed.start_seconds == 20.0
        assert "hls_media_playlist_data" not in info

    def test_other_protocols_and_failures_download_in_full(self, monkeypatch):
        ydl, requests, downloads = self.make(monkeypatch)
        ydl.dl("source.mp4", {"protocol": "https", "url": "https://cdn.example/v.mp4"})
        assert not requests and "hls_media_playlist_data" not in downloads[0]

        ydl, _, downloads = self.make(monkeypatch, fail=OSError("offline"))
        ydl.dl("source.mp4", {"protocol": "m3u8_native", "url": "https://cdn.example/p.m3u8"})
        assert "hls_media_playlist_data" not in downloads[0] and ydl.trimmed is None

        ydl, _, downloads = self.make(monkeypatch, body=b"#EXTM3U\n" + b"#" * (9 * 1024 * 1024))
        ydl.dl("source.mp4", {"protocol": "m3u8_native", "url": "https://cdn.example/p.m3u8"})
        assert "hls_media_playlist_data" not in downloads[0] and ydl.trimmed is None


def test_pipeline_reports_partial_download_times_on_the_source_timeline(monkeypatch, tmp_path):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(settings.__class__, "temp_directory", property(lambda self: str(tmp_path / "work")))
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True
    calls = {}

    async def download(url, output_dir, section=None):
        calls["section"] = section
        meta = SimpleNamespace(title="Stream", duration_seconds=330.0, width=1920, height=1080)
        return SimpleNamespace(
            video_path=str(tmp_path / "source.mp4"), metadata=meta, file_size_bytes=1,
            timeline_offset_seconds=300.0, source_duration_seconds=2224.0,
        )

    async def transcribe(video_path, work_dir, keyterms=None, start_seconds=None, end_seconds=None):
        calls["transcribe"] = (start_seconds, end_seconds)
        words = [TranscriptWord("hi", 40_000, 40_500)]
        return TranscriptionResult(segments=[TranscriptSegment(40_000, 40_500, "hi", words=words)], full_text="hi")

    async def plan(**kwargs):
        calls["plan"] = (kwargs["start_time_seconds"], kwargs["end_time_seconds"])
        segment = ClipPlanSegment(40_000, 70_000, 0.9, skip_ranges_ms=[(50_000, 58_000)], chapters=[(40_000, "Intro")])
        return ClipPlanResponse(segments=[segment], total_clips=1)

    async def render(request):
        calls["render"] = (request.start_time_ms, request.end_time_ms, request.skip_ranges_ms, request.chapters)
        open(request.output_path, "wb").write(b"mp4")
        return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=22_000)

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", plan)
    monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)
    monkeypatch.setattr(pipeline, "_update_progress", lambda *args, **kwargs: None)

    result = asyncio.run(pipeline.process_video(ClippingJobRequest(
        video_url="https://kick.com/c/videos/x", job_id="job1", start_time_seconds=330.0, end_time_seconds=600.0,
    )))

    assert result.status == JobStatus.COMPLETED, result.error
    assert calls["section"] == (330.0, 600.0)
    # Everything that reads the file works on its own timeline...
    assert calls["transcribe"] == calls["plan"] == (30.0, 300.0)
    assert calls["render"] == (40_000, 70_000, [(50_000, 58_000)], [(40_000, "Intro")])
    # ...and everything saved is on the full VOD's.
    clip = result.output.clips[0]
    assert (clip.start_time_ms, clip.end_time_ms, clip.duration_ms) == (340_000, 370_000, 22_000)
    assert result.output.source_video_duration_seconds == 2224.0
    out = tmp_path / "out" / "job1"
    transcript = json.loads((out / "transcript.json").read_text())["segments"][0]
    assert (transcript["start_time_ms"], transcript["words"][0]["start_time_ms"]) == (340_000, 340_000)
    planned = json.loads((out / "plan.json").read_text())["segments"][0]
    assert (planned["start_time_ms"], planned["skip_ranges_ms"], planned["chapters"]) == (
        340_000, [[350_000, 358_000]], [[340_000, "Intro"]],
    )
    manifest = json.loads((out / "job_output.json").read_text())
    assert manifest["clips"][0]["start_time_ms"] == 340_000


def test_a_start_past_the_end_of_the_video_fails_clearly(monkeypatch, tmp_path):
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(settings.__class__, "temp_directory", property(lambda self: str(tmp_path / "work")))
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True

    async def download(url, output_dir, section=None):
        # Kick said 38:18, but the playable VOD ends at 37:04: only its last
        # 18 s overlap the padded range, starting at 2205.6 s.
        meta = SimpleNamespace(title="Stream", duration_seconds=18.3, width=1920, height=1080)
        return SimpleNamespace(
            video_path=str(tmp_path / "source.mp4"), metadata=meta, file_size_bytes=1,
            timeline_offset_seconds=2205.568, source_duration_seconds=2223.853,
        )

    async def transcribe(**kwargs):
        raise AssertionError("nothing to transcribe")

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    monkeypatch.setattr(pipeline, "_update_progress", lambda *args, **kwargs: None)
    result = asyncio.run(pipeline.process_video(ClippingJobRequest(
        video_url="https://kick.com/c/videos/x", job_id="job1", start_time_seconds=2238.0, end_time_seconds=2298.0,
    )))
    assert result.status == JobStatus.FAILED
    assert result.error == "Trim start is past the end of the video"
    assert result.failure_code == "source.trim_past_end"
