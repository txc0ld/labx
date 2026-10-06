# Remove sample data and wording

Status: complete locally. Implementation, verification and independent repair review passed. Base/source and main release `024f4d983d9c6d7b6a579b8da9fbc2fecbae00b5`. Current request is to remove all demo data and wording from the website. The previous main push is complete; this change has no new explicit publication instruction.

R1 removal of simulated frontend behavior. Root Astra High owns this contract; one Sol builder owns the bounded implementation and tests, followed by fresh independent Astra High review. No contract, backend API, authorization, receipt or server-storage changes. No chain transactions or new live integration. Earlier unresolved real-value policy decisions remain separate.

## Acceptance contract

- Runtime catalog starts empty. Remove bundled synthetic raffles, fallback wallet, synthetic entries, winners, commitment values and simulated lifecycle/purchase writers. No relabeling sample data as live. Move any necessary test records to test-only fixtures.
- Stop reading arbitrary listings/activity/agreements from legacy labx-bench-v1. Remove those saved simulated records after safely preserving a valid email. If preference storage cannot be written, retain the last durable legacy email copy for a later retry, show a cleanup-pending notice, and never hydrate any old activity. Preserve only a validated string email preference in a separate preference key, retaining an already saved newer preference on repeated migration. Never restore old wallet identity as a connected wallet. Malformed/unavailable storage must not crash or restore samples.
- Preserve supplied artwork files and existing responsive design, logo, fonts, animations and reusable raffle/pack components. Empty collection uses concise 'No raffles listed' copy and guide link. Existing sample detail URLs show an honest unavailable state. Unconnected workflows cannot create records or ask for agreement/signature/payment.
- Remove customer-visible demo/demonstration wording, including ARIA labels, metadata, guide and generic animated button fallback. Source-only vendor component names, historical reports and test fixture names are not customer wording and need not be mechanically renamed.
- Studio shows concise unavailability for listing tools; remove fake preset NFT/date and simulated phase controls. Rules retain rules copy and an unavailable complimentary-entry state until a real listing integration exists. Do not modify authenticated backend AMOE APIs. Profile keeps actual Sepolia wallet connect and email preference only; it must not invent balances, entries or agreements. Unretrieved history is unavailable, not an asserted zero. Points errors/loading remain distinct from a fetched zero.
- Keep the developed detail/pack layout for future authoritative records, but disable/remove its simulated purchase callback. Any retained CTA says purchasing is unavailable and cannot record a success. Preserve native accessibility.
- Guide describes the intended contract flow and clearly states website listing/purchase/history tools are not connected yet without using demo wording or claiming launch readiness. Fairness has an explicit empty state. Update privacy's browser-storage description to match email-only preferences. Correct any touched unverified Safe configuration claim to intended authority, without broad legal rewrites.
- Verify migration fresh/legacy/malformed/storage-unavailable/idempotent cases, existing web aggregate tests/build/audit, browser empty states/all routes/no customer-visible demo wording/old URLs/refresh/back/mobile/keyboard/navigation, and no synthetic records or signatures/transactions created. Reuse unchanged contract evidence from main release.

Evidence: artifacts/remove-samples-20261006/. Usage/cost unknown. No subagent may spawn agents; one source writer at a time.


## Candidate and results

Source candidate: `a588fd95ab0c39b0755a6e2562d7a36f31d2de4b`, following initial implementation `f6ec4dece88f806a2e36342a5001604e0d009f36`, on `design/artwork-first-20261006`. A documentation-only closeout commit may follow. No new push or deployment was performed. Remote main was rechecked and remains `024f4d983d9c6d7b6a579b8da9fbc2fecbae00b5`.

Runtime sample listings, fake wallet fallback and simulated entry/lifecycle writers are removed. Customer-visible sample wording is removed from pages, metadata, accessibility labels and the generic button fallback. Necessary example records are isolated in test fixtures. Listings and unconnected workflows now show unavailable states. The empty catalog reflects the missing authoritative website listing integration, not a fresh claim that the chain has zero raffles.

The initial independent review found two defects. A failed preference write could lose the saved email, and an earlier wallet request could overwrite the current wallet's displayed points. Both were independently reproduced, repaired and retested. Storage now retains the last valid email until migration succeeds, retries cleanup, and never restores sample activity. Points results and rendering are tied to the current wallet/request, and stale requests are invalidated.

Evidence under `artifacts/remove-samples-20261006/`:

- PASS, final web aggregate: 132 tests across 8 files, exit 0, `repair-web-tests.log`.
- PASS, final production build including type checking, exit 0, `repair-web-build.log`. Existing ox/viem dynamic-dependency warning remains.
- PASS, production dependency audit: 0 reported vulnerabilities, `web-audit.log`. Dependencies are unchanged by this task.
- PASS, final browser process exit 0: 13 routes at 320, 390, 768 and 1440px, `browser.cjs`, `browser.json`, `browser-output.txt`. Verified empty catalog and old detail URLs, visible/accessibility wording, no horizontal overflow, uppercase headings, legacy/malformed/blocked storage, preference persistence, footer links, asserted keyboard skip/focus/guide activation and email submission, back navigation and reduced motion. Zero page errors, API writes or unconnected points requests.
- PASS, independently reproduced storage failure/recovery and reversed wallet response order, exit 0, `review-repair.cjs`, `review-repair.json`.
- PASS, points loading, fetched zero, error and retry recovery, exit 0, `points-states.cjs`, `points-states.json`. Wallet/provider and API responses were mocked in isolated browser contexts; no real wallet, signature or transaction was used.
- PASS, independent whitespace and unchanged-boundary checks. Backend routes, wallet module, points/storage modules, dependencies, contracts and artwork files are unchanged. Historical main-release contract evidence remains applicable: 50 tests, including three fuzz tests at 1,024 runs each. Contracts were not rerun for these frontend-only changes.
- Browser screenshots inspected for mobile and desktop layout. Full-page captures include unchanged scroll text caught between animation positions.

Two browser harness attempts failed on test assumptions, with no application defect: the reduced-motion check ran on the wrong route after history navigation, and a broad alert selector also selected the Next route announcer. Corrected checks passed; failed output is retained in `browser-navigation-failure.txt` and `points-states-locator-failure.txt`.

Local production preview serves the candidate at port 3113. T3 Preview was refreshed to `http://172.21.227.101:3113/`. The configured private-LAN proxy is `http://192.168.2.30:3113/`; Windows HTTP 200 was observed earlier in this task. Physical phone, Safari, live wallet and on-chain journeys are NOT_RUN. Production was not updated. Listing, purchase and history integrations remain unavailable, and the previously documented contract policy/operational blockers remain unresolved.

Independent review: PASS for exact source candidate `a588fd95ab0c39b0755a6e2562d7a36f31d2de4b` in `review.md`; initial findings preserved in `review-initial.md`. No remaining release-blocking source findings within this task scope. Configured builder/reviewer roles followed the project policy. Exact agent usage and cost are unknown.
