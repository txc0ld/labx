#!/usr/bin/env python3
"""Generate the timed LABx reel narration with local Kokoro ONNX."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro


ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "python-model/kokoro-v1.0.onnx"
VOICES = ROOT / "python-model/voices-v1.0.bin"
SEGMENT_DIR = ROOT / "python-segments"
OUTPUT = ROOT / "labx-voiceover.wav"
MANIFEST = ROOT / "manifest.json"
TARGET_RATE = 48_000
TOTAL_SECONDS = 15.0
VOICE = "af_heart"


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str
    speed: float
    lead: float = 0.10
    tail: float = 0.12


CUES = (
    Cue(0.0, 2.8125, "Lab ex. Memberships and N F T raffles.", 1.14, 0.04, 0.10),
    Cue(2.8125, 5.625, "Choose your membership.", 0.96, 0.13, 0.16),
    Cue(5.625, 8.90625, "Get bonus entries for a chance to win an N F T.", 1.07, 0.10, 0.14),
    Cue(8.90625, 12.1875, "Plus, discounts from partner brands.", 0.99, 0.12, 0.16),
    Cue(12.1875, 15.0, "That's Lab ex.", 0.92, 0.16, 0.34),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resample_linear(samples: np.ndarray, source_rate: int) -> np.ndarray:
    output_length = round(len(samples) * TARGET_RATE / source_rate)
    if output_length == len(samples):
        return samples.astype(np.float32, copy=False)
    source_positions = np.arange(len(samples), dtype=np.float64)
    target_positions = np.arange(output_length, dtype=np.float64) * source_rate / TARGET_RATE
    return np.interp(target_positions, source_positions, samples).astype(np.float32)


def polish(samples: np.ndarray) -> np.ndarray:
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    samples -= float(np.mean(samples))
    peak = float(np.max(np.abs(samples)))
    if peak:
        samples *= 10 ** (-3.0 / 20) / peak
    fade = min(round(0.012 * TARGET_RATE), len(samples) // 2)
    if fade:
        ramp = np.sin(np.linspace(0, math.pi / 2, fade, dtype=np.float32)) ** 2
        samples[:fade] *= ramp
        samples[-fade:] *= ramp[::-1]
    return samples


def write_pcm16(path: Path, samples: np.ndarray) -> None:
    sf.write(path, samples, TARGET_RATE, subtype="PCM_16")


def main() -> None:
    SEGMENT_DIR.mkdir(exist_ok=True)
    kokoro = Kokoro(str(MODEL), str(VOICES))
    master = np.zeros(round(TOTAL_SECONDS * TARGET_RATE), dtype=np.float32)
    records: list[dict[str, object]] = []

    for index, cue in enumerate(CUES, start=1):
        raw, source_rate = kokoro.create(
            cue.text,
            voice=VOICE,
            speed=cue.speed,
            lang="en-us",
            trim=True,
            sentence_pause=0.12,
            clause_pause=0.06,
        )
        segment = polish(resample_linear(raw, source_rate))
        capacity = round((cue.end - cue.start - cue.lead - cue.tail) * TARGET_RATE)
        if len(segment) > capacity:
            raise RuntimeError(
                f"cue {index} is {len(segment) / TARGET_RATE:.3f}s; "
                f"only {capacity / TARGET_RATE:.3f}s is available"
            )

        start_frame = round((cue.start + cue.lead) * TARGET_RATE)
        end_frame = start_frame + len(segment)
        master[start_frame:end_frame] += segment
        segment_path = SEGMENT_DIR / f"{index:02d}.wav"
        write_pcm16(segment_path, segment)
        records.append(
            {
                **asdict(cue),
                "file": str(segment_path.relative_to(ROOT)),
                "spokenStart": start_frame / TARGET_RATE,
                "spokenEnd": end_frame / TARGET_RATE,
                "duration": len(segment) / TARGET_RATE,
                "headroomAfter": cue.end - end_frame / TARGET_RATE,
            }
        )

    peak = float(np.max(np.abs(master)))
    if peak > 10 ** (-2.5 / 20):
        master *= 10 ** (-2.5 / 20) / peak
    write_pcm16(OUTPUT, master)

    rms = float(np.sqrt(np.mean(master**2)))
    manifest = {
        "generator": "kokoro-onnx 0.6.1",
        "voice": VOICE,
        "sampleRate": TARGET_RATE,
        "channels": 1,
        "bitDepth": 16,
        "frames": len(master),
        "duration": len(master) / TARGET_RATE,
        "peakDbfs": 20 * math.log10(float(np.max(np.abs(master)))),
        "rmsDbfs": 20 * math.log10(rms),
        "output": OUTPUT.name,
        "outputSha256": sha256(OUTPUT),
        "modelSha256": sha256(MODEL),
        "voicesSha256": sha256(VOICES),
        "cues": records,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
