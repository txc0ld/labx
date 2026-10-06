#!/usr/bin/env python3
"""Verify the generated narration format, levels, and cue containment."""

from __future__ import annotations

import json
import math
import wave
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "labx-voiceover.wav"
MANIFEST = ROOT / "manifest.json"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    with wave.open(str(OUTPUT), "rb") as wav:
        require(wav.getnchannels() == 1, "output must be mono")
        require(wav.getframerate() == 48_000, "output must be 48 kHz")
        require(wav.getsampwidth() == 2, "output must be 16-bit PCM")
        require(wav.getnframes() == 720_000, "output must be exactly 15 seconds")
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float64) / 32768

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    require(len(manifest["cues"]) == 5, "five narration cues are required")
    for index, cue in enumerate(manifest["cues"], start=1):
        require(cue["spokenStart"] >= cue["start"], f"cue {index} starts before its window")
        require(cue["spokenEnd"] <= cue["end"], f"cue {index} overruns its window")
        require(cue["headroomAfter"] >= cue["tail"] - 1 / 48_000, f"cue {index} lacks breathing room")

    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(samples**2)))
    require(peak < 0.9, "peak has insufficient headroom")
    require(peak > 0.5, "narration level is unexpectedly low")
    require(np.count_nonzero(samples[-round(0.25 * 48_000) :]) == 0, "ending needs at least 250ms silence")
    report = {
        "status": "PASS",
        "durationSeconds": len(samples) / 48_000,
        "sampleRate": 48_000,
        "channels": 1,
        "bitDepth": 16,
        "frames": len(samples),
        "peakDbfs": 20 * math.log10(peak),
        "rmsDbfs": 20 * math.log10(rms),
        "cueHeadroomSeconds": [round(cue["headroomAfter"], 6) for cue in manifest["cues"]],
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
