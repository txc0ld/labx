# Squishy membership-pack cards

Status: implementing. Base `7f41f4a`; branch `design/artwork-first-20261006`.

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
