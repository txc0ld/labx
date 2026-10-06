# LABx brand reel and website splash

R0 original video artifact plus R1 website integration. User requested a confident 15-second LABx promotion with a first-second hook, typography, shape play, camera movement, colour changes, music-like pacing and a clean final frame. They then explicitly requested assigning it as the website splash. Local implementation and media rendering are authorized; publishing or deployment is not implied.

Root owns original rendering source/assets under `tools/brand-reel`, media under `web/public/brand`, and integration. Sol owns the isolated splash component/CSS module/layout mount and tests in `work/brand-splash-20261006`. Existing financial workflow owners continue in separate worktrees. No new website dependencies, remote media, invented raffle activity or live availability claims.

Contract: show the 15-second intro only on an initial homepage visit, once per browser session. Start muted, provide sound and Skip controls, auto-dismiss on completion, and never block direct financial/detail routes. Use a native modal dialog with Escape/focus handling and readable 44px controls. Skip for reduced motion and data-saving preferences; react to a live reduced-motion change. No-JavaScript must leave the ordinary website usable. Playback rejection, media errors and startup stalls must release the page. Do not load both aspect-ratio videos or preload media for ineligible visitors.

Acceptance: inspect composed frames and exported desktop/mobile video; verify duration, dimensions, codec, sound peak and decoded-frame count; run existing web tests/build; independently test splash eligibility, skip/end/error/rejection, session persistence/storage failure, direct routes, keyboard/focus, reduced motion, audio control, mobile orientation and media requests. Fresh Astra review of actual integrated source and evidence before calling the feature complete.

## Current checkpoint

The first cut was rejected because it did not explain LABx. The replacement explicitly shows membership purchase, bonus NFT raffle entries and partner discounts, using the supplied artwork and membership-card design. The approved partner offer amounts are shown with redemption marked coming soon. Generic local narration supports the same on-screen message.

Both full-resolution 60fps masters and optimized website copies have been rendered under `artifacts/brand-reel-20261006/v2/` and `web/public/brand/`. V1 artifacts remain only as historical evidence. Root visually inspected key composed frames at both aspect ratios. Independent Astra review passed the actual V2 frames and amended splash source with no blocker; its report includes exact hashes in `v2/review/V2-FRAMES-SOURCE-REVIEW.md`.

Native Preview played the V2 widescreen master to 15.00s, with 900 frames and zero dropped frames. Full media decode verification and integrated website browser checks are being finalized. Narration was generated locally with Kokoro ONNX and measured separately from its ducked stereo mix. Subjective human listening approval is not claimed.

The source splash has once-per-session eligibility, muted autoplay, Sound/Skip controls, a screen-reader description and theme-matched controls. No push or deployment has occurred. Effective root model is GPT-6 Astra with ultra effort; implementation role was configured Sol Medium and independent reviewer Astra High. Provider usage/cost telemetry is unknown.
