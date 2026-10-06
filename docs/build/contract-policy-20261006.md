# Contract policy preflight

Read-only R3 preflight, 2026-10-06. Source candidate `4616a16a2e7258fe6f7f5999452d3580b84af33f`, branch `design/artwork-first-20261006`. This record proposes contract work alongside the partner-card work. No contract source, test, deployment script, chain state or configuration was changed. The delegated writer owns this file only.

Configured reviewer routing is GPT-6 Astra High as supplied by the coordinator. Independent runtime model/effort attestation and token/cost telemetry are unavailable. Applied unslop and karpathy-guidelines; consulted long-task-flow evidence guidance for the existing handoff.

## Result and decisions

The current source has three demonstrated policy limitations, all explicitly covered by existing tests. The owner can cancel a delayed draw after one day before its callback lands. A funded raffle waiting for its first randomness request can need the owner to unlock refunds. An unrevealed winner still needs the owner to settle after the seven-day grace. Passing tests currently confirm these restrictions; they do not establish buyer recovery or fairness without owner cooperation.

Recommend a first bounded slice that allows anyone to settle an unrevealed draw at `drawnAt + 7 days`, preserving the recorded winner and all payment recipients. A second slice can make timeout recovery independent of the owner, but its deadlines and treatment of delayed randomness require an explicit product decision.

The smallest decision set is:

1. Should anyone be able to settle after the existing seven-day reveal grace? Recommended yes. Valid reveal would still allow immediate settlement. The consequence is that the promised disclosure can remain missing, as it already can when the owner uses the current grace override.
2. Should the contract guarantee permissionless refund eligibility after fixed deadlines, even when a genuine randomness result arrives late? Recommended yes if bounded recovery is the product priority. A concrete starting policy is seven days after the published `salesEnd` to start a draw, then the existing one day after the request for its callback. At either missed deadline, anyone can trigger cancellation and each buyer can pull their own principal plus fee. These durations are proposed policy, not measured Chainlink availability guarantees. A seven-day callback window gives delayed results more time but holds funds longer. An indefinite callback window preserves every eventual result but cannot promise bounded refunds.

Approval of these source policies would authorize only the agreed local implementation and checks. Deployment, ownership transfer, consumer registration, funding and release remain separate actions. This preflight is complete; implementation is NOT_RUN pending the policy selection.

## Current state paths and concrete examples

Line references below are for `contracts/src/LabxRaffle.sol` at the candidate above.

| State/path | Current rule | Result |
| --- | --- | --- |
| `Open` to `Closed`, line 492 | Seller or owner can close early; anyone can close at or after `salesEnd`. Pause does not block closing. | The published sales deadline stops purchases but does not itself refund or advance a raffle. |
| `Closed` snapshot, line 552 | Anyone can process 1 through 500 lots per call. No owner permission or unpause is needed. | Completion alone does not start VRF. |
| `Closed` to `Drawing`, line 573 | Seller or owner only, unpaused, completed nonempty snapshot. No latest request deadline exists. | Absent operators, a permanent pause, or a reverting request prevents progress. |
| `Draft/Open/Closed` to `Cancelled`, line 669 | Owner can cancel. Seller cannot cancel funded `Open`, and can cancel `Closed` only with a completed empty snapshot. | Existing immediate owner cancellation of funded raffles is an explicitly accepted v1 power. |
| `Drawing` to `Drawn`, lines 593 and 914 | Pinned coordinator callback, matching request and phase. There is no callback age limit. | A word may currently land after the one-day abort threshold if no abort executed first. |
| `Drawing` to `Cancelled`, line 685 | Owner only at or after `vrfRequestedAt + 1 day`. Clears both request mappings and decrements `activeDrawings`. | Cancellation and late fulfillment compete by transaction ordering. |
| `Drawn` to `Settled`, line 622 | Anyone if revealed; otherwise owner only at or after `drawnAt + 7 days`. | An inactive owner plus missing reveal can lock the recorded winner and all payouts indefinitely. |
| `Cancelled` exits, lines 697 and 707 | Seller pulls NFT; each buyer pulls their own principal and fee. No refund claim deadline. | Cancellation makes funds claimable; a separate successful transaction is still necessary. |
| `Settled` exits, lines 633, 643 and 654 | Winner pulls NFT, seller pulls principal, anyone sends fee to current treasury. | Settlement does not send assets to its caller or require an NFT transfer to succeed. |

