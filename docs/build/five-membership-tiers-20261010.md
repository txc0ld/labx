# Five membership tiers

Base: `95044051d4ddf967e15ad186269e3078f1cd403b`.

New seller drafts use Entry, Bronze, Silver, Gold and Platinum in that order. Their names and count are fixed. Sellers supply each tier's price, bonus entries and available quantity; the form does not invent economic defaults. The action boundary rejects nonstandard creates and checks the latest saved configuration before allowing an existing canonical draft to change.

Existing raffles retain their actual membership names, order and count. Sellers can still repair expired legacy drafts with one to eight packs. Raw saved names, including whitespace, remain unchanged. Buyer purchases continue using the original pack indices. This is a website rule: the deployed contract's one-to-eight-pack limit is unchanged, and this release performs no on-chain action.

## Verification

The final production source matches `2b6c1683d305c5475dd1bfe1dccc42bbc53744d6`. Its production build passed, and its chain-enabled aggregate passed 651 tests with 63 browser tests skipped in that command. Astra approved integrated source candidate `0553d8e5a193e88c40d3709e46e062778f8e019b`; the subsequent `1c366572168af2a63d345d5ab20476717110c821` changes only two test-fixture values.

The full browser run on the earlier repaired candidate passed 60 tests and exposed two stale test assumptions: a three-pack sold-count array and a fixed 64-Tab traversal budget. Both were corrected. A separate integrated run at `0553d8e` then passed all five tests across the affected buyer, NFT picker and independent five-tier suites. The final distinct-price/bonus fixture passed its complete browser journey independently. These are separate runs, not an invented single aggregate.

Independent policy tests cover invalid direct creates, fresh-state canonical update enforcement, expired legacy one/two/eight-pack repair, raw whitespace names and original buyer indices. Browser checks cover creation, saved-draft repair, exact raw names, keyboard navigation, reduced motion, zoom and 320, 390, 768 and 1440 CSS-pixel widths. The reproduced 32-byte legacy-name clipping now passes a specific legend-bounds check at 320 pixels.

Review findings included legacy-name trimming, stale fixture indices, indistinguishable fixture economics, long-name wrapping and fragile keyboard traversal. Each accepted finding has a repair and verification record. Claude's final scoped verdicts, hosted CI, deployment identity and live smoke results are recorded in the release evidence after completion.

Physical-device testing was unavailable: iOS requires macOS/Xcode and the Android emulator failed to boot. Browser emulation is recorded separately from physical-device evidence.

Full commands, exit statuses, review verdicts, screenshots and exact release bindings are under the task workspace's `artifacts/five-membership-tiers-20261010/`. The checkpoint and final release record distinguish source verification from hosted CI and live functionality. Model usage is unknown except where the Claude CLI records it.
