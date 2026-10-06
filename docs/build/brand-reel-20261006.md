# LABx brand reel and website splash

R0 original video artifact plus R1 website integration. User requested a confident 15-second LABx promotion with a first-second hook, typography, shape play, camera movement, colour changes, music-like pacing and a clean final frame. They then explicitly requested assigning it as the website splash. Local implementation and media rendering are authorized; publishing or deployment is not implied.

Root owns original rendering source/assets under `tools/brand-reel`, media under `web/public/brand`, and integration. Sol owns the isolated splash component/CSS module/layout mount and tests in `work/brand-splash-20261006`. Existing financial workflow owners continue in separate worktrees. No new website dependencies, remote media, invented raffle activity or live availability claims.

Contract: show the 15-second intro only on an initial homepage visit, once per browser session. Start muted, provide sound and Skip controls, auto-dismiss on completion, and never block direct financial/detail routes. Use a native modal dialog with Escape/focus handling and readable 44px controls. Skip for reduced motion and data-saving preferences; react to a live reduced-motion change. No-JavaScript must leave the ordinary website usable. Playback rejection, media errors and startup stalls must release the page. Do not load both aspect-ratio videos or preload media for ineligible visitors.

Acceptance: inspect composed frames and exported desktop/mobile video; verify duration, dimensions, codec, sound peak and decoded-frame count; run existing web tests/build; independently test splash eligibility, skip/end/error/rejection, session persistence/storage failure, direct routes, keyboard/focus, reduced motion, audio control, mobile orientation and media requests. Fresh Astra review of actual integrated source and evidence before calling the feature complete.

Status: rendering in progress; splash implementation delegated. Final evidence belongs in `artifacts/brand-reel-20261006/`. No push or deployment. Effective root model is GPT-6 Astra with ultra effort; builder role is configured Sol Medium. Provider usage/cost telemetry is unavailable.
