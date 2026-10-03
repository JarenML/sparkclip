"""
Audio events: reactions the transcript can't show, found in the audio itself.

Two complementary signals, measured over the same 0.96 s frames every 0.48 s:

- YAMNet (Google's AudioSet classifier, assets/models/yamnet.onnx) for
  laughter, crying, screaming and applause. Real reactions under speech and
  game audio score low, around 0.1-0.4, so the threshold is low too.
- Loudness against the video's own typical level, for outbursts YAMNet hears
  as speech. A loud frame only counts when YAMNet hears a voice there, so an
  alert, a game explosion or music doesn't.

Events are attached to the transcript segment they happen in (or right after)
as "(laughter)", "(loud outburst, strong)" and so on; the planner reads them
there. Everything here is best effort: a missing model or runtime, or any
failure, just yields no events.
"""

import logging
import math
import os
import threading
import wave
from dataclasses import dataclass
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "assets", "models")
MODEL_PATH = os.path.join(MODEL_DIR, "yamnet.onnx")
CLASS_MAP_PATH = os.path.join(MODEL_DIR, "yamnet_class_map.csv")

SAMPLE_RATE = 16000
HOP_SECONDS = 0.48
WINDOW_SECONDS = 0.96
HOP = int(HOP_SECONDS * SAMPLE_RATE)
WINDOW = int(WINDOW_SECONDS * SAMPLE_RATE)
# Samples one YAMNet frame reads: 96 STFT hops of 160 plus a 400-sample window.
PATCH = 95 * 160 + 400
# Audio goes to the model a minute at a time; 125 hops make exactly 60 s, so
# frames from consecutive chunks stay on one 0.48 s grid.
CHUNK_FRAMES = 125

# Event label -> YAMNet classes (display names in yamnet_class_map.csv).
CLASS_GROUPS = {
    "laughter": ("Laughter", "Giggle", "Belly laugh", "Chuckle, chortle", "Snicker", "Baby laughter"),
    "crying": ("Crying, sobbing", "Whimper", "Wail, moan"),
    "screaming": ("Screaming",),
    "applause": ("Applause", "Cheering", "Clapping"),
}
# Reactions mixed with a voice and game audio score low; a stream's real
# laughs measured 0.1-0.4 while ordinary talk stayed under 0.03.
CLASS_THRESHOLD = 0.10
STRONG_CLASS_SCORE = 0.30

# A frame is an outburst when it's this much louder than the video's median
# frame and among its loudest few percent, and YAMNet hears a voice in it.
LOUD_OVER_MEDIAN_DB = 12.0
STRONG_LOUD_OVER_MEDIAN_DB = 18.0
LOUD_PERCENTILE = 98.0
VOICE_THRESHOLD = 0.5
VOICE_CLASSES = ("Speech", "Shout", "Yell", "Screaming", "Laughter", "Children shouting")
# Frames quieter than this are silence and don't count toward the median.
SILENCE_DB = -50.0

# Frames of one kind this close together form one event.
MAX_GAP_FRAMES = 1
# An event between sentences goes on the one that just ended, if this recent.
ATTACH_AFTER_MS = 3000


@dataclass
class AudioEvent:
    label: str
    start_ms: int
    end_ms: int
    strong: bool = False

    @property
    def tag(self) -> str:
        return f"({self.label}, strong)" if self.strong else f"({self.label})"


_session_lock = threading.Lock()
_session = None
_class_names: Optional[list[str]] = None


def _model():
    """The shared YAMNet session and class names, or (None, None) if unavailable."""
    global _session, _class_names
    with _session_lock:
        if _session is None:
            try:
                import csv
                import onnxruntime

                options = onnxruntime.SessionOptions()
                # Runs beside transcription and renders; two threads keep it
                # at ~10 s per hour of audio without crowding them.
                options.intra_op_num_threads = 2
                _session = onnxruntime.InferenceSession(MODEL_PATH, options, providers=["CPUExecutionProvider"])
                with open(CLASS_MAP_PATH, encoding="utf-8", newline="") as handle:
                    _class_names = [row[2] for row in list(csv.reader(handle))[1:]]
            except Exception as error:
                logger.warning("Audio event model unavailable (%s); skipping audio events", type(error).__name__)
                _session, _class_names = False, None
        return (_session, _class_names) if _session else (None, None)


