# Site polish and scrolling footer

Base `579faf0bccc774d607b7951083f93708d1cdf146`, branch `design/artwork-first-20261006`. Local R1 frontend slice. The user requested a high-end polish across the existing website and supplied a Motion footer to integrate. No publication or contract changes are authorized by this task.

## Design contract

Preserve the supplied logo/favicon/artwork, Basetica body font, uppercase Sixtyfour H1s, dot-grid background, lavender/lime/pink identity, beveled controls and tier colours, transparent header navigation, partner-branded passes and all existing workflow limitations. No stock imagery, fictitious raffles, invented records, social destinations or purchase capability. Existing seven-day contract work remains untouched.

Adapt the supplied footer under `web/components/ui/footer-section.tsx`, using existing Motion and named Lucide icons where useful. The shadcn aliases already target this directory, TypeScript and Tailwind v4 are installed, and styles belong in `web/app/globals.css`. No initialization or framework migration is needed. The footer has the LABx logo, compact real navigation groups, the five existing bottom legal links, operator/site identity and Sepolia-only disclosure. Its rounded top edge and subtle highlight lead into a staggered blur/translation reveal on scroll. No dummy demo route or placeholder footer links.

Footer content must remain readable on server render, without JavaScript, without IntersectionObserver, under reduced motion and during keyboard focus. Preserve container layout when reduced motion is enabled. Use semantic navigation, 44px targets, visible focus and no scroll hijacking. Keep the animation short and one-time; links must never remain invisible while focused.

The wider polish targets measured weaknesses: consistent page width/header/content/footer rhythm; readable H2 and paragraph measures; deliberate surface radii and padding; transparent account navigation matching the primary menu; cohesive loading/empty states without fake data; quieter, better-grouped profile content; balanced collection/story spacing and existing art presentation. Consolidate touched obsolete styles instead of adding an unrelated redesign or a full CSS rewrite. Preserve all local state, form validation, wallet/API behavior, anchors and disclosures.

## Acceptance and ownership

One Sol implementation owner writes frontend source, styles and dependency/lockfile changes. Root handles browser verification and integration after freeze. Independent audit is read-only; a fresh Astra review inspects the final candidate. No concurrent source writers.

Run existing web tests and production build. Verify all public routes and both 404 states at 320, 390, 768 and 1440 widths, plus representative 1920 and 200% zoom. Check direct routes, footer destinations, scrolling reveal, reduced-motion preference including live changes, no-JavaScript footer, keyboard focus/navigation, images loaded before screenshots, form/review/reset flow, placeholder-copy fallback and cold hash links. Run an available automated accessibility check; record actual screen-reader/device limitations. Check source diffs and contract/artwork hashes remain unchanged. Test fixture data may be injected only into an isolated browser, never into the shipped catalog.

## Checkpoint

User additions: apply the fixed, click-through multiply noise overlay site-wide at opacity .5, with animated/static reduced-motion classes; remove redundant small category labels above page titles throughout the site. The implementation uses original local SVG grain, a 2.4-second entrance that settles, and static output without JavaScript or with reduced motion. Functional guide-step labels, artist metadata and the 404 status remain.

Read-only source audit, baseline screenshots and implementation complete. Applied better-ui, better-accessibility, redesign-existing-projects, unslop, karpathy-guidelines and long-task-flow. Motion scroll and Lucide React official docs inspected. Builder web tests passed 140/140, production build including TypeScript passed, diff check passed. Browser verification and independent final review pending. Evidence directory: `artifacts/site-polish-20261006/`. Root/agent provider usage telemetry unavailable, recorded as unknown.
