# Partner card refresh

Source candidate `a335346fcc961b673659b4872fca1b44be4a67c3`, branch `design/artwork-first-20261006`. R0 presentation change, implemented directly. Local work only; no push or deployment.

The discount catalog and both offer detail pages share a branded PartnerPass. Fantom Labs uses purple, a glossy CSS orb and an animated spark. SeatMap uses charcoal, orange and an original seat-grid illustration. References inspected: https://www.fantomlabs.io/ and https://seatmap.app/pro. No third-party assets, fonts or source were imported. LABx typography and page chrome remain intact.

Both user-supplied 5% offers remain unchanged. XXXX remains explicitly a placeholder, with copy and manual-selection fallback. No membership entitlement or working redemption is claimed. Hover effects also respond to keyboard focus and honor reduced motion.

## Verification

All evidence is under `artifacts/partner-brand-contracts-20261006/`. Checks ran against the exact source committed above; the later documentation commit does not change tested inputs.

- PASS, exit 0: `npm --prefix web test`, 140 tests across nine files, `web-tests.log`.
- PASS, exit 0: `npm --prefix web run build`, including TypeScript checks, `web-build.log`. Existing ox/viem warning remains.
- PASS, exit 0: `git diff --check`.
- PASS, exit 0: `cards.cjs`, 12 route/viewport combinations across the catalog and both offer details at widths 320, 390, 768 and 1440. Also verified hover, visible focus, keyboard navigation, reduced motion, missing-clipboard fallback and 200% zoom. No horizontal overflow or page errors. Results in `cards.json` and `cards.log`.
- Visual inspection: `discounts-390.png` and `discounts-1440.png`. Other route/viewport screenshots and both reference screenshots are retained alongside them.

Local production server listens on port 3113. Shared preview points to `/discounts`; the existing LAN address is `http://192.168.2.30:3113/discounts`. Responsive checks used Chromium; no physical phone test in this slice. Native preview capture remained unreliable, so browser verification used the previously authorized headless browser.

## Contract strand

Read-only independent Astra High preflight is in `contract-policy-20261006.md`. Fresh baseline: 50 contract tests passed, including three fuzz tests with 1,024 runs each, exit 0. Log: `contracts-baseline.log`. Contract source remains unchanged.

Required user decision is pending: permissionless settlement after the existing seven-day reveal grace, plus optional permissionless recovery with a seven-day post-sales request cutoff and a fixed one-day or seven-day callback deadline. The question explicitly explains that valid late randomness would be discarded. No policy is inferred from silence. After selection, use the R3 implementation, independent verification and fresh review gates recorded in the preflight. On-chain operations remain outside this authorization.

Token/cost telemetry for root and delegated preflight is unavailable; usage is unknown.
