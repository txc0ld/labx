# Squishy membership-pack cards

Status: complete locally. Tested source `cf435da1efd17ae74d56fa05d3018210dce53f80`. Base `7f41f4a`; branch `design/artwork-first-20261006`.

The user requests the supplied React squishy card for entry purchases using LABx accents. Treat this as an R1 presentation/selection integration. Astra High design, Sol implementation and fresh Astra High source/visual review. Preserve all existing backend, wallet, eligibility, agreement, quantity and purchase rules.

## Contract

- Add `web/components/ui/squishy-card-component.tsx`, adapting the supplied motion card and its circle/ellipse squish animation into a reusable native-radio pack choice. No subscription, placeholder Pro tier, lorem ipsum, stock artwork or extra public demo page.
- Bind the five cards to the actual Piece packs. Required visible data: pack name, USDC price, additional LAB_FEE, bonus entries and remaining availability. Use exact opaque lime #b9ff87, lavender #b37df6 and pink #ff79c0. Dark text with light neutral decorative shapes keeps contrast throughout the animation.
- Keep selection in PieceDesk. Cards select only; preserve the separate existing animated Record demo pack action, quantity, fee-inclusive total, original three agreements and current sold-out/closed guards. Native radio keyboard behavior, visible focus, selected state and disabled state are required. Do not accept any agreements or connect a wallet in browser QA.
- Make the right-column selector a compact two-column responsive grid. Allow a one-column narrow fallback if card content cannot fit at320px. Do not hardcode the supplied320x384 card dimensions, cause hover overflow, or add horizontal scroll. Keep price/fee readable and the supplied animation recognizable without excessive vertical space. Original artwork remains uncropped.
- Hover/focus animation with live reduced-motion support. No motion when disabled. Decorative SVG is hidden from accessibility APIs. No new provider required.
- Existing components.json already maps ui to @/components/ui; global stylesheet is web/app/globals.css. Tailwind and TypeScript are configured. Add framer-motion14.0.0 as a direct dependency matching the already installed Motion dependency, avoiding a duplicate runtime.
- Acceptance: relevant web tests, TypeScript, production build, browser selection/keyboard/quantity/fee/disabled/closed and reduced-motion checks,320/390/768/1440 screenshots and overflow checks, independent review of exact final source and screenshots.
- No push, merge, deployment or on-chain operation authorized for this change. All changes since remote669482c remain local. Latest prior UI changes include dot grid, supplied logo/favicon, centered header with wallet profile link, mint pixel cursor trail and Pixel Perfect purchase button.

Evidence goes under ignored artifacts/squishy-packs/. Track source revision separately from docs-only closeout. Usage/cost unknown.


## Final evidence

- PASS: 124 web tests, TypeScript and production build, all observed exit0. Evidence: `artifacts/squishy-packs/tests-final.txt`, `typecheck-final.txt`, `build-final.txt`.
- PASS: final headless browser script `browser.cjs` and `browser.json`, bound to sourcecf435da. Widths320/390/768/1440, all five native radios, actual price/fee/entries/availability, selected state, Gold quantity2 total510USDC including10USDC fee and80bonus entries, invalid quantity, unchecked agreement gating, sold-out Entry with other available tiers, closed raffle, keyboard selection and visible focus. All tested hover bounds fit the viewport. No page errors.
- PASS: card/SVG/circle/ellipse squish animation and live reduced-motion changes in both directions. Disabled and closed cards remain still. Initial candidate1d62885 failed live reduced-motion QA because Framer14's useReducedMotion snapshot did not rerender on a media change. The final implementation uses a reactive matchMedia subscription with zero-duration transitions and defensive reduced-motion CSS. Initial failure is preserved in `browser-initial-motion-failure.json`.
- PASS: independent review of actual code and eight final screenshots, recorded in `artifacts/squishy-packs/review.md`. No remaining blocker within this component integration.
- No wallet connection, accepted agreements, successful purchase, deployment, merge or push was performed. Browser fixtures were restored. Physical devices and Safari were not tested.

The component is under `web/components/ui/squishy-card-component.tsx`; styles are in `web/app/globals.css`. Existing aliases and Tailwind/TypeScript configuration were already correct. The supplied placeholder subscription copy was replaced with real pack data, and no unnecessary stock assets or public demo route were added. Original artwork and backend/contract code are unchanged.

The direct framer-motion dependency reuses installed14.0.0. `dependency-verification.json` confirms zero changed resolved package entries. Current npm audit reports5 existing findings:2moderate,1high,2critical, including development Vitest/Tinypool reports and Next's PostCSS dependency. These are not new findings in Framer Motion and were not fixed by this UI task. Coordinator/root owns follow-up dependency maintenance before any production release; this review is not security clearance.

Implementation role was configured Sol5.6medium; review role configuration confirms AstraHigh. Effective runtime attestation and usage/cost totals were not exposed. Final documentation closeout does not change the tested application source. Current publication remains the earlier remote669482c preview; this update and intervening local polish are not pushed.