Delayed-outcome example: Alice and Bob each pay 30 USDC. After one day, a pending callback would select Alice. The owner orders `abortDrawing` before that callback. Both request mappings clear, the callback returns without recording a winner, both buyers recover 30 USDC, and the seller can reclaim the NFT. This suppresses the award; it does not steal either buyer's principal or reroll the same raffle. If the callback lands first, the phase is `Drawn` and abort reverts. `test_policyOwnerCanDiscardDelayedOutcomeAfterAbortTimeout`, test line 1155, models this ordering. It is a local model, not observed live abuse.

Funded pre-request example: Alice pays 30 USDC, the seller closes, and a nonempty snapshot finishes. The owner pauses and becomes unavailable. Thirty days later the seller cannot request VRF or cancel, Alice cannot cancel or refund, and the NFT cannot be reclaimed. Owner cancellation still recovers the money when the owner returns. `test_policyPausedFundedSnapshotNeedsOwnerForRecovery`, test line 1187, proves this. Without a pause, inactive seller and owner also leave the same request authority gap. A request call that reverts rolls back to `Closed`, so insufficient or unusable request configuration belongs to this recovery phase, not to the post-request abort timer.

Post-draw example: Alice wins, the commitment remains unrevealed, and the owner stops transacting. Even 37 days later Alice cannot settle, claim the prize or refund. The seller cannot reclaim a drawn prize. The owner can still settle. `test_policyUnrevealedDrawNeedsOwnerAfterGrace`, test line 1212, proves this. A seller with the valid reveal data can also resolve it by revealing; the stuck case assumes that reveal is unavailable or withheld.

## Coherent recovery options

| Policy | Benefit | Cost or remaining trust |
| --- | --- | --- |
| Preserve current owner abort and unlimited callback age | Smallest behavioral change; delayed callbacks can still win until an abort executes. | Owner discretion and recovery dependency remain. Longer timeout alone does not remove them. |
| Make abort permissionless but continue accepting every late callback | Anyone can recover when the owner disappears. | Every losing participant can race a delayed callback after the timeout. This expands outcome suppression authority and is not recommended as an isolated fix. |
| Fixed callback expiry plus permissionless cancellation | Outcome acceptance depends on the precommitted deadline, not whether a cancellation caller acts first after that deadline. | Every late outcome is rejected. Network censorship or delayed inclusion around the deadline remains a fairness assumption. |
| Remove timeout cancellation and wait for the original callback forever | No contract cancellation can discard a requested result. | Failed or absent callback can lock funds forever. This requires a substantially different recovery design if bounded refunds are also required. |

For fixed expiry, define callback validity as `block.timestamp < vrfRequestedAt + timeout`, and cancellation eligibility as `block.timestamp >=` the same value. Reject the expired outcome even when nobody has called cancellation. Retain a permissionless cancellation call that clears request bookkeeping exactly once; do not require the callback itself to transfer assets or perform recovery. A callback before the deadline fixes the winner and permanently removes refund eligibility. A callback at or after the deadline cannot revive the award. Transactions near a deadline remain subject to block inclusion and timestamp rules; this is not a censorship-proof draw.

For the pre-request deadline, use immutable published `salesEnd + grace`, not the moment someone chooses to close or finish a snapshot. The suggested seven-day grace keeps all allowed request times well before the existing 365-day lot expiry because sales are capped at 180 days. At the cutoff, block new VRF requests and permit anyone to cancel `Open` or `Closed`, including unfinished and empty snapshots, while paused or unpaused. This handles seller inactivity without requiring a helpful actor to execute `close` first. If requests remain valid after the cutoff, a last-minute request can defeat the advertised recovery deadline.

