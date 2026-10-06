# LABx brand reel

Original 15-second motion design, composed at 128 BPM with six shots and a resolved logo hold. The landscape and portrait layouts are composed separately rather than cropping one export.

## Render

Run from the repository root:

```bash
npm ci --prefix tools/brand-reel
node tools/brand-reel/audio.cjs
node tools/brand-reel/render.mjs --width 1920 --height 1080 --fps 60 --audio artifacts/brand-reel-20261006/audio.wav --out artifacts/brand-reel-20261006/labx-brand-reel-1920x1080.mp4
node tools/brand-reel/render.mjs --width 1080 --height 1920 --fps 60 --audio artifacts/brand-reel-20261006/audio.wav --out artifacts/brand-reel-20261006/labx-brand-reel-1080x1920.mp4
```

`node tools/brand-reel/web-exports.mjs` creates the optimized website copies and final-frame poster from those masters.

`--stills` exports the selected review frames instead of a movie. `--crf` adjusts encoding quality. The fixed duration is 15 seconds. Each full-resolution master has 900 frames at 60 fps and an original stereo audio sting. Website copies use smaller dimensions and 30 fps.

## Direction

- 0–1.875s: immediate ring/camera impact, extruded READY typography, supplied LABx logo.
- 1.875–4.6875s: moving outline type, contrasting lime title plate, “Membership. With more.”
- 4.6875–7.5s: orbiting padded forms, match cuts, lime/purple/pink colour changes.
- 7.5–10.3125s: perspective membership-card fan and camera rotation.
- 10.3125–12.1875s: typographic acceleration and logo impact.
- 12.1875–15s: clean brand lockup with room to hold.

No prices, live raffles, winners, transactions or availability claims are fabricated. The cards are brand graphics, not listings.

## Tools and assets

The tool choice was checked for this task rather than inherited from the website. This isolated renderer uses current `@napi-rs/canvas` 1.0.10, its Skia drawing API, and the pinned `ffmpeg-static` 5.3.0 package, whose binary identifies itself as FFmpeg 7.0.2. It does not add a runtime animation dependency to the website. These are recorded versions, not a claim that every binary is the newest release.

Primary references: [Skia Canvas API](https://github.com/Brooooooklyn/canvas), [FFmpeg raw-video input](https://ffmpeg.org/ffmpeg-formats.html#rawvideo), [FFmpeg codecs](https://ffmpeg.org/ffmpeg-codecs.html). Remotion was also evaluated; direct rendering gives this short, deterministic composition the required control without introducing another application framework.

The logo and Basetica font are the user's existing project assets and are read without modifying them. Sixtyfour is the same Google Font used by the site; its OFL notice is included beside the render font. Shapes, timing, textures and audio are original code. No external music or stock footage is used. The audio is instrumental; the website starts muted and requires a user action to enable sound.
