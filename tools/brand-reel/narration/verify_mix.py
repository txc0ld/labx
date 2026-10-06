#!/usr/bin/env python3
"""Verify the final LABx reel mix and its documented source hashes."""

from __future__ import annotations

import hashlib
import json
import math
import wave
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "labx-final-mix.wav"
REPORT = ROOT / "mix-report.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    with wave.open(str(OUTPUT), "rb") as wav:
        require(wav.getnchannels() == 2, "mix must be stereo")
        require(wav.getframerate() == 48_000, "mix must be 48 kHz")
        require(wav.getsampwidth() == 2, "mix must be 16-bit PCM")
        require(wav.getnframes() == 720_000, "mix must be exactly 15 seconds")
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").reshape(-1, 2)
    audio = samples.astype(np.float64) / 32768
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio**2)))
    require(peak <= 10 ** (-1.0 / 20), "mix peak exceeds -1 dBFS")
    require(peak >= 10 ** (-2.0 / 20), "mix peak is unexpectedly low")
    require(np.any(samples[:, 0] != samples[:, 1]), "music stereo image was lost")
    require(report["musicSpeechDb"] == -13.0, "speech duck target changed")
    require(report["musicRestDb"] == -4.0, "resting music target changed")
    require(report["speechVoiceToMusicRmsDb"] >= 6.0, "speech lacks measured level separation")
    require(report["outputSha256"] == sha256(OUTPUT), "output hash does not match report")
    require(
        report["musicSha256"] == sha256(Path(report["music"])),
        "music source hash does not match report",
    )
    require(
        report["voiceSha256"] == sha256(Path(report["voice"])),
        "voice source hash does not match report",
    )
    result = {
        "status": "PASS",
        "durationSeconds": len(audio) / 48_000,
        "sampleRate": 48_000,
        "channels": 2,
        "bitDepth": 16,
        "frames": len(audio),
        "peakDbfs": 20 * math.log10(peak),
        "rmsDbfs": 20 * math.log10(rms),
        "outputSha256": sha256(OUTPUT),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
