# Workflow screens contract, 2026-10-06

## Objective and boundary

R1. Complete useful screens and navigation for Explore, membership packs, partner discounts, Studio, profile, eligibility, receipts, history and fairness. The user explicitly prioritized screens over working Sepolia connections. Partner discounts mean benefits from partner brands. No push or deployment is authorized.

The source inspection baseline was local commit `737b9f4`, following released `024f4d9`. Root subsequently committed the guide and spacing changes as `fa07622`. The builder may now edit `web/app/guide/page.tsx` and `web/app/globals.css`, preserving that work. The production `BenchProvider` starts with an empty catalog. `PieceDesk` already retains the full detail interface behind its missing-listing state.

## User-facing behavior

| Route | Required behavior |
| --- | --- |
| `/` | Keep the artwork-led Explore layout, functional filters and accurate empty collection. Add clear navigation to membership and discounts. Never insert fixture raffles. |
| `/piece/[id]` | Preserve artwork, artist, timing, status, pack choices, quantity, order calculation, commitment and fairness navigation for supplied listing data. Missing IDs show an unavailable screen with useful links. Pack selection may support inspection without purchase; the screen must never imply an order was placed. |
| `/membership` | Explain membership packs and compare the existing tier names without invented prices, stock or benefits. Use only approved facts already present in the guide, including the existing fee and quantity limits. Link to Explore, partner discounts, eligibility and terms. |
| `/discounts` | Show exactly two user-approved partner offer cards. Fantom Labs offers 5% off any service it offers. Seatmap offers 5% off Pro membership. Each card links to its offer-detail route. Link to membership and profile without assuming active membership. |
| `/discounts/fantom-labs` | Show the approved 5% discount on any Fantom Labs service and an explicitly labeled website link to `https://www.fantomlabs.io`. Redemption method and exact eligibility remain pending. |
| `/discounts/seatmap` | Show the approved 5% discount on Seatmap Pro membership and an explicitly labeled website link to `https://seatmap.app`. Redemption method and exact eligibility remain pending. |
| `/eligibility` | Present existing age, terms, draw-rule and expiry requirements. A local checklist can help readers review them, but must not declare eligibility verified, create an agreement record or grant access. Link back to membership and Explore. |
| `/seller` | Replace the dead-end Studio with an editable preparation screen and a review step. Accept only user-entered public listing details, such as title, artist, token reference and proposed closing date. Label the review as preparation, kept only in the current page session. Provide edit/reset actions and guidance for escrow, commitment and publishing. Never collect private commitment secrets, upload files, create listings, publish, or write into the catalog. |
| `/profile` | Preserve existing wallet, points and browser email behavior. Add clear account navigation to membership, discounts, history, receipts and agreements. Unconnected membership status is unknown, never inactive or active by assumption. |
| `/profile/history` | Provide entry/purchase and agreement sections with accurate unavailable states. Explain what records belong here and link to Explore, rules and receipts. No fabricated counts, balances or activities. |
| `/profile/receipts` | Provide the receipt destination and explain that verified purchases supply receipt records. Link to email preferences and history. No fabricated transaction, receipt, resend or download success. |
| `/fairness` | Keep the existing process explanation and record table. Make the empty state useful through Explore, guide and draw-rule navigation. Do not manufacture a commitment, snapshot or result. |

These two offer facts were supplied directly by the user after initial design. Root verified `https://seatmap.app` and its footer link to Fantom Labs at `https://www.fantomlabs.io`. Website links are informational and must not be labeled as redemption links. Until the user supplies redemption and eligibility details, each detail screen must visibly state that redemption is unavailable and details are pending. Do not invent a code, contact address, claim flow, automatic activation, expiry, additional restrictions or verified membership. Do not add speculative friends or other partner offers.

Keep the guide's existing anchors usable. Add visible primary destinations for membership and discounts, secondary profile navigation, correct current-page indications and meaningful return links. Keep Studio at `/seller` to preserve existing URLs.

## Implementation constraints

Use existing typography, artwork, colors, pack styling and spacing conventions. Keep controls usable at phone widths and with keyboard navigation. Distinguish a missing source from a confirmed empty account.

Expected files include `Shell.tsx`, `BenchHub.tsx`, `PieceDesk.tsx`, the listed page routes, profile/Studio metadata, `lib/nav.ts`, sitemap and focused tests. Small presentational components and a local Studio form component are appropriate. Preserve backend APIs, contracts, authorization, wallet/security logic, catalog initialization, artwork, fonts and dependency locks. No new API calls or entitlement/purchase state.

## Acceptance and evidence

Run existing `npm test` and `npm run build` in `web`. Add focused behavior coverage for Studio edit/review/reset, eligibility copy/state, missing records and navigation. Verify both approved discount cards reach their details, show the exact user-approved benefits and return to discounts. Verify redemption remains unavailable while its method and eligibility are unresolved. Preserve the fixture-backed detail/pack tests without importing fixtures into production.

Browser-check complete navigation on desktop and a narrow phone viewport. Verify all destination and anchor links, current-page state, keyboard controls, no horizontal overflow, and no fabricated data after refresh or legacy browser storage. Exercise Studio with real user-entered text; review must preserve it, editing must work, reset must clear it, and no publication or backend request may occur. Confirm an unknown piece remains unavailable and that full detail code survives.