These two clocks cover different failures. `salesEnd + grace` covers failure to obtain the first request. `vrfRequestedAt + timeout` covers a request that was accepted but has not produced an accepted callback. A request before its cutoff may finish after the pre-request cutoff, within its own callback window. Neither clock resets on a retry because retries remain disabled.

Keep buyer refunds as self-service pulls with no claim expiry. Anyone may trigger the phase transition, but that caller receives no buyer funds. Permissionless `refundFor` or alternate payout addresses are unnecessary for these fixes and would add a separate authorization decision.

Preserve the documented immediate owner cancellation of funded `Open/Closed` raffles in this bounded proposal. Removing it or requiring pause plus a timelock would change an accepted v1 authority and needs a separate decision. Its continued existence must remain disclosed; the proposed recovery paths do not make all owner powers trustless.

## Existing fixes and evidence

Historical reports must be read in sequence. `SECURITY-REVIEW.md` begins with a review of `536d7ec`; its body describes several obsolete behaviors. Its later Chain Security response introduced retry, and its final 2026-10-05 follow-up supersedes that retry response. Source commit `c2198e9` disables retry and rejects undeployed Safe targets. Commit `6722b96` adds the current authority-boundary tests. Later refresh, main-release and remove-samples reports retain those policy limits. Current code is authoritative when an earlier report disagrees.

- Retry already always reverts at source line 589, preserving ABI compatibility. Tests at lines 909 and 945 verify request identity, timer, coordinator and winner cannot be replaced by retry. Do not reintroduce retry to address availability.
- AMOE already checks a per-raffle cap, one claim per account, globally single-use captcha digest, deadline and signer at source line 535. The current server authorization/recovery fixes are a separate established history. This preflight identifies no new AMOE defect and does not reopen old resolved findings.
- Coordinator/config/payment changes already reject active drawings. Pinned callbacks, synchronous callbacks, replay behavior, refunds, sticky NFT independence and two-raffle solvency already have tests.
- Test lines 839 and 889 cover abort/refund and request cleanup. Line 961 models an absent callback then timed abort and refund; it does not execute a real coordinator out-of-gas failure. Line 413 covers the current owner grace override. Three fuzz tests cover exact fee credit, weighted winner/replay and two-raffle accounting.
- `git diff --exit-code 024f4d9 4616a16 -- contracts` returned 0. Historical main-release evidence therefore applies to unchanged contract inputs: 50 tests passed, including three fuzz tests at 1,024 runs each; runtime 21,688 bytes. Full log at `artifacts/main-release-20261006/contracts-tests.txt`.
- Coordinator-owned fresh baseline `FOUNDRY_FUZZ_RUNS=1024 forge test` passed with exit 0, as confirmed by the coordinator. The inspected log `artifacts/partner-brand-contracts-20261006/contracts-baseline.log` reports 50 passed, zero failed/skipped, with 1,024 runs for each of the three fuzz tests. This reviewer did not duplicate the suite.
- Local tool discovery returned `/home/tx/.foundry/bin/forge`, Forge 1.5.1-stable. `contracts/foundry.toml` pins Solidity 0.8.24, optimizer 200, `via_ir = true`, Cancun. Commands are available; no deploy script was executed.

Contract hashes observed before writing this document:

```text
047a80d00333e86ca5a06b0107d7c16ae464878b39258c4c06f2844985d72e05  contracts/src/LabxRaffle.sol
297c1fbf5bdfe5437fa4c10f2cdad24b3d1fa48eb3211d3ac4e50f64b52ed20d  contracts/test/LabxRaffle.t.sol
f2ecdbecb0f5a8bfb7c31bc828216097bc7cc1cc3cc045fbeeedc2ef66cdda00  contracts/script/DeploySepolia.s.sol
e56b810866607f26a5f8557ed88e2070be160e35cae599738c08ef953fa59c19  contracts/test/DeploySepolia.t.sol
```

