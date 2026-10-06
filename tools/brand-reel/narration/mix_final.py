#!/usr/bin/env python3
"""Mix the LABx narration over the original stereo brand-reel score."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf


ROOT = Path(__file__).resolve().parent
SAMPLE_RATE = 48_000
FRAMES = SAMPLE_RATE * 15
MUSIC_REST_DB = -4.0
MUSIC_SPEECH_DB = -13.0
VOICE_GAIN_DB = 0.5
ATTACK_SECONDS = 0.06
RELEASE_SECONDS = 0.10
TARGET_PEAK_DB = -1.2


def db_to_gain(db: float) -> float:
    return 10 ** (db / 20)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def smoothstep(values: np.ndarray) -> np.ndarray:
    values = np.clip(values, 0.0, 1.0)
    return values * values * (3.0 - 2.0 * values)


def read_audio(path: Path, channels: int) -> np.ndarray:
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    if rate != SAMPLE_RATE or len(audio) != FRAMES or audio.shape[1] != channels:
        raise ValueError(
            f"{path} must be 15.0s, 48 kHz, and {channels} channel(s); "
            f"got {len(audio) / rate:.6f}s, {rate} Hz, {audio.shape[1]} channel(s)"
        )
    return audio


def duck_envelope(cues: list[dict[str, object]]) -> np.ndarray:
    time = np.arange(FRAMES, dtype=np.float64) / SAMPLE_RATE
    duck = np.zeros(FRAMES, dtype=np.float32)
    for cue in cues:
        start = float(cue["spokenStart"])
        end = float(cue["spokenEnd"])
        attack_start = max(0.0, start - ATTACK_SECONDS)
        release_end = min(FRAMES / SAMPLE_RATE, end + RELEASE_SECONDS)
        shape = np.zeros(FRAMES, dtype=np.float32)
        attack = (time >= attack_start) & (time < start)
        speech = (time >= start) & (time <= end)
        release = (time > end) & (time <= release_end)
        if start > attack_start:
            shape[attack] = smoothstep((time[attack] - attack_start) / (start - attack_start))
        shape[speech] = 1.0
        if release_end > end:
            shape[release] = 1.0 - smoothstep((time[release] - end) / (release_end - end))
        duck = np.maximum(duck, shape)
    return duck


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--music",
        type=Path,
        default=ROOT.parents[2] / "artifacts/brand-reel-20261006/audio.wav",
    )
    parser.add_argument("--voice", type=Path, default=ROOT / "labx-voiceover.wav")
    parser.add_argument("--manifest", type=Path, default=ROOT / "manifest.json")
    parser.add_argument("--output", type=Path, default=ROOT / "labx-final-mix.wav")
    args = parser.parse_args()

    music = read_audio(args.music.resolve(), 2)
    voice = read_audio(args.voice.resolve(), 1)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    duck = duck_envelope(manifest["cues"])
    music_db = MUSIC_REST_DB + duck * (MUSIC_SPEECH_DB - MUSIC_REST_DB)
    music_gain = np.power(10.0, music_db / 20.0).astype(np.float32)
    music_stem = music * music_gain[:, None]
    voice_stereo = np.repeat(voice, 2, axis=1) * db_to_gain(VOICE_GAIN_DB)
    mix = music_stem + voice_stereo

    peak_before = float(np.max(np.abs(mix)))
    target_peak = db_to_gain(TARGET_PEAK_DB)
    final_gain = min(1.0, target_peak / peak_before)
    mix *= final_gain
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, mix, SAMPLE_RATE, subtype="PCM_16")

    rms = float(np.sqrt(np.mean(mix**2)))
    voice_activity = np.max(np.abs(voice_stereo), axis=1) > db_to_gain(-50.0)
    voice_speech_rms = float(np.sqrt(np.mean(voice_stereo[voice_activity] ** 2)))
    music_speech_rms = float(np.sqrt(np.mean(music_stem[voice_activity] ** 2)))
    report = {
        "output": str(args.output),
        "outputSha256": sha256(args.output),
        "music": str(args.music.resolve()),
        "musicSha256": sha256(args.music.resolve()),
        "voice": str(args.voice.resolve()),
        "voiceSha256": sha256(args.voice.resolve()),
        "sampleRate": SAMPLE_RATE,
        "channels": 2,
        "bitDepth": 16,
        "frames": len(mix),
        "duration": len(mix) / SAMPLE_RATE,
        "musicRestDb": MUSIC_REST_DB,
        "musicSpeechDb": MUSIC_SPEECH_DB,
        "voiceGainDb": VOICE_GAIN_DB,
        "duckAttackSeconds": ATTACK_SECONDS,
        "duckReleaseSeconds": RELEASE_SECONDS,
        "finalGainDb": 20 * math.log10(final_gain),
        "peakDbfs": 20 * math.log10(float(np.max(np.abs(mix)))),
        "rmsDbfs": 20 * math.log10(rms),
        "speechVoiceToMusicRmsDb": 20 * math.log10(voice_speech_rms / music_speech_rms),
    }
    (args.output.parent / "mix-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
