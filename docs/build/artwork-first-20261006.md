# Artwork-first design correction

Status: implementing after the user rejected the frosted-panel design as generic.
Base: 335bc56c7211eeb512ff16ad26232c55129b2950.
Branch: design/artwork-first-20261006.

## Design read and audit

Reading this as an NFT collection browser for design-conscious collectors, with a precise contemporary gallery language using the existing native CSS stack. This is a visual overhaul of the rejected frontend, preserving application behavior and LABx brand accents.
Dials: design variance 6, motion intensity 6, visual density 4. Artwork and actual pack data should lead, with motion for arrival, focus and selection.

Current failure: the oversized lavender frosted hero, duplicated stacked thumbnails, artificial registration grid, heavy glows, decorative tubes, numbered labels and repeated rounded panel shells obscure the collection. A visitor must pass a marketing hero before reaching the actual pieces. The detail form is also over-boxed.

Preserve Space Grotesk / IBM Plex Mono, LABx wordmark, chrome/lavender/lime brand cues, every route/nav destination, all five footer links, existing accessibility and status rules, disclosures, artwork bytes and financial/backend logic.

## Implementation contract

R1 frontend only. Astra design owner, Sol implementation, independent Astra High review.

- Neutral chrome/off-white page, charcoal type. Lavender is a controlled brand accent, lime marks selected/primary actions. No full-page purple gradient or colored glow. Subtle frosted glass only in the compact header and one meaningful control surface, with opaque fallback.
- Remove the marketing hero and duplicate artwork stack. Compact introductory heading "The collection" plus short demo explanation; actual artwork starts within the first desktop viewport and within roughly 300px on mobile. Retain stable #bench and #hero-title anchors.
- One full-link capsule/card per piece. Four equal artwork columns on wide desktop, two on tablet, one on small screens. This is a collection grid, not a feature-card section. Artwork is square, uncropped, visually dominant. No outer card background or giant pill frame: image then title/status/real pack price, fee and timing in a clean caption.
- Use single simple caption hierarchy. Remove arbitrary item numbering, decorative status dots and labels over images. Keep truthful demo marking clearly visible around the collection and captions.
- Replace massive pill controls with crisp 6–12px corner geometry and consistent thin borders. Glass must serve layering/readability, not decorate every element.
- Detail: generous artwork on left, clear unboxed purchase column on right; five compact pack-selection rows, fee-inclusive total, original agreement order and action. Mobile single-column. Remove redundant nested frames and step-number labels. Preserve all handlers, gating, expiry/exhaustion behavior, membership terminology and disclosure/legal copy.
- Keep title letter-resolution, short staggered artwork reveals, directional hover/selection feedback. No layout-shifting text scramble, perpetual ambient loops, parallax page backgrounds, custom cursor or scroll hijack. Visible fallback, dynamic reduced-motion and keyboard visibility required.
- Replace/consolidate the previous refresh CSS rather than adding a third override theme. Do not change font loading, APIs, seed data, contracts or assets. The later explicit Atelier installation request authorizes its necessary dependencies.
- Required acceptance: web aggregate tests, TypeScript, production build, native desktop/mobile screenshots and interactions, zero/one/multiple/expired/exhausted states, keyboard/filters/detail totals, independent review. Contract test evidence can be reused because contracts remain byte-identical.
- No push, PR, deployment or chain actions authorized. User wants quiet execution and a finished result, not routine progress.

## Reference

Sora's public catalog inspected natively in this turn for compact navigation, visual catalog hierarchy and simple captions. Use composition principles, not its copy/source/assets. Prior supplied reference list remains in docs/build/design-references.md.

## Atelier integration

User explicitly requested Text Scramble with duration 0.7, scrambleFps 30, playOnMount true and playOnHover true. Ran shadcn 4.21.2 init -d, initially blocked by missing Tailwind; added Tailwind/PostCSS 4.3.3 and reran successfully, then installed @atelier/text-scramble. Generated Atelier skill version 1.5.0 read and raw usage downloaded. Removed unused default button, CLI/runtime scaffolding and restored Space Grotesk after initialization attempted a Geist replacement. Tailwind theme and utilities are available without Preflight resetting the existing design. Vendored Text Scramble and shared hooks are unchanged. Wrapper supplies SSR-readable text, fixed text measurement, screen-reader text, and dynamic reduced-motion fallback.

User then linked Atelier Letter Swarm and requested infinite scroll pages. Public docs show Letter Swarm is Pro and no ATELIER_PRO_KEY is configured. User explicitly chose a continuous page with animated sections and an original scroll-text effect. Paid Letter Swarm is not being installed. No key has been read into tool output.

## Continuous scroll extension

Astra High design preflight passed on the actual working gallery diff. Sol gallery owner also owns this serialized extension. Add two editorial sections, Look closer and Follow the draw, after the collection and before the footer. Concise truthful demo copy, no duplicated artwork/listings, normal native scroll. Deterministic original character gathering/scattering only on headings, with a wide readable hold interval; body/link remain readable. No pinned sections, artificial scroll tracks, scroll snapping or input interception. Passive native events schedule bounded RAF updates, no continuous loop; cleanup and live reduced-motion preference changes required. Static accessible headings and links must render outside the home page client-readiness boundary, including without JS. Filtering/resizing must update current geometry. Do not combine ancestor data-reveal transforms with the scroll headings.

Acceptance adds reversible native scroll, footer reachable with End/keyboard, static no-JS/unsupportedAPI fallback and live reducedmotion, filtering/layoutchanges, remount cleanup. Final independent candidate review still required.

## Pixel Scroll addendum

After source candidate 445d66b, user explicitly requested Atelier Pixel Scroll. Installed the actual free registry component with `npx --yes shadcn@latest add @atelier/pixel-scroll`; generated PixelScroll and SmoothScroll source, Motion 14.0.0 and Lenis 1.3.26. Raw usage downloaded. Use one unpinned decorative seam between the two story sections with pixelSize 50, colorRatio .25, randomness .4, sweep direction, stable lavender/lime hints. Explicit bounded height prevents the component default from adding a pinned 300vh track. Wrapper preserves static fallback, fixed dimensions, native scrolling and dynamic reduced motion. No artwork replacement or repeated listings. The component-specific usage describes SmoothScroll as optional; preserve native scrolling and leave that optional generated provider unmounted.

Provisional independent review found caption overflow with long unbroken Studio titles. Root reproduced title/status extending beyond card at 320 and 1440; Sol owner repairing minimum flex width and word wrapping. Earlier source candidate checks remain historical and final aggregate/build/browser/review gates must apply to the updated candidate.
