"""
Partial VOD downloads: trimming an HLS playlist to the selected range, handing
it to yt-dlp's native downloader, and reporting times on the full VOD's timeline.
"""

import asyncio
import json
import os
from types import SimpleNamespace

import pytest
import yt_dlp

from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment
from clip_engine.services.rendering_service import RenderingService, RenderResult
from clip_engine.services.transcription_service import TranscriptionResult, TranscriptSegment, TranscriptWord
from clip_engine.services.video_downloader import SectionYoutubeDL, VideoDownloadError, trim_hls_playlist

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

    async def download(url, output_dir, section=None, save_space=False):
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
    # The job records the range as requested, not the shifted one it ran with.
    requested = result.output.metrics["requested_settings"]
    assert (requested["start_time_seconds"], requested["end_time_seconds"]) == (330.0, 600.0)
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

    async def download(url, output_dir, section=None, save_space=False):
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


class TestSectionPrecision:
    def test_offset_accounts_for_where_video_starts_in_each_segment(self, monkeypatch):
        # Kick's first segment starts its audio 49 ms before its video; a later
        # one starts both together. A full download's zero is that first audio
        # packet, so the trimmed file starts 49 ms later on its timeline.
        ydl = SectionYoutubeDL({"quiet": True}, (52, 54))
        leads = {"https://cdn.example/v/2.ts": 0.0, "https://cdn.example/v/0.ts": 0.049}
        monkeypatch.setattr(ydl, "_read", lambda url, info, limit: PLAYLIST.encode())
        monkeypatch.setattr(ydl, "_video_lead", lambda url, info: leads[url])
        trimmed = ydl._trim({"url": "https://cdn.example/v/playlist.m3u8"})
        assert trimmed.start_seconds == 20.049

    def test_an_unmeasured_start_keeps_the_playlist_time(self, monkeypatch):
        ydl = SectionYoutubeDL({"quiet": True}, (52, 54))
        monkeypatch.setattr(ydl, "_read", lambda url, info, limit: PLAYLIST.encode())
        monkeypatch.setattr(ydl, "_video_lead", lambda url, info: None)
        assert ydl._trim({"url": "https://cdn.example/v/playlist.m3u8"}).start_seconds == 20.0

    def test_a_window_that_cant_be_cut_is_not_downloaded_in_full(self, monkeypatch):
        ydl = SectionYoutubeDL({"quiet": True}, (0, 60), require_trim=True)
        monkeypatch.setattr(ydl, "_read", lambda url, info, limit: PLAYLIST.encode())
        downloads = []
        monkeypatch.setattr(yt_dlp.YoutubeDL, "dl", lambda self, name, info, subtitle=False, test=False: downloads.append(info))
        with pytest.raises(VideoDownloadError) as error:
            ydl.dl("window.mp4", {"protocol": "m3u8_native", "url": "https://cdn.example/v/playlist.m3u8"})
        assert error.value.reason == "window_unavailable" and not downloads


def save_space_pipeline(monkeypatch, tmp_path, window=None):
    """A save-space Kick job: planned from a copy starting at 300 s, two clips."""
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(settings.__class__, "temp_directory", property(lambda self: str(tmp_path / "work")))
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True
    calls = {"downloads": [], "windows": [], "renders": []}

    async def download(url, output_dir, section=None, save_space=False, output_filename="source.mp4"):
        calls["downloads"].append((section, save_space, output_filename))
        path = tmp_path / output_filename
        path.write_bytes(b"source")
        full = output_filename == "source_full.mp4"
        return SimpleNamespace(
            video_path=str(path), file_size_bytes=1, source_type="kick",
            metadata=SimpleNamespace(title="Stream", duration_seconds=330.0, width=1920 if full else 854, height=1080 if full else 480),
            timeline_offset_seconds=270.0 if full else 300.0, source_duration_seconds=2224.0,
            vod_info=None if full else {"title": "Stream"},
        )

    async def transcribe(video_path, work_dir, keyterms=None, start_seconds=None, end_seconds=None):
        return TranscriptionResult(segments=[
            TranscriptSegment(40_000, 40_500, "hi", words=[TranscriptWord("hi", 40_000, 40_500)]),
            TranscriptSegment(90_000, 90_400, "there", words=[TranscriptWord("there", 90_000, 90_400)]),
        ], full_text="hi there")

    async def plan(**kwargs):
        return ClipPlanResponse(segments=[
            ClipPlanSegment(40_000, 70_000, 0.9, skip_ranges_ms=[(50_000, 58_000)], chapters=[(40_000, "Intro")]),
            ClipPlanSegment(90_000, 120_000, 0.8),
        ], total_clips=2)

    async def download_vod_window(info, source_type, start, end, output_dir):
        calls["windows"].append((info, source_type, start, end))
        if window:
            return window(start, end, output_dir)
        os.makedirs(output_dir, exist_ok=True)
        path = os.path.join(output_dir, "window.mp4")
        with open(path, "wb") as handle:
            handle.write(b"window")
        return SimpleNamespace(
            video_path=path, file_size_bytes=1, source_type="kick", timeline_offset_seconds=start - 2.5,
            metadata=SimpleNamespace(title="Stream", duration_seconds=end - start + 5, width=1920, height=1080),
        )

    async def render(request):
        calls["renders"].append(request)
        assert os.path.exists(request.video_path)
        with open(request.output_path, "wb") as handle:
            handle.write(b"mp4")
        return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=30_000)

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.video_downloader, "download_vod_window", download_vod_window)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", plan)
    monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)
    monkeypatch.setattr(pipeline, "_update_progress", lambda *args, **kwargs: None)

    def run():
        return asyncio.run(pipeline.process_video(ClippingJobRequest(
            video_url="https://kick.com/c/videos/x", job_id="job1", start_time_seconds=330.0, end_time_seconds=600.0,
            save_space=True,
        )))
    return run, calls


