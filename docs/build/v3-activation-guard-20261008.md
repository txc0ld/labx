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

## Recovery refresh repair

The complete browser gate exposed a neutral self-cancellation receipt triggering the generic recovery panel's raffle refresh. The targeted reproduction failed with one unexpected snapshot read while correctly retaining a neutral receipt and clearing the journal. Root approved filtering generic automatic refresh through the existing `transactionMeaning` classifier. Newer recognized raffle receipts still refresh; external token approvals, self-cancellations and unrecognized receipts remain inspectable without an action callback. Explicit refresh remains available, and owned `TransactionFlow` callbacks are unchanged. When a canonical terminal receipt matches the recovery account and nonce, the flow separately rereads the journal. It clears only the same recovery state after a null result in the same wallet scope, without a raffle callback. Late results cannot replace newer recovery input or another action state. No service, journal or confirmation rules changed.

The regression now waits for network activity to settle before asserting that neutral recovery caused no refresh. Browser coverage also checks manual continuation after cold USDC/NFT approval receipts and automatic refresh after a newer recognized purchase. The owner notice distinguishes draft readiness from trust readiness; its guard is exercised on an unapproved escrowed draft and after authority restoration.

The first aggregate browser attempt was interrupted when its agent turn ended; its terminal exit is unknown. Its retained partial log includes the self-cancellation failure. The targeted failure and subsequent repair runs retain explicit exit files under the same external evidence directory. Final aggregate browser verification and independent delta review remain required.


The root's separate actual Geth Amsterdam proof, frozen at `cd0ab012`, records approximately 68.3M gas for the 300-lot total snapshot path, below its 81.95M bound, plus the exact 500,000-gas callback check. Evidence is under the enclosing task workspace's `artifacts/v3-sepolia-activation-20261008/protocol-verification/`. The older 15M total snapshot margin is superseded and is not the current gas proof. Contract and website batch limits remain default 100 and maximum 300.