No new purely mechanical implementation defect was demonstrated in this limited preflight. Each recommended behavior change above alters authority, winner finality or custody timing and must remain explicit R3 policy work.

Final read-only checks passed with exit 0: `git diff --check` and `git diff --exit-code -- contracts`. All four hashes above remained identical after writing this report. Concurrent UI changes were preserved. One discovery command initially used the workspace parent rather than the repository for `git log`; it failed with “not a git repository,” then succeeded from the correct directory. That command made no changes.

## R3 implementation contract after selection

The coordinator records the accepted policy and design before appointing the required critical implementation owner. Implement and verify the settlement slice first; then implement the timeout slice against explicit chosen durations. Keep production edits serialized and independent verification separate. No agent in this preflight spawns another agent.

Required invariants:

1. A raffle has at most one accepted randomness request and one recorded winner. Retry cannot create, replace or extend either.
2. Exactly one final financial route is reachable: settlement pays the seller/treasury and awards the recorded winner, or cancellation refunds buyers and returns the prize to the seller. A late/replayed callback cannot cross that boundary.
3. After reveal grace, settling cannot redirect the winner, principal or fee. Before grace, the existing reveal requirement holds.
4. Under fixed-expiry policy, no caller can extend either deadline or accept a word at/after its cutoff. Request and pre-request-cancellation eligibility never overlap.
5. Once a configured recovery deadline passes, an arbitrary caller can enable refunds without owner/seller cooperation, an unpause, a working coordinator, or a successful NFT transfer. This promises claim eligibility, not automatic transaction inclusion or a token issuer overriding its own blocklist.
6. Every refund returns that buyer's recorded principal plus fee once, subtracts the corresponding raffle liabilities, and leaves other raffles backed. Payout failure rolls back that payout's accounting.
7. `activeDrawings` and both request mappings change exactly once for each successful exit from `Drawing`. Expired-but-not-cancelled drawings can still count as active until someone executes cleanup; any caller must be able to do so.
8. Existing nonreentrancy, mainnet restriction, coordinator pinning, configuration locks, payment mode, AMOE authorization and documented owner cancellation behavior remain intact.

Independent verification should design tests before reviewing the implementation. Cover deadline minus one second, exact deadline and plus one second for request, callback, abort and settlement; buyer, seller, owner and unrelated callers; pause on/off; revealed/unrevealed; empty, partial and complete snapshots; coordinator request revert; no callback; late callback before and after cancellation; both callback/abort transaction orders; duplicate callbacks and repeated cancellation. Preserve synchronous callback tests. Check two simultaneous raffles, liability conservation, failed token/NFT pulls and replay of each claim. Replace the three policy tests' expectations only where an approved requirement changes them, keeping their adverse scenarios.

Run focused tests during repairs, then `forge fmt --check`, `forge test --fuzz-runs 1024` and `forge build --sizes` on the combined final candidate. Add bounded stateful/sequence fuzz coverage if verification identifies gaps in the new cancellation orderings. Inspect affected web ABI/status consumers if function signatures or exposed structures change. Avoid unnecessary ABI changes for the settlement slice. Record exact revision, command exit statuses and artifacts. A fresh independent Astra High review must inspect actual code, dependent state paths and test evidence. Revalidate affected evidence after repairs.

## Deployment and scope limits

`DeploySepolia.s.sol:23` accepts only chain 11155111. It checks deployed code at the intended Safe at line 65, creates the contract with the deployer as owner, and proposes the Safe at line 52. That does not validate Safe implementation/signers or complete `acceptOwnership`. Consumer registration is a separate script at line 70. Existing tests confirm code-presence behavior, including that arbitrary deployed code passes the limited check.

Repository notes describe an older Sepolia deployment with LINK billing. No live address, balance, subscription, Safe or bytecode was checked here, so those notes are historical operational context. Source fixes do not modify an existing deployment. No live probes, broadcasts, funding, ownership changes, broad static scan or full audit was performed. A qualified human release decision and any required independent audit remain necessary before an authorized R3 release.