def test_save_space_renders_each_clip_from_its_own_full_quality_window(monkeypatch, tmp_path):
    run, calls = save_space_pipeline(monkeypatch, tmp_path)
    result = run()
    assert result.status == JobStatus.COMPLETED, result.error
    assert calls["downloads"] == [((330.0, 600.0), True, "source.mp4")]
    # The planning copy is gone before rendering; each window is deleted after.
    assert not (tmp_path / "source.mp4").exists()
    assert not (tmp_path / "work" / "job1").exists()
    # Windows are requested on the VOD's timeline...
    assert [(start, end) for _, _, start, end in calls["windows"]] == [(340.0, 370.0), (390.0, 420.0)]
    assert calls["windows"][0][:2] == ({"title": "Stream"}, "kick")
    # ...and each render uses times on its window (which starts 2.5 s early).
    first, second = sorted(calls["renders"], key=lambda r: r.output_path)
    assert (first.start_time_ms, first.end_time_ms, first.source_width) == (2_500, 32_500, 1920)
    assert first.skip_ranges_ms == [(12_500, 20_500)] and first.chapters == [(2_500, "Intro")]
    assert [s.start_time_ms for s in first.transcript_segments] == [2_500]
    assert [w.start_time_ms for w in first.transcript_segments[0].words] == [2_500]
    assert (second.start_time_ms, second.end_time_ms) == (2_500, 32_500)
    # Saved times stay on the full VOD's timeline.
    assert [(c.start_time_ms, c.end_time_ms) for c in result.output.clips] == [(340_000, 370_000), (390_000, 420_000)]
    assert result.output.metrics["requested_settings"]["save_space"] is True


def test_save_space_falls_back_to_one_full_quality_download(monkeypatch, tmp_path):
    def uncuttable(start, end, output_dir):
        raise VideoDownloadError("VOD window unavailable", reason="window_unavailable")

    run, calls = save_space_pipeline(monkeypatch, tmp_path, window=uncuttable)
    result = run()
    assert result.status == JobStatus.COMPLETED, result.error
    # One shared download of the job's range at full quality, for both clips.
    assert calls["downloads"] == [((330.0, 600.0), True, "source.mp4"), ((330.0, 600.0), False, "source_full.mp4")]
    # The full-quality copy starts 30 s before the planning copy.
    assert sorted(r.start_time_ms for r in calls["renders"]) == [70_000, 120_000]
    assert all(r.source_width == 1920 for r in calls["renders"])
    assert [(c.start_time_ms, c.end_time_ms) for c in result.output.clips] == [(340_000, 370_000), (390_000, 420_000)]


def test_save_space_network_failure_fails_only_that_clip(monkeypatch, tmp_path):
    (tmp_path / "w.mp4").write_bytes(b"window")

    def flaky(start, end, output_dir):
        if start == 390.0:
            raise VideoDownloadError("Kick VOD download failed", reason="kick_unavailable")
        return SimpleNamespace(
            video_path=str(tmp_path / "w.mp4"), file_size_bytes=1, source_type="kick", timeline_offset_seconds=start,
            metadata=SimpleNamespace(title="Stream", duration_seconds=40, width=1920, height=1080),
        )

    run, calls = save_space_pipeline(monkeypatch, tmp_path, window=flaky)
    result = run()
    assert result.status == JobStatus.COMPLETED, result.error
    assert [c.start_time_ms for c in result.output.clips] == [340_000]
    assert len(calls["downloads"]) == 1
