# Site polish and scrolling footer

Base `579faf0bccc774d607b7951083f93708d1cdf146`, branch `design/artwork-first-20261006`. Local R1 frontend slice. The user requested a high-end polish across the existing website and supplied a Motion footer to integrate. No publication or contract changes are authorized by this task.

## Design contract

Preserve the supplied logo/favicon/artwork, Basetica body font, uppercase Sixtyfour H1s, dot-grid background, lavender/lime/pink identity, beveled controls and tier colours, transparent header navigation, partner-branded passes and all existing workflow limitations. No stock imagery, fictitious raffles, invented records, social destinations or purchase capability. Existing seven-day contract work remains untouched.

Adapt the supplied footer under `web/components/ui/footer-section.tsx`, using existing Motion and named Lucide icons where useful. The shadcn aliases already target this directory, TypeScript and Tailwind v4 are installed, and styles belong in `web/app/globals.css`. No initialization or framework migration is needed. The user subsequently supplied a simpler footer reference. The final footer is a compact monochrome section on the existing light dot-grid background with one centered wrapping row for the guide and five legal links, four named icon shortcuts to real internal destinations, and a short LABx copyright. It has no logo, columns, operator block, glass frame or invented social accounts. A brief blur/translation reveal remains, with live reduced-motion preference handling.

Footer content must remain readable on server render, without JavaScript, without IntersectionObserver, under reduced motion and during keyboard focus. Preserve container layout when reduced motion is enabled. Use semantic navigation, 44px targets, visible focus and no scroll hijacking. Keep the animation short and one-time; links must never remain invisible while focused.

The wider polish targets measured weaknesses: consistent page width/header/content/footer rhythm; readable H2 and paragraph measures; deliberate surface radii and padding; transparent account navigation matching the primary menu; cohesive loading/empty states without fake data; quieter, better-grouped profile content; balanced collection/story spacing and existing art presentation. Consolidate touched obsolete styles instead of adding an unrelated redesign or a full CSS rewrite. Preserve all local state, form validation, wallet/API behavior, anchors and disclosures.

## Acceptance and ownership

One Sol implementation owner writes frontend source, styles and dependency/lockfile changes. Root handles browser verification and integration after freeze. Independent audit is read-only; a fresh Astra review inspects the final candidate. No concurrent source writers.

Run existing web tests and production build. Verify all public routes and both 404 states at 320, 390, 768 and 1440 widths, plus representative 1920 and 200% zoom. Check direct routes, footer destinations, scrolling reveal, reduced-motion preference including live changes, no-JavaScript footer, keyboard focus/navigation, images loaded before screenshots, form/review/reset flow, placeholder-copy fallback and cold hash links. Run an available automated accessibility check; record actual screen-reader/device limitations. Check source diffs and contract/artwork hashes remain unchanged. Test fixture data may be injected only into an isolated browser, never into the shipped catalog.

## Checkpoint

User additions: apply the fixed, click-through multiply noise overlay site-wide at opacity .5, with animated/static reduced-motion classes; remove redundant small category labels above page titles throughout the site. The initial implementation used a grain entrance that settled; the user clarified that it must remain continuous. The final implementation uses an original local SVG grain texture animated indefinitely on a compositor transform, with a keyboard-accessible pause/resume control and still output without JavaScript or with reduced motion. Functional guide-step labels, artist metadata and the 404 status remain.

Read-only source audit, baseline screenshots and implementation complete. Applied better-ui, better-accessibility, redesign-existing-projects, unslop, karpathy-guidelines and long-task-flow. Motion scroll and Lucide React official docs inspected. Builder web tests passed 140/140, production build including TypeScript passed, diff check passed. Browser verification and independent final review pending. Evidence directory: `artifacts/site-polish-20261006/`. Root/agent provider usage telemetry unavailable, recorded as unknown.

