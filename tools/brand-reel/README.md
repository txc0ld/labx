# LABx brand reel

The revised 15-second film explains LABx through membership purchase, bonus NFT raffle entries and partner discounts. Portrait and landscape are composed separately. On-screen text carries the complete product message with sound off; a local synthetic narrator and original 128 BPM score accompany playback when sound is enabled.

## Render

From the repository root:

```sh
npm ci --prefix tools/brand-reel
node tools/brand-reel/audio.cjs
```

The included narration is `narration/labx-voiceover.wav`. Follow `narration/README.md` to reproduce the voice and mix using the pinned Python requirements. The model weights are not committed. With the final mix available:

```sh
node tools/brand-reel/render.mjs --width 1920 --height 1080 --fps 60 --audio tools/brand-reel/narration/labx-final-mix.wav --out artifacts/brand-reel-20261006/v2/labx-brand-reel-1920x1080.mp4
node tools/brand-reel/render.mjs --width 1080 --height 1920 --fps 60 --audio tools/brand-reel/narration/labx-final-mix.wav --out artifacts/brand-reel-20261006/v2/labx-brand-reel-1080x1920.mp4
node tools/brand-reel/web-exports.mjs
node tools/brand-reel/verify.mjs
```

`--stills` exports review frames. Each master has 900 frames at 60 fps. Website copies have 450 frames at 30 fps, H.264 video and AAC stereo audio. The verifier fully decodes all four videos and checks duration, frames, dimensions, codecs and peak levels.

## Story

| Time | Message and motion |
| --- | --- |
| 0–2.8125s | Memberships, NFT raffles, partner perks. Immediate artwork stack and resolving type. |
| 2.8125–5.625s | Buy a membership. Metallic pack cards fan out in perspective. Bonus entries are explicitly included. |
| 5.625–8.90625s | Bonus raffle entries mean a chance to win an NFT. Membership, moving shapes and artwork show the connection. |
| 8.90625–12.1875s | Member discounts. The user-supplied Fantom Labs and SeatMap offers appear with “Redemption coming soon.” |
| 12.1875–15s | Supplied LABx logo and a readable product description hold through the end. |

The NFT images are supplied artwork, not asserted live listings. No purchases, entry counts, winners or wallet activity are fabricated. The offers are user-supplied; placeholder redemption codes do not appear as usable codes. This film does not establish launch readiness.

## Tools and assets

Tool selection was evaluated for this task. The isolated renderer uses `@napi-rs/canvas` 1.0.10 and `ffmpeg-static` 5.3.0, whose binary identifies itself as FFmpeg 7.0.2. Remotion was also evaluated. These are recorded versions, not a claim that every binary is the newest release. No rendering package is added to the website runtime.

Primary references: [Canvas API](https://github.com/Brooooooklyn/canvas), [FFmpeg raw-video input](https://ffmpeg.org/ffmpeg-formats.html#rawvideo), [FFmpeg codecs](https://ffmpeg.org/ffmpeg-codecs.html). Narration uses local `kokoro-onnx` 0.6.1, the official v1.0 model and generic `af_heart` voice. Its source, model hashes, dependencies and licenses are recorded under `narration/`.

Existing logo, artwork and Basetica font bytes are unchanged. Sixtyfour's OFL notice is included. Motion, shapes, textures and instrumental score are original code. No paid services, stock footage, external music or identifiable-person voice cloning is used. Automated audio checks do not substitute for a human listening review.
