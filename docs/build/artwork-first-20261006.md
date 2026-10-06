# Artwork-first design correction

Status: complete locally. Source, build, final headless browser checks and independent Astra High review passed. Not pushed or deployed.
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

## Solid brand palette addendum

User supplied a LABx logo reference and requested exact #b9ff87, #b37df6 and #ff79c0 colors at full opacity. Apply these to active accents, selected navigation/packs, badges, buttons and actual Pixel Scroll cells; preserve neutral frosted header. Dark text #202124 gives calculated contrast ratios 13.58:1, 5.51:1 and 6.71:1 respectively. Use dark focus outlines rather than lavender against paper. Preserve dark button light labels through explicit variant styling. No artwork or supplied-logo import required for a palette request. Pixel source remains untouched.

Text Scramble's unchanged upstream hook schedules idle RAF callbacks. Coordinator accepts this low-impact upstream characteristic for this bounded integration; only one heading uses it, no visible perpetual animation, reduced-motion/unmount disposes it. Any future upstream scheduling optimization belongs to the integration maintainer, outside this requested visual change.

## Content reduction and guide addendum

User requested minimal text on main pages and a dedicated how-to guide for explanations. Add SSR /guide with metadata and sitemap entry. Link it from landing, raffle detail and the second continuous scroll section; preserve the five existing footer destinations. Keep main pages focused on artwork, title, price/fee, availability/time/status and required controls. Keep one clear visible browser-demo/no-transactions disclosure, required eligibility agreements and action errors. Move explanatory copy out of hero, detail lede and continuous story bodies. Preserve the approved Text Scramble, original scroll headings, Pixel Scroll, exact solid palette and uncropped artwork. Compact OnChainStatus is allowed only as an optional presentation mode; existing other surfaces and all handlers/authorization stay unchanged. Guide explains browsing, packs, fee/quantity, eligibility, demo records and intended escrow/commit/VRF/reveal/settlement workflow without asserting deployed Safe configuration, live listings, audit or legal clearance.

Verification adds guide SSR, internal links/navigation/sitemap, retained price/fee/disclosure/agreements, then source aggregate/build and affected browser screenshots. Earlier source candidates remain historical; final candidate remains pending.


## Earlier blocked checkpoint (superseded)

Source candidate: `93b9dd6a285fbb687209b2137094389277c1b7c1` on `design/artwork-first-20261006`.

The guide and reduced main-page copy are implemented. Root aggregate web tests passed 122/122, TypeScript passed, and the production build passed. Evidence is in ignored `artifacts/artwork-first/web-tests-guide.txt`, `typecheck-guide.txt`, and `build-guide.txt`. The build retains the pre-existing ox/viem dependency warning. Independent Astra High source review found no blocking code/content issue, with final visual acceptance still pending.

`guide-http-ssr.json` records the served guide title, demo and additional-fee copy, four section anchors, sitemap entry and nine linked routes returning HTTP 200. Artwork checksums passed. Contracts, API handlers, web/lib and public artwork remain unchanged. Earlier browser evidence is revision-labelled in `browser-functional-391.json`; it does not establish final guide layout. The dependency audit still has four pre-existing findings, three moderate and one high.

Final desktop/mobile screenshots, guide anchor interaction and affected visual checks are BLOCKED. T3 `preview_open` reports available, while screenshots fail and resize requests time out or report no automation host. A synchronous guide DOM read at 1280px reported no overflow, but a native anchor click did not change URL or scroll, so interaction is not recorded as passed. User choice to reopen T3 desktop Preview or explicitly permit a headless browser is pending. Do not bypass that pending choice or mark visual review complete. Actual focus-ring appearance was also unavailable in earlier native verification.

Local production server runs on port 3113 using this source candidate. No push, PR, merge, deployment or chain operation occurred. Token/cost usage is unknown. Next action is to restore browser verification, inspect final screenshots, obtain the final independent verdict and close this report. Production and the historic Vercel preview do not include these local changes.


## Final headless verification

The user explicitly approved a headless browser after the native T3 failure. Existing Playwright and installed Chromium 153.0.8010.12 verified the production build of source candidate `93b9dd6a285fbb687209b2137094389277c1b7c1`. No app dependencies or source changed during verification. The native Preview was reopened at the local homepage, but its rendering failure is not claimed repaired.

PASS evidence in ignored `artifacts/artwork-first/`:

- `final-browser.json`: homepage widths 320, 390, 768, 1440 and 1920 have no document overflow; all images loaded. First artwork starts at 310px/320px on the two phone widths. Final desktop/mobile home, detail and guide screenshots were inspected. Home and story guide navigation works. No page errors.
- `final-interactions.json`: direct guide anchor text clears the sticky header, guide contents links and detail pack-guide link work. Gold quantity 2 totals 510 USDC, including 10 USDC fee and 80 bonus entries. Unchecked agreements block the action; no agreements were accepted. An exhausted Entry pack correctly reports sold out while other packs keep the piece open. The temporary fixture was restored.
- Pixel Scroll responds in both directions at 390 and 1440px. Painted cells use alpha 255, with the exact requested lavender, pink and lime RGB values observed. Real browser reduced-motion emulation removes the canvas and character transforms, then restores the effect when disabled. Keyboard Tab produces visible 3px dark focus outline; Skip to content works. No page errors.
- Screenshots: `final-home-{390,1440}.png`, `final-detail-{390,1440}.png`, `final-guide-{390,1440}.png`, `final-guide-anchor.png`, `final-pixel-{390,1440}.png` and `final-keyboard-focus.png`.

Two browser-harness attempts failed before passing: an ambiguous alert locator also matched Next's route announcer, and an early pixel sample raced CSS smooth scrolling. The final script scopes the alert to main and uses explicit instant scroll for deterministic progress samples. Neither required an application repair. These are not hidden app-test failures.

The earlier revision-labelled animation lifecycle, filter, empty/single/expired/exhausted, long-title, direct-route and footer checks remain reusable for unchanged inputs. Physical devices and Safari were not tested. Contract tests were not rerun for this frontend-only candidate; historical results remain separate. No claim of live raffle, audited custody or production readiness is made.

The implementation remains local. The historical Vercel review preview and production alias have not been updated. A future publication needs specific authorization; on-chain funding, ownership, migration and unresolved contract policy decisions remain separate work.


## Final independent verdict

Independent Astra High review passed for application source `93b9dd6a285fbb687209b2137094389277c1b7c1`. The reviewer inspected the actual code, all ten final screenshots, both completed browser scripts and their recorded results. No unresolved blocking finding remains within this frontend scope. Full scoped verdict: `artifacts/artwork-first/independent-review-guide.md`. This report closeout changes documentation only and does not invalidate the source checks.

Next step: user design acceptance of the local candidate, followed by specific approval if a review-branch push or deployment is wanted. This session contains no standing publication authorization for the current candidate.