Latest footer revision: 140 web tests and production build/type check passed again. Browser verification is recovering from a Chromium session failure after the original 76 route/width checks; final footer and interaction checks remain pending. New user requests extend the subsequent task to complete seller/buyer website workflows and anti-manipulation review. Those are a separate R3 implementation contract; no live transaction or deployment is authorized.

## Final verification

PASS for source candidate `66fcd02d977a493a41644d19b5c31f68256ae4ac`, base `579faf0bccc774d607b7951083f93708d1cdf146`. The simplified charcoal footer preserves six real text links, four accessible icon shortcuts and copyright. Independent review found and root repaired a dark focus ring; it now has 6.12:1 contrast and forced-colors support. Live reduced-motion changes cannot re-hide links.

Observed: 140 web tests PASS; final production build PASS; original 76 route/width combinations PASS with unaffected source evidence retained; focused final footer, workflow, noise/reduced-motion, no-JS/no-IO and keyboard checks PASS; 25 axe audits zero violations; representative 1920 and simulated CSS 200% zoom PASS. Settled mobile/desktop screenshots inspected by reviewer. Initial Chromium session failure retained. A later apparent offscreen-focus defect was traced to an unfaithful harness starting with an already offscreen focused control; real keyboard traversal was independently rerun and passed. Details are in browser-footer.json, browser-flows.json, browser-a11y.json and browser-followup.json under artifacts/site-polish-20261006.

Fresh Astra High review PASS for the exact source candidate. Subsequent commits only add full-workflow planning docs. Physical devices, non-Chromium engines, manual screen reader and native browser zoom NOT_RUN. No push, deployment or on-chain change. Local final build remains on port3113 while the next R3 work proceeds separately.

### Final theme and continuous-static correction

The user rejected the charcoal footer. It now shares the page's light dot-grid background, with black text/icons, no circles, and monochrome focus. User also clarified that background static must be continuous. Source `7eb0a37256da3faa224b9d219c6e5ba465b9ca17` supersedes prior footer/noise visuals. Grain is visibly stronger and moves continuously with a 0.6-second stepped transform on an overscanned pseudo-element. The fixed click-through .5 multiply overlay remains. A small Pause/Animate control retains the choice across client navigation. Reduced motion and no JavaScript retain a still texture.

PASS: 140 tests before the one-attribute accessibility repair; final production build; independent focused 5/5 footer/noise checks; fresh 25-case axe audit with zero violations; all 11 footer controls keyboard-visible/unobscured; forced colors; five observed grain transform states after 5.70 seconds; pause/resume and navigation persistence; live reduced motion; no-JS/no-IO; no overflow or unexpected browser errors. Text contrast measured 15.27:1 and copyright 5.74:1. Desktop/mobile screenshots footer-final-light-1440.png and footer-final-light-390.png inspected. Fresh Astra review PASS on exact source. Previous charcoal captures are superseded. No publication or live transactions.

### Solid pillow controls

The user requested solid button colours with a soft pillow emboss. Source `9cce5a4df07ce1deba074c974ea849072851e46c` applies this to ordinary actions, collection filters, wallet, partner-code and texture controls. Text stays crisp; the primary menu remains transparent. Approved metallic membership cards retain their gradients. A focused browser check found the animated plate obscured long BookDemoButton labels on the first candidate, `a6d2598`. The final repair reserves space for the plate and lets the label wrap without clipping.

PASS: 140 web tests and final production build; independent focused browser verification 10/10 at 390 and 1440 pixels with zero browser diagnostics. Checks include all eight BookDemoButton variants and exact PieceDesk props, computed solid backgrounds, inset shadows, contrast, 44px targets, keyboard focus and reduced motion. Evidence: `artifacts/site-polish-20261006/solid-controls-verification.md`, `browser-solid-controls.json`, `browser-solid-controls.log` and settled screenshots. Prior wider route and accessibility evidence is retained for unchanged behavior. No publication or live transactions.
