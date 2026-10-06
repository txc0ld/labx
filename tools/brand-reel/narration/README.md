# LABx reel voice and final mix

This directory contains a locally generated narration and a reproducible stereo mix for the 15-second LABx reel. No account, secret, cloned voice, paid service, or hosted TTS API was used.

## Successful backend

- Python 3.12.3 in the local `.venv`
- [`kokoro-onnx` 0.6.1](https://github.com/thewh1teagle/kokoro-onnx/tree/v0.6.1), MIT license
- Official [`kokoro-v1.0.onnx`](https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx), SHA-256 `beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a`
- Official [`voices-v1.0.bin`](https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin), SHA-256 `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d`
- Generic `af_heart` American English voice
- Exact Python dependency versions in `requirements.lock`

The maintainer's [setup documentation](https://github.com/thewh1teagle/kokoro-onnx/blob/main/README.md) specifies these model files and identifies the Kokoro model license as Apache-2.0. License copies are under `licenses/`.

## Reproduce

The generated narration WAV is included. To regenerate it, download the two official model files above into `python-model/` and check their SHA-256 values. Model weights and the local Python environment are not committed.

From this directory on Python 3.12:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python generate_python.py
.venv/bin/python verify_python.py
.venv/bin/python mix_final.py
.venv/bin/python verify_mix.py
```

`mix_final.py` reads the original score from `artifacts/brand-reel-20261006/audio.wav` in the repository root by default. It lowers music from -4 dB to -13 dB while each narration cue is active, uses smooth 60 ms attack and 100 ms release curves, and preserves the music's stereo image. The narration is centered at +0.5 dB. Any required final gain is applied uniformly, with a -1.2 dBFS peak ceiling.

The deliverable is `labx-final-mix.wav`. Machine-readable generation details and checksums are in `manifest.json` and `mix-report.json`; verification logs are under `evidence/`.

The format, timing, cue containment, gain targets, hashes, and peak level are checked automatically. A human editor should still audition the mix because this environment cannot make a subjective judgment about voice tone, pronunciation, or musical balance.
