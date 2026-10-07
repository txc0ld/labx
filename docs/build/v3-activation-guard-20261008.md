# V3 activation guard

Base release: `0bb6f820f44cb04fe293558727a3ac74797bbf26`. The website previously verified runtime identity but did not bind later purchases to reviewed authority and the policy frozen at opening.

Manifests now require `expectedOwner` and all eleven ABI-derived `expectedPolicy` members. Browser and server local-manifest parsers share strict validation. Runtime attestation remains independent of mutable trust settings.

| Action | Additional trust checks |
| --- | --- |
| Approve raffle, open | Expected current owner, no pending owner or coordinator, exact current opening policy |
| Quote, approve USDC, purchase | Expected current owner, no pending owner, approval at opening by expected owner, exact frozen raffle policy |
| Reads, editing, revocation, draw, settlement, claims, refunds, private records and transaction reconciliation | Existing identity and contract permissions; no new mutable trust gate |

Trust reads use the action's pinned block and recheck its hash. Submission and owner export repeat validation through the existing action rebuild. The UI presents trust failures separately so recovery remains usable. Correctly pinned older raffles remain purchasable after future opening settings change.

`APPROVED_DEPLOYMENTS` remains empty. No Solidity, fee policy, journal or deployment change is included. Activation still requires independently verified user-signed deployment and configuration receipts. The website does not prove Safe internals, NFT authenticity, reserve subscription funding or prevent later on-chain changes.

Evidence is under `artifacts/v3-sepolia-activation-20261008/activation-builder/` in the enclosing task workspace. Aggregate unit/integration checks passed 468 tests across 45 files, with 49 browser-gated tests skipped. The focused guard/parser suite, including independent regressions, passed 77 tests. TypeScript and production build passed. The two new browser tests passed at 375px and 1440px without horizontal overflow, including owner revocation/confirmation and authenticated private commitment recovery under trust drift. The complete existing browser regression lane and separate final review were pending when this record was written. The first cold browser startup exceeded the existing 30-second fixture bound before assertions; its failed log is retained. Local Anvil/Forge 1.5.1 results establish behavior only, not current Sepolia gas ceilings. The root's separate packet verification owns current-protocol gas evidence.