def _read_samples(wav_path: str):
    """Yield float samples from a 16 kHz mono 16-bit WAV, a block at a time."""
    with wave.open(wav_path, "rb") as audio:
        if audio.getframerate() != SAMPLE_RATE or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError("Audio events need 16 kHz mono 16-bit PCM")
        while data := audio.readframes(CHUNK_FRAMES * HOP):
            yield np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def frame_scores(wav_path: str) -> tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[list[str]]]:
    """Per-frame YAMNet scores [frames, classes] and loudness in dB, or Nones if unavailable.

    The audio goes to the model a minute at a time. Each block carries the
    samples its last frame reads past the minute, and only frames that lie
    wholly inside it are kept, so the scores match a single pass exactly.
    """
    session, names = _model()
    if session is None:
        return None, None, None
    block = (CHUNK_FRAMES - 1) * HOP + PATCH
    scores, loudness = [], []
    buffer = np.zeros(0, dtype=np.float32)
    source = _read_samples(wav_path)
    ended = False
    while True:
        while not ended and len(buffer) < block:
            more = next(source, None)
            if more is None:
                ended = True
            else:
                buffer = np.concatenate([buffer, more])
        if len(buffer) == 0 or (ended and len(buffer) < HOP and scores):
            break
        output = session.run(["output_0"], {"waveform": buffer})[0]
        keep = len(output) if ended else CHUNK_FRAMES
        output = output[:keep]
        padded = np.concatenate([buffer, np.zeros(max(0, (len(output) - 1) * HOP + WINDOW - len(buffer)), np.float32)])
        windows = np.lib.stride_tricks.sliding_window_view(padded, WINDOW)[::HOP][:len(output)]
        scores.append(output)
        loudness.append(20 * np.log10(np.maximum(np.sqrt(np.mean(np.square(windows), axis=1)), 1e-9)))
        if ended:
            break
        buffer = buffer[CHUNK_FRAMES * HOP:]
    if not scores:
        return np.zeros((0, len(names))), np.zeros(0), names
    return np.concatenate(scores), np.concatenate(loudness), names


def find_events(scores: np.ndarray, loudness: np.ndarray, names: list[str], offset_ms: int = 0) -> list[AudioEvent]:
    """Group frames that pass the class or loudness tests into timed events."""
    index = {name: i for i, name in enumerate(names)}
    hits: dict[str, list[tuple[int, bool]]] = {}

    for label, classes in CLASS_GROUPS.items():
        columns = [index[name] for name in classes if name in index]
        if not columns:
            continue
        best = scores[:, columns].max(axis=1)
        hits[label] = [(f, best[f] >= STRONG_CLASS_SCORE) for f in np.flatnonzero(best >= CLASS_THRESHOLD)]

    voiced = loudness[loudness > SILENCE_DB]
    if len(voiced):
        median = float(np.median(voiced))
        floor = max(median + LOUD_OVER_MEDIAN_DB, float(np.percentile(voiced, LOUD_PERCENTILE)))
        voice = scores[:, [index[name] for name in VOICE_CLASSES if name in index]].max(axis=1)
        hits["loud outburst"] = [
            (f, loudness[f] - median >= STRONG_LOUD_OVER_MEDIAN_DB)
            for f in np.flatnonzero((loudness >= floor) & (voice >= VOICE_THRESHOLD))
        ]

    events: list[AudioEvent] = []
    for label, frames in hits.items():
        run: list[tuple[int, bool]] = []
        for frame, strong in frames + [(math.inf, False)]:
            if run and frame - run[-1][0] > MAX_GAP_FRAMES + 1:
                start = run[0][0] * HOP_SECONDS
                end = run[-1][0] * HOP_SECONDS + WINDOW_SECONDS
                events.append(AudioEvent(
                    label, offset_ms + round(start * 1000), offset_ms + round(end * 1000),
                    any(s for _, s in run),
                ))
                run = []
            run.append((frame, strong))
    return sorted(events, key=lambda event: (event.start_ms, event.label))


def detect_audio_events(wav_path: str, offset_seconds: float = 0.0) -> list[AudioEvent]:
    """Events in a 16 kHz mono WAV, timed on the timeline the file starts at `offset_seconds` of."""
    try:
        scores, loudness, names = frame_scores(wav_path)
        if scores is None:
            return []
        events = find_events(scores, loudness, names, round(offset_seconds * 1000))
        logger.info("Found %d audio event(s): %s", len(events), ", ".join(
            f"{label} x{sum(e.label == label for e in events)}" for label in sorted({e.label for e in events})
        ) or "none")
        return events
    except Exception as error:
        logger.warning("Audio event detection failed (%s); continuing without it", type(error).__name__)
        return []


def attach_audio_events(segments: list, events: list[AudioEvent]) -> None:
    """Add each event's tag to the segment it happens in, or the one just before it.

    An event in the middle of a sentence belongs to it; one in a pause goes on
    the sentence that just ended (a reaction follows what caused it), or on
    the next one if nothing ended recently. Each tag appears once per segment.
    """
    if not segments:
        return
    for event in events:
        middle = (event.start_ms + event.end_ms) // 2
        target = next((s for s in segments if s.start_time_ms <= middle < s.end_time_ms), None)
        if target is None:
            before = [s for s in segments if s.end_time_ms <= middle and middle - s.end_time_ms <= ATTACH_AFTER_MS]
            after = [s for s in segments if s.start_time_ms > middle]
            target = before[-1] if before else (after[0] if after and after[0].start_time_ms - middle <= ATTACH_AFTER_MS else None)
        if target is not None and event.tag not in target.audio_events:
            target.audio_events.append(event.tag)
