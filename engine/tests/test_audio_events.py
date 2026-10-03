"""
Audio events: grouping YAMNet and loudness frames into reactions, attaching
them to transcript segments, and running beside transcription.
"""

import asyncio
import csv
import wave

import numpy as np
import pytest

from clip_engine.services import audio_events as ae
from clip_engine.services import transcription_service as ts
from clip_engine.services.audio_events import AudioEvent, attach_audio_events, find_events
from clip_engine.services.transcription_service import TranscriptionResult, TranscriptSegment

with open(ae.CLASS_MAP_PATH, encoding="utf-8", newline="") as handle:
    NAMES = [row[2] for row in list(csv.reader(handle))[1:]]
INDEX = {name: i for i, name in enumerate(NAMES)}


def frames(count=100, speech=0.9, db=-30.0):
    scores = np.zeros((count, len(NAMES)), dtype=np.float32)
    scores[:, INDEX["Speech"]] = speech
    return scores, np.full(count, db, dtype=np.float32)


class TestFindEvents:
    def test_class_frames_group_into_events_with_strength(self):
        scores, loud = frames()
        # A laugh over frames 10-13 (one quiet frame inside), peaking at 0.35.
        scores[[10, 11, 13], INDEX["Laughter"]] = [0.15, 0.35, 0.12]
        scores[40, INDEX["Giggle"]] = 0.11
        scores[70, INDEX["Laughter"]] = 0.08  # under the threshold: ordinary talk
        scores[80, INDEX["Crying, sobbing"]] = 0.2
        events = find_events(scores, loud, NAMES, offset_ms=1000)
        assert [(e.label, e.start_ms, e.end_ms, e.strong) for e in events] == [
            ("laughter", 1000 + 4800, 1000 + 7200, True),
            ("laughter", 1000 + 19200, 1000 + 20160, False),
            ("crying", 1000 + 38400, 1000 + 39360, False),
        ]
        assert events[0].tag == "(laughter, strong)" and events[1].tag == "(laughter)"

    def test_loud_outbursts_need_a_voice_and_the_videos_own_quiet_baseline(self):
        # Eight minutes of ordinary talk around a few loud moments.
        scores, loud = frames(count=1000, db=-30.0)
        loud[20] = -16.0                     # 14 dB over the median, with speech: an outburst
        loud[[50, 51]] = -10.0               # 20 dB over: strong
        loud[80] = -9.0                      # as loud, but music and no voice
        scores[80, INDEX["Speech"]] = 0.05
        scores[80, INDEX["Music"]] = 0.9
        loud[90] = -60.0                     # silence never lowers the baseline
        events = find_events(scores, loud, NAMES)
        assert [(e.label, e.start_ms, e.strong) for e in events] == [
            ("loud outburst", 9600, False), ("loud outburst", 24000, True),
        ]

    def test_a_uniformly_loud_video_has_no_outbursts(self):
        scores, loud = frames(db=-12.0)
        assert find_events(scores, loud, NAMES) == []


class TestAttach:
    def segments(self):
        return [TranscriptSegment(0, 4000, "one"), TranscriptSegment(5000, 9000, "two"), TranscriptSegment(20000, 22000, "three")]

    def test_events_go_on_their_sentence_or_the_one_that_just_ended(self):
        segments = self.segments()
        attach_audio_events(segments, [
            AudioEvent("laughter", 6000, 7000, True),     # during "two"
            AudioEvent("laughter", 6500, 7500, True),     # the same tag again: once
            AudioEvent("loud outburst", 9500, 10500),     # right after "two"
            AudioEvent("applause", 17500, 18500),         # before "three", nothing recent
            AudioEvent("crying", 13000, 14000),           # far from everything: dropped
        ])
        assert [s.audio_events for s in segments] == [
            [], ["(laughter, strong)", "(loud outburst)"], ["(applause)"],
        ]

    def test_no_segments_is_fine(self):
        attach_audio_events([], [AudioEvent("laughter", 0, 960)])


def write_wav(path, samples):
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


@pytest.fixture
def model():
    pytest.importorskip("onnxruntime")
    session, names = ae._model()
    if session is None:
        pytest.skip("YAMNet is unavailable")
    return session


class TestRealModel:
    @pytest.mark.parametrize("seconds", [0.5, 59.9, 60.48, 61.0, 125.3])
    def test_minute_blocks_match_one_pass_exactly(self, model, tmp_path, seconds):
        rng = np.random.default_rng(7)
        samples = (rng.standard_normal(int(16000 * seconds)) * 0.1).astype(np.float32)
        write_wav(tmp_path / "a.wav", samples)
        quantized = np.clip(samples, -1, 1)
        quantized = (quantized * 32767).astype("<i2").astype(np.float32) / 32768
        whole = model.run(["output_0"], {"waveform": quantized})[0]
        scores, loudness, _ = ae.frame_scores(str(tmp_path / "a.wav"))
        assert scores.shape == whole.shape and len(loudness) == len(whole)
        assert np.array_equal(scores, whole)

    def test_silence_and_a_tone_are_not_reactions(self, model, tmp_path):
        t = np.arange(16000 * 10) / 16000
        write_wav(tmp_path / "quiet.wav", np.zeros_like(t))
        write_wav(tmp_path / "tone.wav", 0.5 * np.sin(2 * np.pi * 1000 * t))
        assert ae.detect_audio_events(str(tmp_path / "quiet.wav")) == []
        assert ae.detect_audio_events(str(tmp_path / "tone.wav")) == []

    def test_unreadable_audio_yields_no_events(self, tmp_path):
        (tmp_path / "bad.wav").write_bytes(b"not audio")
        assert ae.detect_audio_events(str(tmp_path / "bad.wav")) == []


def test_transcription_attaches_events_detected_in_parallel(monkeypatch, tmp_path):
    service = ts.TranscriptionService.__new__(ts.TranscriptionService)
    service.settings = type("S", (), {"audio_events_enabled": True})()
    calls = {}

    async def extract(video_path, audio_path, start, end):
        write_wav(audio_path, np.zeros(16000))
        calls["window"] = start

    async def transcribe_audio(audio_path, timeline_offset_seconds=0.0, **_):
        return TranscriptionResult(segments=[TranscriptSegment(30_000, 34_000, "no puede ser")], full_text="")

    def detect(path, offset):
        calls["detect"] = (path, offset)
        return [AudioEvent("loud outburst", 33_000, 34_000, True)]

    (tmp_path / "v.mp4").write_bytes(b"video")
    monkeypatch.setattr(service, "_extract_audio_from_video", extract)
    monkeypatch.setattr(service, "transcribe_audio", transcribe_audio)
    monkeypatch.setattr(ts, "detect_audio_events", detect)
    result = asyncio.run(service.transcribe(str(tmp_path / "v.mp4"), str(tmp_path), start_seconds=40.0))
    assert result.segments[0].audio_events == ["(loud outburst, strong)"]
    assert calls["detect"][1] == calls["window"] == 40.0 - ts.TRANSCRIPTION_RANGE_PAD_SECONDS
    assert not (tmp_path / "audio_extracted.wav").exists()

    service.settings.audio_events_enabled = False
    calls.clear()
    result = asyncio.run(service.transcribe(str(tmp_path / "v.mp4"), str(tmp_path)))
    assert "detect" not in calls and result.segments[0].audio_events == []