The Sol builder owns implementation and repairs. Root integrates its guide/spacing changes, runs combined checks and obtains fresh Astra High review on the exact candidate. The two partner offer facts are approved. Their redemption method and exact eligibility remain unresolved, and authoritative raffle listings remain unavailable. These limits are not permission to invent details.

## Design evidence

Read-only source inspection completed. Commands exited 0. No application checks were run by the design agent. This agent's effective model and effort are not exposed in its available runtime context; root must use its spawn/configuration evidence. Usage is unknown.


## User amendment: discount codes

The user specified code-based redemption and explicitly supplied `XXXX` as the placeholder for both offers. Build the code display and copy interaction now, while keeping it visibly marked as a placeholder that is not valid for redemption. A copy control must say `Copy placeholder` while this value is present, and feedback must only confirm copying. Real membership entitlement, checkout discount application and partner redemption remain outside this screens/navigation slice. The website links are informational visits, not redemption or activation actions. Do not invent expiry, minimum spend, tier restrictions or codes. Later replacing the placeholder with a real code must not silently assert verified membership.

Fantom Labs and SeatMap Pro informational URLs were read-only verified by root: https://www.fantomlabs.io/ and https://seatmap.app/pro. The 5% offer facts come from the user's messages, not those public pages. Design-agent spawn configuration was explicitly gpt-6-astra/high; current root is gpt-6-astra/medium. Runtime attestation inside the child was unavailable.

## Implementation and verification

Source candidate `19e94bc4da7ac9da5b8c1d35f392ab81561e8869` on `design/artwork-first-20261006`, following initial implementation `2857e77f3cc8d3a1045e9f9fa8b800cc4f0519c3`. Guide simplification and shared page spacing are in the preceding `fa07622` commit. No push, main merge or deployment was performed.

Completed membership, two partner-offer cards and detail pages, selectable/copyable placeholder codes, eligibility self-review, Studio preparation/review/edit/reset, account navigation, history and receipt destinations, meaningful missing-page navigation, and discovery links/sitemap. Existing artwork/pack detail layout remains intact. No production sample records were reintroduced. Studio data stays only in component memory; it is discarded on reload and never published.

The first independent review found that a cold email-preferences fragment load rendered the target after browser fragment resolution. Reproduction at 390×844 placed the input below the viewport with scrollY=0. The repair performs one guarded scroll after profile readiness, with spacing for the desktop sticky header. Wallet changes do not repeat it. Visual review also caught inconsistent new tier colors; the overview now matches the existing purple Entry, metallic Bronze/Silver/Gold and #CCFF00 Platinum gradients, uppercase labels and bevel.

Evidence under `artifacts/workflow-screens-20261006/`:

- PASS, `npm test`: 140 tests in 9 files; `npm-test-repair.log`, exit 0. Focused implementation tests cover offer definitions/copy failure handling, Studio state and navigation. Two proposed implementation-mirroring assertions were removed; browser behavior provides the repair evidence.
- PASS, production build/type check: `npm-build-repair.log`, exit 0. Existing ox/viem dynamic-dependency warning remains. Dependencies unchanged.
- PASS, 68 route/viewport combinations at 320/390/768/1440px on initial source 2857e77, plus unknown offer, 200% zoom and reduced motion. `routes.cjs/json/log`, exit 0. Zero page errors or API writes. Unaffected-route evidence remains applicable to the two-file repair.
- PASS, independent browser interaction checks on 2857e77: clipboard success/denied/missing; offer/account navigation; Studio native required validation, keyboard review, editing, resets from both states and reload discard; eligibility local-only behavior; legacy sample discard. `interactions.cjs/json/log`, exit 0. Zero page errors or backend writes.
- PASS, final repaired source: 12 fragment/viewport combinations at 390/1440×844, full email-input visibility, cold/reload/receipt-link landing, ordinary profile and wallet-change no-scroll, keyboard code copy and checkbox operation. `anchors.cjs/json/log`, exit 0. Wallet/API inputs were mocked. No real wallet or chain action was taken.
- PASS, final tier palette, gradients, uppercase and no overflow at 320/390/768/1440px. `palette.cjs/json/log`, exit 0. Final phone screenshot inspected.
- Visual review covered discounts, offer detail, membership and Studio on phone/desktop sizes. T3 Preview now shows the discounts page from the final local build on port3113.

The initial fragment test was too weak and its nominal PASS did not establish correct cold landing; retained as `anchors-initial.*`. The stronger test independently exposed the defect in `email-anchor-repro.json`. One later harness assertion was affected by Playwright auto-scrolling the Connect button before clicking; the no-scroll check now triggers the isolated mocked wallet handler without that automation scroll, with the failed attempt retained in `anchors-autoscroll-failure.log`.

Real discount redemption, entitlement verification, purchase/history integration, physical phone/Safari and real-chain journeys remain NOT_RUN. `XXXX` is deliberately invalid. The two discount percentages are user-supplied; no expiry, minimum spend or eligibility conditions were invented. Live backend/on-chain integration remains a separate task, as explicitly selected by the user.

Independent repair review: PASS for exact source candidate `19e94bc4da7ac9da5b8c1d35f392ab81561e8869` in `review.md`; no remaining blockers within the screens/navigation scope. Initial CHANGES_REQUIRED is preserved in `review-initial.md`. Exact model usage/cost unknown. Local LAN preview is `http://192.168.2.30:3113/discounts`; publication remains pending a new instruction.
