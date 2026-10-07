# Permissionless draw start and bounded snapshots

## Candidate and authority

Base is `7f91678d9c4501cae0faaad1d6b9cf49d52de0e7` on `work/permissionless-draw-20261007` in `labx-permissionless-draw`. It combines native-VRF candidate `f3b3355971109c212f56d36b44515752915fda52`, WalletConnect integration `923c72c` cherry-picked as `ade37b8`, and the image-only Fantom card patch `7f91678`. Initial working tree is clean. Critical builder is the sole writer. Configured role is GPT-6 Astra High; runtime usage telemetry is unavailable.

User explicitly authorized anyone to trigger the single finalized draw after sales close with the existing fixed configuration and subscription. Root assigned the snapshot gas cap repair based on independent adjudication. No deployment, push, public-chain operation, signing, external settings changes or additional agent creation is authorized. Other worktrees and server 3127 remain untouched.

## R3 preflight and invariants

1. Remove only the seller/owner check in `requestRandomness`. Calls still require Closed, a completed nonempty snapshot, and timestamp strictly before `salesEnd + 7 days`. Anyone, including a buyer or unrelated caller, may trigger that request while paused or unpaused.
2. The caller supplies only the raffle ID. Opening-pinned coordinator, key hash, subscription, billing mode, confirmations and callback gas remain authoritative. No caller can change settings, winner, entries, sales deadline or request deadline.
3. A successful request leaves Closed. Repeated request calls cannot consume another randomness request or reroll. Coordinator/request correlation, reused-ID rejection and synchronous callback behavior stay unchanged.
4. Draw-start, randomness and reveal grace periods remain seven days. Exact-cutoff request rejection, permissionless cancellation/abort, principal-plus-fee refunds, settlement and claims retain their existing guarantees.
5. All other privileges remain unchanged, including seller draft/open/escrow rights, seller/owner reveal, owner defaults/pause, disabled retry and payout recipients.
6. Cap each snapshot call at 300 lots, down from 500. Zero and values above 300 revert without changing progress. Partial snapshots resume exactly and cannot authorize a draw. Keep both website batch defaults at 100, and align the preparation guard with 300.
7. Wallet/account/network/revision, approved-deployment, transaction simulation and pending-journal checks remain authoritative. Only action availability for requestRandomness changes. The empty approved-deployment registry still prevents unreviewed contract writes.

Threat assumptions remain those documented in SECURITY.md. Arbitrary callers may race to trigger a valid draw or timed refund, but cannot choose its configuration or extend fixed deadlines. Coordinator/NFT/USDC trust and subscription funding are unchanged. NFT allowlisting and constructor/activation redesign are explicitly out of scope.

## Gas acceptance

Independent adjudication measured 500 fresh lots at 23,202,364 external-call gas, above Sepolia's 16,777,216 EIP-7825 transaction cap. The 300-lot result was 13,958,335; the website 100-lot default was 4,715,700. Source evidence is in the separate `labx-claude-contract-verify/contracts/artifacts/claude-contract-adjudication-20261007/report.md`.

Regression tests must measure the new maximum with cold contract storage, preserve cursor/weight correctness, and assert the external-call cost plus intrinsic/calldata allowance remains below 15,000,000 gas. That leaves at least 1,777,216 gas below the protocol cap. Also check rejected 301/500 calls leave the cursor unchanged and a 300+remainder sequence completes.

## Checks and handoff

Run aggregate Forge tests with 1024 fuzz runs, format checks scoped to changed Solidity files, aggregate web tests, TypeScript and production build on the combined candidate. Add contract regressions/fuzz for outsider/buyer success, early/incomplete/empty rejection, pinned policy, exact-cutoff refund and repeated request rejection. Web tests exercise production action availability and preparation, including 300/301 bounds and retained role checks. Preserve the inherited WalletConnect and Fantom changes in all combined checks.

Independent verification and a fresh Astra High review must inspect the frozen final revision. This builder cannot approve its implementation. Browser/production/deployment readiness is not inferred from source checks.

Rollback is reverting this bounded source change before deployment. Existing deployed immutable contracts are not upgraded by these edits. The unsigned deployment packet for `f3b3355` is stale after this bytecode change and must never be represented as a packet for the new candidate. A later release requires regenerated artifacts and qualified human approval.

Evidence belongs in ignored `artifacts/permissionless-draw-20261007/`. The public WalletConnect configuration may be copied to ignored `web/.env.local` with mode 0600 without printing it. No production secrets are needed.

## WalletConnect accessibility repair preflight

Root's browser QA on WalletConnect candidate `923c72c` verified desktop/mobile QR, cancellation, retry and a held-chunk cancellation race. It found unnamed AppKit header buttons, an unnamed mobile certified-wallet checkbox, and focus returning to BODY. Root approved this bounded repair in the combined tree. Original candidate and its server remain unchanged.

AppKit 1.8.19 exposes no supported label options for these shadow-DOM controls. The compatibility helper is scoped to the active `w3m-modal` and its open shadow roots. It labels the actual native header buttons, native certified-wallet checkbox and existing dialog card. The known non-native QR icon receives button semantics and single keyboard activation. The helper preserves SDK click handlers, provider behavior, pairing data and existing native roles. It observes dynamic children and known custom-element upgrades; retirement disconnects observers and keyboard listeners. A late open completion cannot attach a retired helper.

Owned React connection controls capture the initiating button. Only the latest pending status for that attempt may restore focus, after controls become enabled. If successful connection replaces that button, focus goes to the surviving control in the same group. Older attempts cannot steal focus from a newer attempt.

This repair intentionally couples to the pinned AppKit DOM. An SDK upgrade requires rerunning both the Chromium shadow fixture and actual desktop/mobile modal accessibility checks. Optional analytics remain disabled; upstream mandatory initialization/configuration traffic after an explicit click is not removed or represented as zero traffic. No additional passive initialization was added.

The committed Chromium fixture is `web/test/walletconnect-accessibility.browser.cjs`. It uses the existing local Playwright/Chromium installation, overridable with `PLAYWRIGHT_PACKAGE` and `CHROMIUM_EXECUTABLE`. Run `node web/test/walletconnect-accessibility.browser.cjs` from the repository root. It performs no network pairing and verifies actual shadow roots, native control names, dynamic replacement/upgrades, QR keyboard activation, outside-scope preservation and cleanup. Actual SDK axe/focus QA belongs to the root reviewer and remains a separate gate.

## Implementation checkpoint

Contract/policy candidate is `6ed7707a42ecbc0d81fc67515895957b20281627`. Aggregate contracts passed 92 tests with 1,024 fuzz runs; combined web/Anvil tests passed 207 with four browser-only tests skipped. Cold 300-lot snapshot measurements and final combined evidence are stored in `artifacts/permissionless-draw-20261007/`. Later accessibility edits leave the contract blobs unchanged. The old unsigned deployment packet remains stale.
