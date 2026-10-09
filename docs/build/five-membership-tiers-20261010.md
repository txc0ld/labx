# Five membership tiers

Base: `95044051d4ddf967e15ad186269e3078f1cd403b`.

New seller drafts use Entry, Bronze, Silver, Gold and Platinum in that order. Their names and count are fixed. Sellers supply each tier's price, bonus entries and available quantity; the form does not invent economic defaults. The action boundary rejects nonstandard creates and checks the latest saved configuration before allowing an existing canonical draft to change.

Existing raffles retain their actual membership names, order and count. Sellers can still repair expired legacy drafts with one to eight packs. Raw saved names, including whitespace, remain unchanged. Buyer purchases continue using the original pack indices. This is a website rule: the deployed contract's one-to-eight-pack limit is unchanged, and this release performs no on-chain action.

## Verification

The repaired production source at `4498d3ad92d26f7e783fca0e5de46bc2038d8f51` passed the production build and the chain-enabled aggregate, with 646 passing tests and 62 browser tests skipped in that command. Astra independently reviewed that source. Separate independent tests passed five policy cases and a browser journey covering creation, expired legacy repair, exact raw names, keyboard navigation, reduced motion, zoom and 320, 390, 768 and 1440 CSS-pixel widths.

Independent review found and repaired legacy-name trimming, a stale Gold fixture index and indistinguishable fixture economics. A later focused browser check reproduced a long legacy name clipping at 320 pixels. Its repair and the final browser/release checks are tracked in the task evidence; this document does not claim those checks or deployment succeeded before their recorded results.

Physical-device testing was unavailable: iOS requires macOS/Xcode and the Android emulator failed to boot. Browser emulation is recorded separately from physical-device evidence.

Full commands, exit statuses, review verdicts, screenshots and exact release bindings are under the task workspace's `artifacts/five-membership-tiers-20261010/`. The checkpoint and final release record distinguish source verification from hosted CI and live functionality. Model usage is unknown except where the Claude CLI records it.
