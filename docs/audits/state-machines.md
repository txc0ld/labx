# State machines

Date: 10 November 2026. This is a source and test audit by AI agents, not a formal security audit. Nothing here was verified against a real wallet, a real Safe, real VRF or the production deployments.

## Scope and method

The app has one explicit state machine, the raffle `Phase` in `contracts/src/LabxRaffle.sol`. Everything else is implicit: state spread across storage fields, store keys, browser storage, refs and timestamps. This file documents both kinds in three parts, each with states, invariants, transition tables and the illegal combinations that were checked:

1. Contracts and deploy tooling.
2. Server and draw runner.
3. Browser client.

It builds on the audit of 7 November (`docs/build/implicit-state-machines-20261107.md`, defect IDs A to E) and records which of those defects are now fixed. A lead counts as a confirmed bug only when a deterministic test drove the real code through the sequence and observed the invalid state. Each fix has a regression test that failed before it and passes after. Every code change was reviewed independently against the exact diff before it was merged; where a review rejected a fix, the part says so.

Severity: high means a duplicate or unrequested transaction, or money at risk. Medium means a user or the operator is stuck until someone acts or the page is reloaded. Low means extra clicks, cosmetic or operator inconvenience.

Line references are to the commit each part was written against (`2078b82` for contracts and server, `54f317e` for the client); later merges shifted some lines.

## Confirmed findings, by impact

| Rank | Part | Finding | Severity | Status |
|---|---|---|---|---|
| 1 | Contracts C1 | A collection whose `safeTransferFrom` does not check `from` lets anyone take a prize the contract holds, in any state | high, conditional on the collection | Open. The contract is deployed and immutable. Controlled at admission; owner decision pending on a redeploy |
| 2 | Client 1 | After a wallet error carrying only a bare code, Create forgot the draft step's nonce and could send `createRaffle` twice | high, narrow | Fixed (PR #31) |
| 3 | Client open issue 3 | Create sends a second draft when the creation log is not found on a lagging node | high, narrow, gas only | Confirmed by review, not fixed |
| 4 | Server 1a, 1b | The draw runner could send a step twice after a stale read or when its pending transaction was mined during the estimate | high, small amounts | Fixed (PR #29) |
| 5 | Server 2 | A runner replacement lost in transit leaves the stuck transaction unreplaced | medium | Confirmed, not fixed. Three attempted fixes failed review and were withdrawn |
| 6 | Server 3 | A delivery reservation dated ahead of the reader's clock was treated as expired, permanently for admin alerts | medium for alerts, low for receipts | Fixed (PR #29) |
| 7 | Client 2a | A send replaced or dropped after the one-minute watch left checkout on "Still confirming" | medium | Fixed (PR #31) |
| 8 | Client open issue 4 | A second tab keeps a stale row that pauses its actions after another tab settles the send | medium | Confirmed by review, not fixed |
| 9 | Client 2b | The same control kept waiting when another tab confirmed first | low | Fixed (PR #31) |
| 10 | Contracts D1 | A deploy driver killed during stage 2 lost track of its CREATE transaction | low | Fixed (PR #30) |

Related fixes from the same day's frontend consistency audit (checkout stuck after an approval, a third wallet prompt, a stale background read) are in `docs/audits/frontend-consistency.md`.

## Issues grouped for follow-up

1. Escrow provenance in the contract (rank 1). Needs the owner's decision: admission control only, or a redeploy with a check in `escrow`.
2. Runner send path (rank 5, plus the three known limits listed in the server part): record a transaction's hash before broadcasting it, treat every recorded hash for a nonce as the runner's own, and pin the read, the estimate and the nonce to one block. Needs a design review before code.
3. Create recovery (rank 3): replace the log-range conclusion with one that cannot be fooled by a lagging node.
4. Cross-tab outcome rows (rank 8): decide whether a tab drops a row whose checkpoint has gone.

## Test results at the merged state

Each part lists its own commands and counts. CI passed on the head of each merged pull request (#28 to #31): web, contracts, chain integration, mainnet fork and both browser acceptance lanes. Lanes that a part marks NOT_RUN were not run for that part.

## State machines: contracts and deploy tooling

Part of the state machine audit of 10 November 2026, based on main at 2078b82. This part covers
`contracts/src/LabxRaffle.sol` and the deploy tooling in `contracts/script/`. It builds on the audit of 7 November
(`docs/build/implicit-state-machines-20261107.md`, defect IDs E1 to E8).

`LabxRaffle.sol` is deployed on mainnet and immutable. Nothing under `contracts/src/` changed in this work. Contract
findings carry a test and an operational mitigation. Tooling findings carry a fix and its before and after result.

Line references are to `contracts/src/LabxRaffle.sol` unless a path is given, and to the tree at the head of branch
`audit/state-machines-contracts-20261110`.

### Summary

| ID | Severity | Where | What | Status |
|---|---|---|---|---|
| C1 | high, conditional | `LabxRaffle.sol:520-528`, `835-843` | A collection that does not check `from` lets anyone re-escrow a held token and take a live raffle's prize. | Open. Contract cannot change. Mitigation below. |
| D1 | low | `contracts/script/mainnet-deploy.sh:138-147` | A driver killed outright during stage 2 left forge's run file unkept, unused and then deleted. | Fixed in f7bb36a. |

No other invalid state or transition was reached. The transition table below was executed cell by cell, and a stateful
invariant run with a model of every guard found no disagreement in 38,400 calls.

E1, E2, E3, E7 and E8 are fixed. E4 is fixed with one residual question (A3). E5 is accepted as dead code. E6 was
refuted on 7 November and nothing found here reopens it. Details are under "Status of E1 to E8".

### How the evidence was produced

- `contracts/test/StateMachine.t.sol` builds a raffle in each of 19 states and calls each of 21 lifecycle functions
  from it, as the most privileged caller for that function, with and without pause. 399 cells per pass. Each cell
  asserts revert or the resulting phase, and that a one-shot call reverts when repeated. The same file holds the
  targeted attack orderings.
- `contracts/test/StateMachineInvariant.t.sol` is a Foundry invariant run. Its handler calls create, edit, escrow,
  approve, revoke, open, buy, close, snapshot, request, callback (four ways), abort, cancel, reveal, settle, the three
  claims, reclaim, refund, ten owner actions, warps and unsolicited USDC transfers. Two owners, two sellers, four
  buyers, an outsider, two coordinators, up to six raffles. Before each call it predicts the outcome from the guards
  documented here and fails if the contract disagrees. The run uses fail-on-revert, so the handler itself never reverts.
- `contracts/test/DeployMainnetHandoff.t.sol` runs the stage 2 handoff offline against a stand-in coordinator with the
  subscription storage layout the script reads. The existing fork suite needs `MAINNET_FORK_RPC_URL` and did not run
  here.
- `contracts/test/mainnet-deploy/run.sh` runs `mainnet-deploy.sh` in a temporary tree with a fake `cast`, `forge` and
  `node` (`fake.py`). The driver had no committed test before.

The new tests deploy the raffle as mainnet has it: no ETH route. The ETH purchase path is covered only by the tests
that existed before.

### 1. Raffle phase

#### States

`Phase` is the one explicit machine: `Draft, Open, Closed, Drawing, Drawn, Settled, Cancelled` (`:45-53`), stored in
`Raffle.phase` (`:85`). A raffle that was never created reads as `Draft` with `seller == address(0)`, which is how
"exists" is encoded (`:807`, `:536`).

Time splits five phases into sub-states. No transaction marks these; the next call observes them.

| Phase | Sub-state | Condition |
|---|---|---|
| Draft | plain, escrowed, approved | `escrowed` (`:86`), `_admissions[id].approvedReviewHash != 0` (`:136`) |
| Draft | sales window passed | `now >= salesEnd`: cannot be approved or opened until edited (`:571`, `:630`) |
| Open | selling | `now < salesEnd` |
| Open | sales ended | `salesEnd <= now < salesEnd + 7 days`: no buys, `close` is due |
| Open, Closed | expired | `now >= salesEnd + DRAW_START_GRACE` (`:38`, `:811`): no draw can start, anyone may cancel |
| Closed | uncounted, partly counted, counted | `lotCursor`, `snapshotted` (`:92`, `:87`) |
| Drawing | waiting | `now < vrfRequestedAt + VRF_ABORT_AFTER` (`:39`) |
| Drawing | timed out | `now >= vrfRequestedAt + 7 days`: a callback is ignored, anyone may abort |
| Drawn | hidden | `!revealed && now < drawnAt + REVEAL_GRACE` (`:37`): cannot settle |
| Drawn | settleable | `revealed`, or `now >= drawnAt + 7 days` |

#### Invariants

1. Phase only moves along these edges: Draft to Open or Cancelled; Open to Closed or Cancelled; Closed to Drawing or
   Cancelled; Drawing to Drawn or Cancelled; Drawn to Settled. Settled and Cancelled are terminal. There is no back
   edge.
2. `nextId` is one more than the number of raffles, and ids are dense.
3. A raffle in Open, Closed, Drawing or Drawn has `escrowed == true`, a pinned policy and `approvedAtOpening == true`.
4. Draft has no lots. Draft and Open have `lotCursor == 0`, `snapshotted == false`, `snapshotTotal == 0`.
5. Pause changes exactly two cells of the table: `open` and `buyPack` (`:625`, `:951`).

#### Transition table

Who: S seller, O owner, B buyer, W winner, C the raffle's pinned coordinator, any anyone.

| From | Event or function | Guard | To | Who | Ref |
|---|---|---|---|---|---|
| none | `createRaffle` | valid draft fields | Draft | any | `:438-454` |
| Draft | `updateDraft` | NFT and token fixed once escrowed; bumps `reviewRevision` | Draft | S | `:456-472`, `:501` |
| Draft | `escrow` | not yet escrowed; token arrives and `ownerOf == this` | Draft | S | `:520-528` |
| Draft | `approveRaffle` | hash is current, `now < salesEnd`, custody holds | Draft | O | `:568-577` |
| Draft | `revokeRaffleApproval` | hash is current, an approval exists | Draft | O | `:579-587` |
| Draft | `open`, `openWithPolicy` | not paused, escrowed, `now < salesEnd`, admission current, custody holds | Open | S | `:624-642` |
| Draft | `cancel` | none | Cancelled | S, O | `:805-819` |
| Open | `buyPack` | not paused, `now < salesEnd`, pack, quantity 1 to 20, supply, pinned terms, exact USDC receipt | Open | B | `:652-661`, `:946-977` |
| Open | `close` | `now >= salesEnd` | Closed | any | `:644-650` |
| Open | `cancel` | no lots | Cancelled | S, O | `:814` |
| Open | `cancel` | `now >= salesEnd + 7 days` | Cancelled | any | `:810-812` |
| Closed | `snapshot` | not complete, 1 to 300 steps | Closed | any | `:691-710` |
| Closed | `requestRandomness` | snapshot complete and non-empty, `now < salesEnd + 7 days` | Drawing | any | `:713-722` |
| Closed | `cancel` | `now >= salesEnd + 7 days`; before that only S or O and only with no lots | Cancelled | any | `:805-819` |
| Drawing | `rawFulfillRandomWords` | sender is the pinned coordinator, request id is the live one, at least one word, `now < vrfRequestedAt + 7 days` | Drawn | C | `:731-743`, `:1064-1074` |
| Drawing | `abortDrawing` | `now >= vrfRequestedAt + 7 days` | Cancelled | any | `:823-832` |
| Open to Drawn | `reveal` | once, commitment matches | same | S, O | `:746-756` |
| Drawn | `settle` | revealed, or `now >= drawnAt + 7 days` | Settled | any | `:758-767` |
| Settled | `claimPrize` | still escrowed | Settled | W | `:770-778` |
| Settled | `claimProceeds` | `principalEscrow != 0` | Settled | S | `:780-789` |
| Settled, Cancelled | `claimFee` | `feeEscrow != 0`; paid to the pinned treasury | same | any | `:791-800` |
| Cancelled | `reclaimPrize` | still escrowed | Cancelled | S | `:835-843` |
| Cancelled | `refund` | `principalOf[id][caller] != 0` | Cancelled | B | `:845-854` |
| any | `rawFulfillRandomWords` otherwise | none | unchanged, no revert | any | `:732-741`, `:1066-1067` |

One more edge exists only with a coordinator that answers inside `requestRandomWords`: Closed goes to Drawn in the
request transaction (`:1056`). The mainnet coordinator answers in a later transaction, so this edge is used by test
coordinators only. The handler's edge check treats it as illegal and never saw it with the asynchronous mock.

Every other pairing of the 19 states and 21 calls reverts. The executable table is `_table()` in
`contracts/test/StateMachine.t.sol`; `test_everyFunctionFromEveryStateMatchesTheTransitionTable` and
`test_pauseOnlyRemovesOpenAndBuyFromTheTransitionTable` run it. Changing one cell makes both fail (checked by
mutating the Settled row to allow `refund`).

#### Illegal combinations checked

| Combination | Result | Evidence |
|---|---|---|
| A phase change outside the edges above | unreachable | handler `illegalEdges == 0` over 38,400 calls; table test |
| Any lifecycle call succeeding on a raffle that does not exist | unreachable | table row `None`; `BuyerProtection.t.sol:341` |
| Editing or escrowing a future id before it is created | needs `msg.sender == address(0)`, because the stored seller is zero (`:467`, `:522`) | no key signs for the zero address; the handler never pranks it |
| Leaving Settled or Cancelled | unreachable | table rows `Settled`, `Cancelled` |
| Buying after `salesEnd`, or closing before it | unreachable; the two guards are complementary at the same second | table rows `OpenSold`, `OpenEnded`; handler `buy` and `close` models |
| Requesting a draw at or after `salesEnd + 7 days` while a cancel is also open | the two are complementary at the same second (`:717`, `:811`) | table rows `ClosedCounted`, `ClosedExpired` |
| Open or buy while paused | unreachable | paused table pass |
| Pause blocking close, snapshot, draw, settle, claims, cancel or refund | does not happen | paused table pass |

### 2. VRF request lifecycle

#### States

| State | Encoding |
|---|---|
| no request | `vrfRequestId == 0`, `vrfRequestedAt == 0` (`:84`, `:96`); phases Draft to Closed |
| capturing | inside `_requestWords` only: `_awaitingCoordinator == pinned`, `_syncFilled == false` (`:1029-1030`, `:239-242`) |
| live | phase Drawing, `vrfRequestId != 0`, `requestToRaffle[pinned][id] == raffle`, `requestUsed[pinned][id]` (`:255-256`, `:1050-1054`) |
| timed out | live and `now >= vrfRequestedAt + 7 days` |
| fulfilled | phase Drawn or Settled; `randomWord`, `winner`, `drawnAt` set (`:1069-1072`); the mapping entry stays |
| aborted | phase Cancelled; `vrfRequestId == 0`; `requestToRaffle` entry deleted, `requestUsed` kept (`:827-828`, `:1059-1062`) |

Requests are keyed by `(coordinator, requestId)`, and the coordinator is the one pinned for the raffle at opening
(`:1027-1028`), not the current default.

#### Invariants

1. `activeDrawings` equals the number of raffles in Drawing (`:720`, `:830`, `:1068`).
2. Drawing implies a non-zero request id that maps back to the raffle on its pinned coordinator, a complete snapshot
   and `snapshotTotal > 0`.
3. A raffle is drawn at most once. Drawn or Settled implies exactly one Drawing to Drawn step, a winner that never
   changes afterwards, `vrfRequestedAt <= drawnAt < vrfRequestedAt + 7 days`, and a winner who bought a pack.
4. Outside Drawn and Settled, `winner`, `drawnAt` and `randomWord` are zero.
5. A Cancelled raffle holds no request, and an aborted request no longer maps to any raffle.
6. A request id is used once per coordinator (`:1052`). `retryRandomness` always reverts (`:727-729`).

#### Transition table

| From | Event | Guard | To | Who | Ref |
|---|---|---|---|---|---|
| no request | `requestRandomness` | Closed, counted, non-empty, before the draw deadline; the coordinator returns a non-zero, unused id | live | any | `:713-722`, `:1026-1057` |
| capturing | callback from the awaited coordinator for an id with no raffle | first one only, at least one word | capturing, word held | C | `:733-739` |
| capturing | request returns the held id | ids equal | fulfilled | same call | `:1056` |
| live | callback, right coordinator and id, in time | `:1066-1067` | fulfilled | C | `:1064-1074` |
| live | callback at or after the deadline | none | timed out, unchanged | C | `:1067` |
| live | callback from another coordinator, or another id | none | unchanged | any | `:732`, `:1066` |
| live | callback with no words | none | unchanged | C | `:741` |
| timed out | `abortDrawing` | deadline reached | aborted | any | `:823-832` |
| fulfilled | the same callback again | none | unchanged | C | `:1066` |
| aborted | the old callback, at any later time | none | unchanged | C | `:733`, mapping deleted |

#### Orderings attacked

| Ordering | Result | Test |
|---|---|---|
| Callback after abort | ignored | `LabxRaffle.t.sol` `test_abortDrawingClearsRequestMap`; handler mode 2 |
| Callback after cancel | cannot be ordered this way: `cancel` reverts in Drawing (`:813`); abort is the only exit | table row `Drawing` |
| Callback twice | second ignored, winner unchanged | `testFuzz_weightedWinnerAndCallbackReplay`; handler `winnerChanged == false` |
| Abort, then another raffle requests, then the old callback | ignored | `BuyerProtection.t.sol:183`; handler mode 2 |
| Old callback delivered inside another raffle's request | lands in the capture slot, draws neither raffle, the new request stays answerable | `test_abortedCallbackInsideAnotherRequestDrawsNeitherRaffle` |
| Old callback and the new request's own word, both inside the request | the capture slot holds one callback, so the new word is dropped; the raffle stays Drawing and a later delivery draws it | `test_staleCallbackCanDisplaceASameTransactionWordButNotTheRequest` |
| Callback at exactly the abort deadline, and abort one second before | both refused; the deadlines are complementary | table rows `Drawing`, `DrawingExpired`; `RecoveryPolicy.t.sol` `test_callbackAndAbortDeadlinesAreDisjointAcrossBothOrderings` |
| Coordinator changed with a request in flight | the old coordinator still answers; the new one cannot; equal ids on two coordinators stay separate | `test_coordinatorChangeMidDrawLeavesEachRequestWithItsOwnCoordinator` |
| Callback from a sender that is not a coordinator | ignored | handler mode 1; `test_onlyCoordinatorFulfills` |

The capture slot (`_awaitingCoordinator`, `_syncFilled`) accepts a write when `msg.sender == _awaitingCoordinator`.
At rest that field is zero, so only a call from the zero address could write it. No transaction can come from the zero
address, and the slot is cleared at the start of every request (`:1030`).

`rawFulfillRandomWords` has no reentrancy guard, by design: a synchronous coordinator calls it while
`requestRandomness` holds the guard. It makes no external call and only writes the raffle named by the mapping.

### 3. Admission and approval

#### States

| State | Encoding |
|---|---|
| unreviewed | `approvedReviewHash == 0` (`:136`) |
| approved, current | `approvedReviewHash == draftReviewHash(id)` and `approvedBy == owner` (`:632-635`) |
| approved, stale | a hash is stored but one input of `draftReviewHash` changed since |
| revoked | hash and approver cleared, `reviewRevision` bumped (`:583-585`) |
| admitted | `approvedAtOpening == true` (`:637`); set once, in `_open` |

`draftReviewHash` (`:534-566`) covers chain id, contract, id, seller, NFT, token id, the NFT's code hash, `escrowed`,
title, `salesEnd`, both reserve fields, every pack, `reviewRevision`, `owner`, `ownerGeneration`,
`openingPolicyGeneration` and `openingPolicyHash()`. It reverts outside Draft.

#### Invariants

1. A raffle opens only when its stored approval equals the current hash and was given by the current owner.
2. `approvedAtOpening` is true exactly when a policy is pinned.
3. Every opened raffle keeps a non-zero `approvedReviewHash`: approval can only be revoked in Draft.
4. `reviewRevision` only grows.

#### Transition table

| From | Event | Guard | To | Who | Ref |
|---|---|---|---|---|---|
| any Draft state | `approveRaffle` | hash current, `now < salesEnd`, escrowed and held | approved, current | O | `:568-577` |
| approved | `revokeRaffleApproval` | hash current | revoked | O | `:579-587` |
| approved, current | `updateDraft` | Draft | approved, stale | S | `:501` |
| approved, current | any of `setTreasury`, `setTermsHash`, `setVrfConfig`, `setNativePayment`, `applyCoordinator` | owner; also when the value does not change | approved, stale | O | `:376`, `:382`, `:397`, `:404`, `:423` |
| approved, current | `acceptOwnership` | pending owner; also when the address does not change | approved, stale | new owner | `:363` |
| approved, current | the NFT's code changes, or the token leaves the contract | external | approved, stale or custody failure | NFT | `:551`, `:591` |
| approved, current | `open` | see phase table | admitted | S | `:624-642` |
| approved, stale | `open` | none | reverts `AdmissionRequired` | S | `:635` |

`transferOwnership` alone and `setPaused` do not make an approval stale.

#### Orderings attacked

Approval revoked, owner changed, owner away and back, each policy setter (including identical and restored values),
and a seller edit, all between approve and open: covered by `Admission.t.sol` (8 tests) and
`IndependentAdmissionAccountingVerification.t.sol`. The handler adds a model of the open guard (`_admitted`) checked on
every `open` call, with owner changes and policy setters interleaved at random. Self-transfer of ownership is covered
by `test_pendingOwnerIsReplacedNotClearedAndSelfAcceptVoidsApprovals`.

### 4. Claims and payouts

#### States

Per raffle: `principalEscrow` and `feeEscrow` (`:94-95`). Per buyer: `principalOf` (`:249`). Zero means paid.
`principalEscrow` has two meanings: before an outcome and in Cancelled it is the sum of unrefunded buyer principal;
after `settle` it is the seller's net (`:762-764`).

| Claim | Unpaid when | Paid by |
|---|---|---|
| prize | Settled and `escrowed` | `claimPrize` sets `escrowed = false` (`:775`) |
| proceeds | Settled and `principalEscrow != 0` | `claimProceeds` zeroes it (`:786`) |
| fees | Settled or Cancelled and `feeEscrow != 0` | `claimFee` zeroes it (`:797`) |
| refund | Cancelled and `principalOf[id][buyer] != 0` | `refund` zeroes it (`:850`) |
| prize return | Cancelled and `escrowed` | `reclaimPrize` (`:840`) |

#### Invariants

1. USDC held by the contract equals the sum over raffles of `principalEscrow + feeEscrow`, plus USDC sent to the
   contract outside `buyPack`. The contract has no way to pay that surplus out, and it is never counted for a raffle.
2. Per raffle, USDC in minus USDC out equals `principalEscrow + feeEscrow`, and USDC in equals principal plus buyer
   fees.
3. Before an outcome nothing leaves, `principalEscrow` equals the sum of `principalOf`, and `feeEscrow` equals buyer
   fees.
4. In Cancelled, `principalEscrow` equals the sum of `principalOf` of buyers not yet refunded, refunds never exceed
   principal, buyer fees are kept for the treasury, and no proceeds are paid.
5. In Settled, proceeds paid plus `principalEscrow` equals principal minus the 2% commission, fees paid plus
   `feeEscrow` equals buyer fees plus that commission, and nothing is refunded.
6. Each buyer is refunded at most once, proceeds are claimed at most once, and the prize leaves at most once.
7. The treasury that receives fees is the one pinned at opening.

All are asserted by `_checkMoney` in the invariant test. Every state change precedes its transfer, and each function
holds the reentrancy guard.

#### Orderings attacked

| Ordering | Result | Evidence |
|---|---|---|
| Refund after settle | reverts `BadPhase` | table row `Settled` |
| Any claim twice | reverts | table "repeated" check on every one-shot cell |
| Proceeds, fee and prize in every order | each pays once | `PercentageFees.t.sol` `test_allClaimOrdersAndSettlementOnlyChargesOnce` |
| Refund in one raffle against another raffle's money | cannot happen | `testFuzz_twoRaffleSolvencyAcrossRefundsAndSettlement`; handler invariant 2 |
| Failed USDC transfer on refund or claim | whole call reverts, can be retried | `RecoveryPolicy.t.sol` `test_failedRefundTransferRollsBackAccountingAndCanRetry` |
| Reentry through the NFT or USDC | every paying function is `nonReentrant`; the functions without the guard are `createRaffle`, `rawFulfillRandomWords`, the owner setters and views, none of which pays | `test_reentrancyOnEscrowIsRejected`; reading |
| Reentry through WETH, the router or the ETH refund | unreachable on mainnet: the route's three addresses are immutable and zero there (`contracts/script/DeployMainnet.s.sol:263-265`), so `buyPackWithEth` always reverts (`:671`) and `setEthPathEnabled(true)` reverts (`:431`). With the route wired, `buyPackWithEth` holds the guard | handler `admin` kind 9; existing ETH tests in `LabxRaffle.t.sol` |
| A reverting NFT receiver or a blocked treasury | affects only that payee's own claim | `test_revertingReceiverCannotFreezeUsdc`, `testFuzz_cancelledBlockedTreasuryCannotBlockRefundsOrConsumeOtherRaffleBacking` |

### 5. Snapshot progress

#### States

`lotCursor`, `snapshotTotal`, `snapshotted` (`:87`, `:92-93`), with `cumulatives[id]` and `snapshotOwners[id]`
(`:247-248`).

| State | Encoding |
|---|---|
| not started | `lotCursor == 0`, not snapshotted |
| in progress | `0 < lotCursor < lots` |
| complete | `snapshotted`, `lotCursor == lots` |
| complete and empty | complete with `snapshotTotal == 0` |

#### Invariants

1. `lotCursor <= lotCount`, and `snapshotted` implies equality.
2. `snapshotTotal` never exceeds the entries sold, and equals them for every raffle that reaches Drawing.
3. For a raffle that reaches Drawing, the last cumulative equals `snapshotTotal`.
4. Lots cannot be added after Closed, so the lot list is fixed while the cursor moves (`:954`).

#### Transitions and orderings

`snapshot` is the only writer (`:691-710`). It runs only in Closed, so it cannot interleave with `buyPack`, and
`close` cannot run twice. A cancel at the draw deadline can land between two batches; the raffle is then Cancelled
with a partial snapshot and `snapshot` reverts. Covered by table rows `ClosedPartial` and `ClosedExpired`, by
`test_chunkedSnapshotMatchesSinglePass`, and by the handler, whose forward step lets one raffle in seven miss the
deadline with whatever progress it has.

"Complete and empty with lots" needs every lot to have expired. A lot expires 365 days after purchase (`:975`), and a
purchase is at most 180 days before `salesEnd` (`:485`), so no lot expires before `salesEnd + 185 days`. By then the
draw deadline (`salesEnd + 7 days`) has long passed and anyone can cancel anyway. The exemption for this case in
`cancel` (`:814`) is therefore never the deciding condition. The handler models `cancel` without the exemption and
never disagreed with the contract.

### 6. Escrow and custody

#### States

| State | Encoding |
|---|---|
| not held | `escrowed == false`; the seller (or, after a claim, the winner) owns the token |
| held | `escrowed == true` and `IERC721(nft).ownerOf(tokenId) == this` |
| flag without token | `escrowed == true` and the token is elsewhere |

`escrowed` (`:86`) is a flag per raffle. Custody is the external `ownerOf` answer (`:526`, `:591`). Nothing ties a
token to one raffle.

#### Invariants

1. With a collection that follows ERC-721: `escrowed` implies the contract holds the token, the contract holds exactly
   one token per escrowed raffle, and a token released goes to the winner (Settled) or the seller (Cancelled).
2. `onERC721Received` accepts only a transfer the contract itself started (`:939-942`).
3. The NFT and token id cannot change once escrowed (`:469`).

Invariant 1 depends on the collection. See C1.

#### Transition table

| From | Event | Guard | To | Who | Ref |
|---|---|---|---|---|---|
| not held | `escrow` | Draft; `safeTransferFrom(seller, this)` succeeds and `ownerOf == this` | held | S | `:520-528` |
| held | `claimPrize` | Settled | not held (winner) | W | `:770-778` |
| held | `reclaimPrize` | Cancelled | not held (seller) | S | `:835-843` |
| held | the collection moves the token by itself | external | flag without token | NFT | none |

#### Illegal combinations checked

| Combination | Result | Evidence |
|---|---|---|
| Two raffles escrowed on one token, standard collection | unreachable: the second `safeTransferFrom` fails because `from` is not the owner | `test_standardCollectionRefusesASecondEscrowOfAHeldToken` |
| Two raffles escrowed on one token, collection that ignores `from` | reachable: finding C1 | `test_collectionThatIgnoresFromLetsAStrangerTakeALivePrize` |
| A draft naming USDC as its collection reaching `escrowed`, then `reclaimPrize` calling `transferFrom` on USDC (same selector) | unreachable: `escrow` needs `safeTransferFrom` and `ownerOf` | `test_draftNamingUsdcAsItsCollectionCannotEscrowOrReclaim` |
| An NFT sent with `safeTransferFrom` by anyone else | refused | `LabxRaffle.t.sol:589`, `:606` |
| An NFT sent with plain `transferFrom` | accepted by the collection and stuck; the contract cannot refuse it | E7, accepted |
| A prize that reverts on the way out | blocks only that prize; USDC claims and refunds still work | `test_stickyNftBlocksClaimButNotUsdc`, `test_stickyNftCancelStillRefunds` |

### 7. Cancellation

`cancel` (`:805-819`) is one predicate over phase, caller, time and lots. `abortDrawing` (`:823-832`) is the only
cancellation from Drawing.

| Phase | Caller | Time | Lots | Result |
|---|---|---|---|---|
| none | any | any | none | reverts |
| Draft | seller, owner | any | none | Cancelled |
| Draft | other | any | none | reverts |
| Open, Closed | seller, owner | before `salesEnd + 7 days` | none | Cancelled |
| Open, Closed | seller, owner | before `salesEnd + 7 days` | some | reverts `SalesStarted` |
| Open, Closed | other | before `salesEnd + 7 days` | any | reverts |
| Open, Closed | any | at or after `salesEnd + 7 days` | any | Cancelled |
| Drawing | any | before `vrfRequestedAt + 7 days` | some | `cancel` and `abortDrawing` revert |
| Drawing | any | at or after `vrfRequestedAt + 7 days` | some | `abortDrawing` gives Cancelled |
| Drawn, Settled, Cancelled | any | any | any | reverts |

Invariant: once a buyer holds a lot, nobody can cancel before a deadline, and after a deadline everybody can.

The handler's `cancel` model is this table (`expired || (privileged && lots == 0)`) and was checked on every cancel
call with four kinds of caller. Table rows cover each line. `testFuzz_noRoleCanCloseEarlyOrCancelPurchasedMembership`
covers the same rule.

### 8. Ownership and coordinator migration

#### Ownership

States: `owner`, `pendingOwner`, `ownerGeneration` (`:216-218`).

| From | Event | Guard | To | Who | Ref |
|---|---|---|---|---|---|
| settled owner | `transferOwnership(x)` | `x != 0` | pending `x` | O | `:353-357` |
| pending `x` | `transferOwnership(y)` | `y != 0` | pending `y` | O | `:353-357` |
| pending `x` | `acceptOwnership` | caller is `x` | owner `x`, generation + 1, nothing pending | x | `:359-365` |

Invariants: the owner is never zero; the generation grows on every acceptance; an approval given by a previous owner,
or by the same address before a self-acceptance, never opens a raffle.

There is no way to clear a pending owner. It can only be replaced, including with the owner's own address. See A1.
`acceptOwnership` compares the caller with `pendingOwner`, which is zero at rest, so only the zero address could
accept when nothing is pending. That is unreachable.

#### Coordinator migration

States: `vrfCoordinator`, `pendingCoordinator`, `coordinatorEta` (`:221-223`).

| From | Event | Guard | To | Who | Ref |
|---|---|---|---|---|---|
| none pending | `proposeCoordinator(x)` | `x` has code | pending `x`, eta now + 1 day | O | `:409-415` |
| pending | `proposeCoordinator(y)` | `y` has code | pending `y`, eta restarts | O | `:409-415` |
| pending, eta reached | `applyCoordinator` | `x` still has code | default is `x`, nothing pending, policy generation + 1 | O | `:417-427` |

Invariant: the default coordinator only affects raffles opened after it is applied. Every opened raffle requests from
and is answered by the coordinator pinned at its opening. `activeDrawings` is not a guard on `applyCoordinator`, and
does not need to be.

An operational consequence, not a contract defect: if the old subscription or its consumer entry is removed while a
raffle pinned to the old coordinator is Open or Closed, `requestRandomness` reverts until `salesEnd + 7 days`, and
the raffle can then only be cancelled and refunded (`RecoveryPolicy.t.sol`
`test_revertingCoordinatorLeavesClosedRaffleRecoverableAtSalesCutoff`). Keep the old subscription funded and its
consumer in place until every raffle pinned to it is Settled or Cancelled.

### 9. Pinned policy

States: `_policies[id]` is all zero before opening, and a full copy of the opening defaults after (`:638`,
`:608-622`).

Invariants: the pinned policy never changes after opening (handler `policyChanged == false`, with every setter
interleaved); it holds a non-zero coordinator, treasury and terms hash and the constant fee rates; buys check the
pinned terms (`:952`), fees use the pinned rates (`:961-962`, `:762`), the request uses the pinned VRF settings
(`:1027-1042`), and fees go to the pinned treasury (`:796`).

`openWithPolicy` lets the seller refuse an opening whose defaults changed since they looked (`:599-602`). Plain `open`
takes whatever is current. Both need a current approval, and every setter makes approvals stale, so a setter between
approve and open stops both.

### 10. Deploy driver record (`contracts/script/mainnet-deploy.sh`)

#### States

The record is one JSON file (`RECORD`, default `deployments/mainnet.json`). Its state is the combination of the file,
the kept run files beside it, forge's `contracts/broadcast/DeployMainnet.s.sol/1/run-latest.json`, and the deployer's
nonce on chain.

| State | Encoding |
|---|---|
| no record | no file, no kept `stage1*.json`, no `run-latest.json` |
| orphan run file | no record, but `run-latest.json` or a kept `stage1*.json` exists (`mainnet-deploy.sh:306`, `:369-373`) |
| stage 1 pending | `stage1.status == "pending"` with `tx`, `nonce`, `run`, `previous[]` (`:319-338`) |
| stage 1 mined | `stage1.status == "mined"`, `subscriptionId`, `expectedNonce`, `predictedRaffle`, `create == null`, `runs == {}` (`:401-407`) |
| create unrecorded | stage 1 mined, `create == null`, and the deployer's nonce is past `expectedNonce` |
| create recorded | `create == {tx, block, address}` (`:174-186`) |
| stage 2 recorded | `runs.stage2`, and `runs.resume-<time>` per resume that sent something (`:270-275`) |
| unreadable | the file does not parse |

#### Invariants

1. At most one `createSubscription` and one raffle CREATE are mined per record. The nonce is the lock: every stage 1
   send is bound to `STAGE1_NONCE` (`:379`, `DeployMainnet.s.sol:116-123`), and a fresh stage 2 to `EXPECTED_NONCE`
   (`:423`, `DeployMainnet.s.sol:192-193`).
2. A sent stage 1 transaction is in the record before anything waits for it (`:383`, `:161`, `:166`).
3. `create` is written only for a transaction that is deep enough in the canonical chain, succeeded, came from the
   recorded deployer at `expectedNonce`, and created `predictedRaffle` (`:174-186`).
4. The record is replaced whole or not at all (`:43-59`).
5. Every forge run file that holds a sent transaction is kept beside the record before the next broadcast deletes
   forge's copy (`:128-147`, `:156-157`). Before the D1 fix this did not hold for a driver that was killed outright.
6. A failed chain read stops the run; it is never read as "no transaction" (`:33`, `:39`).

#### Transition table

| From | Command | Guard | To | Ref |
|---|---|---|---|---|
| no record | `stage1` | no pending deployer transaction | sends at the checked nonce, then stage 1 pending | `:365-386` |
| orphan run file | `stage1`, `preflight` | none | refuses until the operator settles and moves the file | `:306`, `:369-373` |
| stage 1 pending | `stage1`, a recorded hash is known to the RPC | none | waits for it, then stage 1 mined | `:351-356`, `:388-408` |
| stage 1 pending | `stage1`, no recorded hash known, nonce unused | none | sends again at the same nonce, keeps the earlier hashes | `:357-359`, `:333` |
| stage 1 pending | `stage1`, no recorded hash known, nonce used | none | waits for the last recorded hash and times out with instructions | `:360-362`, `:387` |
| stage 1 pending | `stage2`, `resume`, `verify` | none | refuses | `:413`, `:435`, `:459` |
| stage 1 mined | `stage1` | none | refuses: a second subscription | `:347` |
| stage 1 mined | `stage2` | nonce and pending nonce equal `expectedNonce` | create recorded, stage 2 recorded, verified | `:411-431` |
| create unrecorded | `stage2` | none | refuses and names `resume` | `:419` |
| create unrecorded | `resume`, `verify` | exactly one candidate CREATE is mined at `expectedNonce` | create recorded | `:231-267` |
| create unrecorded | `resume`, `verify`, no candidate matches | none | stops; names `CREATE_TX`, or says the nonce is unused or pending | `:220-225`, `:260-264` |
| create recorded | `stage2` | none | refuses | `:414` |
| create recorded | `resume` | no pending transaction, code at the address | sends the missing steps only, records them, verifies | `:433-451` |
| create recorded | `verify` | `DeployMainnet.verify()` passes | prints the manifest | `:457-476` |
| any | forge fails, or INT, TERM or HUP during a broadcast | none | run file kept; stage 1 hash recorded as pending | `:161-168` |
| any | the driver is killed outright during a broadcast | none | `run-latest.json` left unkept; the next step keeps it | `:138-147` |

#### Retries and concurrency checked

| Case | Result | Test in `contracts/test/mainnet-deploy/run.sh` |
|---|---|---|
| A chain read fails while stage 1 waits | pending record; rerun waits; one send | `test_e1_failed_read_while_waiting_does_not_send_stage1_again` |
| Forge fails after sending stage 1 | pending record; rerun waits | `test_e1_forge_failure_after_sending_is_recorded_as_pending` |
| Stage 1 still pending on rerun | waits, does not replace | `test_e1_pending_stage1_is_waited_for_not_replaced` |
| Stage 1 dropped | sent again at the same nonce; one subscription | `test_e1_dropped_stage1_is_sent_again_at_the_same_nonce_only` |
| Hangup during stage 1 | forge stopped, pending record, exit 130 | `test_e1_interrupted_stage1_is_recorded_and_forge_is_stopped` |
| Driver killed during stage 1 | next `stage1` refuses over forge's run file | `test_killed_stage1_refuses_a_fresh_send_over_forges_run_file` |
| Dropped CREATE, then a second interrupted attempt | the mined CREATE is recorded | `test_e2_dropped_create_that_sorts_first_does_not_hide_the_mined_one` |
| The mined CREATE is in no kept file | error names `CREATE_TX`; with it, resume completes | `test_e2_no_mined_candidate_names_create_tx_and_accepts_it` |
| CREATE dropped, nonce unused | `resume` says a fresh `stage2` can run, and it does | `test_unused_expected_nonce_says_a_fresh_stage2_can_run` |
| Record write cut short | previous record intact, no temporary file left | `test_e3_record_write_cut_short_leaves_the_previous_record` |
| Stage 2 fails after the CREATE | fresh rerun refused; `resume` finishes; one raffle | `test_interrupted_stage2_resumes_without_a_second_create` |
| Driver killed during stage 2, CREATE mined, node without state history | finding D1 | `test_d1_killed_stage2_leaves_a_run_file_that_resume_keeps_and_uses` |
| Driver killed during stage 2, CREATE later dropped | finding D1 | `test_d1_killed_stage2_before_the_create_mined_keeps_its_run_file_too` |
| Two `stage1` runs at once | one subscription; one run succeeds, the other stops | `test_two_stage1_runs_at_once_create_one_subscription` |
| `stage1` or `stage2` repeated after success | refused | `test_full_run_records_every_step_and_verifies` |

The driver takes no lock. Two runs at once are held apart by the nonce: both simulate, both send at the same nonce,
and a node accepts one. The fake node models that rule and nothing else about a mempool.

### 11. DeployMainnet fresh, resume and verify (`contracts/script/DeployMainnet.s.sol`)

#### States

The script keeps no state. Each run reads the mode from `DEPLOY_MODE` (`:167-170`) and everything else from chain.

| Dimension | Values | Read at |
|---|---|---|
| mode | fresh, resume, verify | `:169-170`, `:234` |
| raffle | none; created; native billing on; ownership offered; owned by the Safe | `:205`, `:212`, `:290-294` |
| subscription | untouched; consumer added; funded to target; ownership offered; owned by the Safe | `:86-93`, `:206-215` |
| launched | the Safe owns the raffle, nothing pending, not paused | `:316-318` |

#### Invariants

1. A fresh run sends a CREATE only at `EXPECTED_NONCE` and only to an untouched subscription the deployer owns
   (`:192-196`).
2. A resume sends only the missing steps and only the funding shortfall (`:205-215`), and only for a raffle whose code
   hash equals a fresh deployment's and whose settings are the reviewed ones (`:279-313`).
3. After any successful run the handoff holds: reviewed settings, native billing, the raffle is the only consumer,
   and both the raffle and the subscription are owned by the Safe or offered to it (`:323-337`).
4. `verify` sends nothing and takes no missing step (`:234-257`).

#### Transition table

| From | Run | Guard | To | Ref |
|---|---|---|---|---|
| no raffle, untouched subscription | fresh | nonce equals `EXPECTED_NONCE` | full handoff | `:189-216` |
| any later state | fresh | none | `NonceMoved`, or `SubscriptionInUse` | `:193-196` |
| raffle created, any of the five later steps missing | resume | code, settings and ownership as a fresh run leaves them | full handoff | `:199-216` |
| full handoff | resume | none | sends nothing | `:205-215` |
| the Safe owns the raffle or the subscription and a step is missing | resume | none | `SafeActionRequired` naming the call | `:326-330` |
| raffle owned by or offered to anyone else, changed settings, different code, another consumer | resume, verify | none | refuses | `:286-294`, `:303-312`, `:329` |
| full handoff, any of the four ownership pairs | verify | subscription at or above the funding target | passes | `:245-257` |
| launched | verify | as above; pause and terms are reported, not required | passes | `:302`, `:308`, `:312` |
| launched, then paused again with changed terms | verify | none | `RaffleSettingMismatch("termsHash")` | `:316-318`; see A3 |

Offline evidence: `contracts/test/DeployMainnetHandoff.t.sol`. `test_resumeFromEveryInterruptionReachesTheSameHandoff`
stops a fresh run after each of its six transactions, checks that verify refuses the partial state, resumes, checks
the handoff and the exact funding, and checks that a second resume sends and funds nothing. The other four tests cover
the fresh refusals, the four ownership pairs, the Safe action message, and the launched rule.

#### DeploySepolia and DeployLocal

`DeploySepolia` (`contracts/script/DeploySepolia.s.sol`) has no resume and no record: three transactions in one
broadcast. A run that stops part way leaves a raffle the deployer still owns, and a rerun deploys another. Testnet
only, accepted. Since 7c8c6ed it leaves the raffle paused. `DeployLocal` accepts chain 31337 only and unpauses, for
fixtures.

### Findings

#### C1. A collection that does not check `from` lets anyone take a live raffle's prize

Severity: high (the prize of a live raffle and the buyers' money are at risk), conditional on the collection. A
collection that follows ERC-721 is not affected. No raffle exists on mainnet today.

Reachable sequence, with a collection whose `safeTransferFrom` moves a token when the caller owns it, without
checking that `from` is the owner. `escrow` uses the three-argument `safeTransferFrom` (`:525`); `transferFrom` is only
used on the way out (`:841`), so a collection that is strict in `transferFrom` and lax in `safeTransferFrom` is still
affected. The attacker needs no approval, token or role, and the four calls fit in one transaction.

The independent review confirmed it works in every state in which the contract holds the token: Draft with escrow
(before any review), Open, Closed, Drawing, Drawn, Settled with the prize unclaimed, and Cancelled with the prize
unreclaimed. Pausing does not stop it. The Open case:

1. Raffle A is escrowed, approved and Open on token T. The contract owns T.
2. Anyone calls `createRaffle` for the same collection and T. No approval is needed for a draft.
3. They call `escrow` on their draft. The contract calls `safeTransferFrom(caller, this, T)` as the token's owner.
   The collection moves T from the contract to the contract. `ownerOf == this` holds, so the draft is `escrowed`
   (`:524-526`).
4. They call `cancel` on their own draft (`:805-819`), then `reclaimPrize` (`:835-843`). The contract sends T to them.
5. Raffle A still reads `escrowed == true`, keeps selling, draws and settles. `claimPrize` and `refund` revert, and
   the seller can still claim the proceeds. If nobody draws, anyone can cancel at `salesEnd + 7 days` and buyers get
   their principal back without the fee. A Draft victim cannot be approved (`EscrowFailed`) and its seller cannot
   reclaim.

Not affected: OpenZeppelin 5.2 refused both a stranger's and the same seller's second escrow when run. Solmate,
ERC721A and wrapped punks check `from` (from their source, not run here). No variant against a standard collection
was found: token identity locks after escrow and the raffle never grants approvals.

A collection that is malicious rather than faulty can move a held token by itself, so this finding adds risk only for
a collection that is honest and wrong about `from`.

Cause: `escrowed` is per raffle and custody is `ownerOf == this` (`:526`, `:591`). Neither says which raffle a held
token belongs to, and `escrow` does not check that the seller owned the token before the transfer.

Test: `contracts/test/StateMachine.t.sol` `test_collectionThatIgnoresFromLetsAStrangerTakeALivePrize` (passes, which
shows the sequence works). Control: `test_standardCollectionRefusesASecondEscrowOfAHeldToken`.

Mitigation, since the contract cannot change:

- Admission review, before `approveRaffle`, is the control that works: approve only a collection whose verified source
  is a known standard implementation, and prove it refuses a safe transfer whose `from` is not the owner. Simulate, as
  the current holder, `safeTransferFrom(<some other address>, <an EOA>, <tokenId>)` and require a revert, for example
  `cast call <nft> "safeTransferFrom(address,address,uint256)" <other> <eoa> <tokenId> --from <holder>`. The recipient
  must be an EOA: with the raffle as recipient the call always reverts in `onERC721Received` (`:940`) and proves
  nothing. A probe of plain `transferFrom` is not enough. Add this to the NFT review in `LAUNCH.md` section 5.
- Not sufficient on their own: checking at approval that no other raffle names the token (the attacker's draft can be
  created afterwards), and monitoring (the attack fits in one transaction, so an alert comes after the prize is gone).
  Monitoring is still worth having to start the response below.
- If it happens anyway: the owner cannot cancel a raffle that has lots (`:814`), and `requestRandomness` and `settle`
  are permissionless, so the raffle will draw and pay the seller unless the draw is kept from starting. The one lever
  the Safe holds is the VRF subscription: pause (stops new sales), then remove the raffle contract as a consumer until
  the affected raffle passes `salesEnd + 7 days`, when anyone can cancel it and buyers refund their principal. A
  request from a non-consumer reverts, which is the path `RecoveryPolicy.t.sol`
  `test_revertingCoordinatorLeavesClosedRaffleRecoverableAtSalesCutoff` covers with a mock; it was not run against
  the real coordinator here. This delays every other raffle's draw on the same subscription, and a raffle already in
  Drawing cannot be stopped this way.
- A later contract version should refuse it in code: require `ownerOf(tokenId) == msg.sender` before the transfer in
  `escrow`, or record which raffle holds each token. This needs the owner's decision.

#### D1. A driver killed outright during stage 2 loses forge's run file

Severity: low (operator inconvenience; no duplicate send).

Reachable sequence: `stage2` is running, forge has sent the CREATE, and the driver is killed outright (SIGKILL, a
crash, power loss), so neither the trap nor the failure path keeps `run-latest.json`. Then:

- `resume` and `verify` looked for the CREATE only in kept run files. With none, they searched by nonce, which needs
  state history. On a node without it they stopped with "could not read the deployer nonce at block N (needs state
  history)" until the operator found the hash and set `CREATE_TX`.
- The next broadcast deleted `run-latest.json` (`rm -f`), the only file naming the transactions of the killed run.

Stage 1 already refused to run over such a file (626df81). Stage 2 had no equivalent.

Fix (f7bb36a, `contracts/script/mainnet-deploy.sh:138-147`, `:156`, `:236`): `keep_leftover` keeps forge's run file
as `<label>-leftover-<time>.json` when no kept file holds a copy. `reconcile_create` calls it before collecting
candidates, and `broadcast` calls it before deleting the file.

Tests: `test_d1_killed_stage2_leaves_a_run_file_that_resume_keeps_and_uses` and
`test_d1_killed_stage2_before_the_create_mined_keeps_its_run_file_too` in `contracts/test/mainnet-deploy/run.sh`.
Before the fix: 13 passed, 2 failed (these two). After: 15 passed, 0 failed.

### Status of E1 to E8

| ID | 7 November | Now | Proof |
|---|---|---|---|
| E1 | confirmed, low: a failed read while stage 1 waits leaves no record, and a rerun makes a second subscription | Fixed (2ff6478, 73ca095, 626df81, d9d33c5). PR 25 added no test for the driver; this work adds them. | `run.sh` `test_e1_*` (5 tests), `test_killed_stage1_refuses_a_fresh_send_over_forges_run_file`; `DeployMainnet.t.sol:69` for the nonce binding. The driver at f717a70 fails them: it sends twice. |
| E2 | confirmed, medium: recovery takes the first CREATE in sorted run files | Fixed (86e71fd, 246c590) | `run.sh` `test_e2_*` (2 tests). The driver at f717a70 waits on the dropped CREATE and times out. |
| E3 | partial, low: non-atomic record write | Fixed (09e1c0b) | `run.sh` `test_e3_record_write_cut_short_leaves_the_previous_record`. The driver at f717a70 leaves an unreadable record. |
| E4 | partial, low: tooling refuses after launch | Fixed for a launched raffle (c76eae1). Residual question A3. | `DeployMainnetHandoff.t.sol` `test_verifyReadsARepausedRaffleAsNotLaunched` (offline); `DeployMainnet.t.sol:398` (fork, not run here) |
| E5 | partial, low: dead code (lot expiry, `Pack.active`) | Accepted. The code stays; the NatSpec now says the exemption is defensive (e5a8f14). `Pack.active` is always true (`:515`). | `LabxRaffle.t.sol:453`; section 5 above; the handler's `cancel` model |
| E6 | refuted | Still refuted. The 7 November document does not describe E6, so it could not be retested by name. No refuted behaviour was reached by the table or the invariant run. | none specific |
| E7 | confirmed, medium: an NFT sent straight to the contract is stuck | Fixed for `safeTransferFrom` (3d9415e). A plain `transferFrom` still sticks and cannot be refused; accepted. | `LabxRaffle.t.sol:589`, `:606` |
| E8 | partial, low: DeploySepolia ordering | Fixed (7c8c6ed): the raffle stays paused until it is a consumer | `DeploySepolia.t.sol:97` |

### Suspicions not reproduced

- Two drivers at once, with the second forge writing `run-latest.json` in the few milliseconds between the first
  forge exiting and the first driver keeping the file. The first driver would keep the wrong file and stop without a
  record, and the next `stage1` would refuse until the operator settles by hand. The test for two runs at once did not
  hit this window. A lock directory would close it.
- Two kept run files with the same label in the same second: `keep_run` names files to the second and `cp` overwrites
  (`mainnet-deploy.sh:131-132`). Real forge runs take longer than a second; the tests wait 1.1 seconds between two
  failed runs for this reason.
- A recorded `create.tx` that a reorg deeper than `CONFIRMATIONS` removes: every `resume` and `verify` would wait 900
  seconds for it and stop, and the record would need a hand edit. Not reproduced; needs a reorg of 3 or more blocks.
- A run file cut short by the interruption itself during stage 1: `stage1_start` would fail on the unreadable file
  inside the trap, leaving a kept file and no record, which the next `stage1` refuses. Read from the code, not run.
- A callback that runs out of gas in `_applyWord`. Chainlink does not retry, so the raffle would time out and refund.
  The pinned limit is 400,000 and the existing margin tests pass (`PermissionlessDraw.t.sol`
  `test_completedMaximumSnapshotHasColdStorageGasMargin`); not re-measured here.

### Ambiguities: is this intended?

- A1. A pending owner cannot be cleared, only replaced (`:353-357`). An owner who proposed the wrong address must
  propose another, for example itself. Accepting its own proposal bumps `ownerGeneration` and voids every unopened
  approval. Test: `test_pendingOwnerIsReplacedNotClearedAndSelfAcceptVoidsApprovals`.
- A2. Buyer fees are kept when a raffle is cancelled, including when the draw times out for reasons on the LABx side
  such as an unfunded subscription (`:793-799`, `:250`). The code and `test_cancelRefundsPrincipalAndRetainsFee` say
  this is intended. Flagged because the buyer pays at least 2.50 USDC for a draw that never ran.
- A3. `verify` reads "launched" as "the Safe owns the raffle and it is not paused"
  (`contracts/script/DeployMainnet.s.sol:316-318`). A launched raffle that the Safe pauses again, after changing the
  terms hash, fails `verify` with `RaffleSettingMismatch("termsHash")`. If the terms are the Safe's to set after
  launch, an emergency pause should not change that. Test: `test_verifyReadsARepausedRaffleAsNotLaunched`.
- A4. The record's `runs` lists only runs that forge finished. Transactions sent by a stage 2 run that failed, was
  interrupted or was killed are in the kept run file beside the record but never in `runs`, even after `resume`
  completes and `verify` passes (`mainnet-deploy.sh:270-275`, `:428-429`). `LAUNCH.md` step 4 says to write every
  stage 2 hash into the record. No step reads `runs`, so nothing breaks.
- A5. `verify` is documented as read-only. It reads the chain only, but it rewrites the record through
  `record_create` on every run (`mainnet-deploy.sh:235`, `:185`) and writes `/tmp/mainnet-verify.log` (`:465`).
- A6. `preflight` needs `DEPLOYER_PRIVATE_KEY` (`mainnet-deploy.sh:286`), while the header lists it for `stage1`,
  `stage2` and `resume` only (`:10`). Read from the code.
- A7. USDC sent to the contract outside `buyPack` can never be paid out. The accounting ignores it
  (`PercentageFees.t.sol` `test_twoRaffleObligationsExcludeUnsolicitedSurplus`; handler `donate`).

### Test results

Run on 10 November 2026, offline, forge 1.8.5, from the worktree at the branch head.

| Command | Result |
|---|---|
| `forge test --root contracts` at 2078b82, before any change | PASS: 127 passed, 0 failed, 1 skipped (128 tests, 13 suites) |
| `forge test --root contracts --match-path "test/StateMachine*"` | PASS: 11 passed, 0 failed. Invariant: 128 runs, 38,400 calls, 0 reverts |
| `forge test --root contracts --match-path test/DeployMainnetHandoff.t.sol` | PASS: 5 passed, 0 failed |
| `contracts/test/mainnet-deploy/run.sh` | PASS: 15 passed, 0 failed |
| `contracts/test/mainnet-deploy/run.sh <driver at 2078b82>` | FAIL as intended: 13 passed, 2 failed (the two D1 tests) |
| `contracts/test/mainnet-deploy/run.sh <driver at f717a70>` | FAIL as intended: 1 passed, 14 failed. The E1, E2 and E3 tests fail for the defect each names; several others fail only because that driver's record has no `status` field |
| `forge test --root contracts` at the branch head | PASS: 143 passed, 0 failed, 1 skipped (144 tests, 16 suites) |
| `DeployMainnetForkTest` (21 tests, needs `MAINNET_FORK_RPC_URL`) | NOT_RUN: no network in this work. It is the 1 skipped above |
| Independent review of the changes | NOT_RUN: this part was produced by one agent without a reviewer |

Coverage notes for the invariant run. Three temporary probes, removed before commit, each failed as intended and so
showed that the random run reaches a deadline cancel from Closed, an abort from Drawing, and a run with both a paid
seller and a refunded buyer. `test_handlerReachesEveryPhaseAndTheInvariantsHoldAtEachStep` asserts on a fixed path
that every forward edge and a funded cancellation are taken, with the invariants checked after each of 400 steps.
The handler's warps total well under 365 days, so lot expiry is covered by the argument in section 5 and by
`test_expiredLotsDropOutOfSnapshot`, not by the invariant run.

## Server state machines (10 Nov 2026, main 2078b82)

This part covers everything that runs on the server: the draw runner, admin notifications, receipt mail, commitment
reservation, agreement records, the store, the wallet NFT proxy and the routes under `web/app/api`. The contracts and
the browser client are in the other parts.

It builds on the audit of 7 Nov 2026 (`docs/build/implicit-state-machines-20261107.md`, defect IDs D1 to D7) and on
commit 972f46c, which fixed the verified ones. Section "Status of D1 to D7" says what is fixed, open or accepted.

### How to read this

A lead counts as a confirmed bug only when a vitest test drove the real module through the sequence and observed the
invalid state. Each confirmed bug has a regression test that failed before the fix and passes after it. Claims marked
"by reading" were not executed.

The environment these machines run in:

- The store (`web/lib/points.ts:4`) has `get`, `set` and an atomic `setIfAbsent`. It has no delete, no TTL and no
  compare-and-set, so every first-wins record is permanent. Production is Neon (`web/lib/store.ts:145`). A write can
  land and still be reported as failed: the request is aborted after 5 s (`web/lib/store.ts:7`), and Neon maps every
  error except its own primary key conflict to "Store request failed" (`web/lib/store.ts:195`).
- Both crons fire every 5 minutes. A function can be killed between any two awaits, invoked twice at once, or retried.
- The runner signs real transactions with a hot key.
- Mail sends carry an idempotency key that the provider keeps for 24 hours (`web/lib/receipt-delivery.ts:103`).

Events considered for every machine: a kill between two store writes, two overlapping invocations interleaved at each
await, a retry after an uncertain provider or RPC answer, a chain reorg, an RPC that lags, a store write that fails
after the external side effect succeeded, and clock skew wherever a value is compared with `Date.now()`.

Phase numbers used below are the contract's: 0 Draft, 1 Open, 2 Closed, 3 Drawing, 4 Drawn, 5 Settled, 6 Cancelled.

### Summary of confirmed findings

| # | Severity | Finding | Fixed in |
|---|---|---|---|
| 1a | high (small amount) | The runner sent a step twice when the read after its own confirmed send came from a node one block behind | 5d05063 |
| 1b | high (small amount, narrow) | The runner sent a step again at the next nonce when its pending transaction was mined between the gas estimate and the nonce read | 5d05063 |
| 2 | medium | A replacement whose broadcast got no answer erases the record of the stuck transaction, so it is never replaced | not fixed; see issue 2 |
| 3 | medium for alerts, low for receipts | A reservation dated ahead of the reader's clock was treated as an expired retry window | 3196610 |

Severity scale, as in the earlier audit: high means a possible duplicate send or money at risk, medium means a user or
the operator is stuck until support acts, low means extra clicks, cosmetic or operator inconvenience.

### 1. Runner per-raffle decision and step loop

Code: `web/lib/draw-runner/decide.ts:15-35`, `web/lib/draw-runner/run.ts:143-248`.

#### States

The per-raffle state is not stored. It is derived on every loop turn from one pinned chain read
(`web/lib/draw-runner/run.ts:156`) by `nextRunnerAction` (`web/lib/draw-runner/decide.ts:15`).

| State | Encoding | Ref |
|---|---|---|
| Idle | No rule below matches: phase 0, 3, 5 or 6; phase 1 before sales end, with no lots, or past sales end plus the draw start grace; phase 2 past that deadline and not counted; phase 4 neither revealed nor past the reveal grace | decide.ts:25 |
| Needs close | phase 1, `close` enabled for any caller, `lotCount > 0`, block time before sales end plus draw start grace | decide.ts:21 |
| Needs count | phase 2, `snapshot` enabled (not yet `snapshotted`), before the same deadline | decide.ts:22 |
| Needs draw request | phase 2, `requestRandomness` enabled (count complete) | decide.ts:23 |
| Needs settle | phase 4, `settle` enabled | decide.ts:24 |

Inside one run each chosen step passes through: chosen, prepared and simulated at a pinned block
(run.ts:166), allowlisted (run.ts:176), nonce read (run.ts:184), quoted with a fresh estimate (run.ts:187), affordable
(run.ts:202), sent (run.ts:214) and confirmed (run.ts:235). The run-local variables are `batch` (run.ts:150, the count
batch size that fits the gas cap) and `confirmed` (run.ts:152, the step last seen confirmed and the count position it
was sent from). Each step ends as one report item: succeeded, reverted, unknown, failed, skipped, low-funds or gas-cap
(run.ts:73).

#### Invariants

- I1. The runner signs only `close`, `snapshot`, `requestRandomness` or `settle`, with zero value, on the raffle
  contract, for the raffle and batch it chose (`assertRunnerCall`, decide.ts:94).
- I2. A step is sent only after a simulation at a pinned block and a fresh gas estimate both accept it.
- I3. A step the runner saw confirmed is not sent again from the same raffle state in the same run.
- I4. No send starts with less than 25 s of the run left (run.ts:155, run.ts:213), and at most six sends leave per run
  (run.ts:163).
- I5. One raffle cannot stall the queue: a step that fails for a reason local to the raffle ends that raffle's loop and
  the run goes on.

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| any | loop turn | less than 25 s left | run stops `deadline`, cursor at this raffle | run.ts:155 |
| any | read | no step applies | Idle, next raffle | run.ts:158 |
| any | read fails or times out | | run stops `interrupted`, cursor after this raffle | run.ts:246 |
| step chosen | read shows the confirmed step again at the same count position (lagging node) | `confirmed` matches kind and `lotCursor` | item skipped, next raffle | run.ts:162 |
| step chosen | six sends already left | | run stops `send-cap`, cursor at this raffle | run.ts:163 |
| step chosen | simulation reverts | a fresh read no longer calls for it | item skipped, next raffle | run.ts:171-172 |
| step chosen | simulation reverts | a fresh read still calls for it | item failed, report not ok, next raffle | run.ts:171-172 |
| prepared | call is not the chosen step | | item failed `Refused`, nothing sent | run.ts:176-180 |
| prepared | estimate reverts (another caller took the step) | | item skipped, next raffle | run.ts:191 |
| prepared | estimate fails for funds | | item low-funds, next raffle | run.ts:192 |
| prepared | estimate fails otherwise | | item failed, run stops `interrupted` | run.ts:193-194 |
| quoted | max fee above 50 gwei | | run stops `fee-cap` | run.ts:196 |
| quoted | gas above the cap | count step and batch above 1 | batch halved, loop turn | run.ts:198 |
| quoted | gas above the cap | otherwise | item gas-cap, next raffle | run.ts:199 |
| quoted | balance below the limit at max fee plus a tenth | | item low-funds, next raffle | run.ts:202 |
| affordable | nonce shows a pending transaction | see section 2 | replace, or run stops `pending-transaction` | run.ts:203-212 |
| affordable | send refused by the node | funds | item low-funds, next raffle | run.ts:216 |
| affordable | send refused by the node | other | item failed, run stops `send-failed` | run.ts:217-218 |
| sent | broadcast outcome unknown | | item unknown, run stops `pending-transaction` | run.ts:229-232 |
| sent | no receipt in time | | item unknown, run stops `pending-transaction` | run.ts:236-239 |
| sent | receipt reverted | | item reverted, next raffle | run.ts:241 |
| sent | receipt succeeded | | `confirmed` set, loop turn | run.ts:242 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill between any two awaits before the send | Nothing was sent. The next run reads the chain again | safe |
| Kill after the send | The transaction is in the pool or mined. The next run sees the new phase or a pending nonce (section 2) | safe, with the limit in section 2 |
| Two overlapping runs | The lease lets one run through (section 3) | safe |
| Read lags the runner's own confirmed send | Before 5d05063 the step was sent again. Finding 1a | fixed |
| Read lags another caller's step | The pinned simulation passes on the stale block. The fresh estimate is the guard (run.ts:191). If the estimate is stale too, the runner sends a step that reverts | accepted, see suspicions |
| Reorg drops the block with the runner's step | The transaction returns to the pool and is mined again in nonce order. A later run reads the chain as it is | safe by reading |
| Clock skew | The loop compares only run-local time. The draw deadline uses the block timestamp (decide.ts:17) | not affected |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Same step sent twice for one raffle in one run | Reachable before 5d05063 through a lagging read. Test: "does not send %s again when the read after its confirmed send comes from a node one block behind" (`web/test/draw-runner.test.ts:985`). Unreachable now for a read at the same count position |
| A signed call other than the chosen step | Unreachable: `assertRunnerCall` runs on every prepared call before the quote. Test: "reports a prepared call %s as failed and refused, sends nothing for it and goes on" |
| A send with less than 25 s left | Unreachable: checked at the loop head and again just before the send. Test: "starts a send with exactly 25 seconds left and not with less" |
| A reverted step retried in the same run | Unreachable: run.ts:241 ends the raffle. Test: "reports a reverted send and does not retry it in the same run" |
| Report ok with an item that failed, reverted or is unknown | Unreachable: run.ts:253-254 |

### 2. Runner transaction in flight and nonce handling

Code: `web/lib/draw-runner/run.ts:95-117, 184, 203-232`, `web/lib/draw-runner/chain.ts:118-159`.

#### States

Encoded by the node's two nonce reads (`latest`, `pending`, chain.ts:118) and one store key, `draw-runner:last-send`
(run.ts:37), holding `{ runner, nonce, hash, maxFeePerGas, maxPriorityFeePerGas }`.

| State | Encoding |
|---|---|
| T0 idle | `pending == latest` |
| T1 own send pending, recorded | `pending == latest + 1`, record has this runner and `nonce == latest`, and the node holds `hash` unmined at that nonce (chain.ts:134) |
| T2 own send pending, record missing or stale | `pending == latest + 1`, record absent, unreadable, or for another nonce or runner |
| T3 another transaction at that nonce | `pending == latest + 1`, record matches, node does not hold `hash` (for example an operator's cancellation) |
| T4 several pending | `pending > latest + 1` |
| T5 mined | `latest` moved past the recorded nonce |

#### Invariants

- I6. At most one runner transaction is mined per nonce. The chain enforces this; the runner never signs for a nonce
  above `latest`.
- I7. With a transaction pending, the runner sends only a replacement at that same nonce, never a new nonce
  (run.ts:203-212).
- I8. Only the runner's own recorded send, alone in the pool, is replaced, with max fee and tip each at least a tenth
  higher (run.ts:96, 116) and under the 50 gwei cap (run.ts:209).
- I9. A stuck transaction of the runner's own is eventually replaced once suggested fees pass its own. This holds only
  while the record names the transaction the node holds. See finding 2 and the accepted limit below.
- I10. A step carried by a pending runner transaction does not land a second time at the next nonce.

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| T0 | send accepted | | T1, record written | run.ts:214, 223 |
| T0 | send outcome unknown | | T1 if it reached the pool, else T0. Record written either way | run.ts:223, 229 |
| T0 | send accepted, then kill or store failure before the record write | | T2 | run.ts:221-227 |
| T1 | next run, suggested max fee not above the recorded one | | wait, run stops `pending-transaction` | run.ts:115, 208 |
| T1 | next run, fees risen | bumped fee within cap and affordable | replacement sent at the same nonce | run.ts:207-214 |
| T1 | replacement accepted | | T1 with the new hash and fees recorded | run.ts:223 |
| T1 | replacement outcome unknown | | record kept, so the next run can still replace the original | run.ts:223 |
| T1 | replacement meets "nonce too low" | original was mined first | T5, run stops `pending-transaction` | chain.ts:153, run.ts:229 |
| T1 | original mined between the nonce read and the estimate | | estimate reverts, item skipped | run.ts:184-191 |
| T1 | original mined after the estimate | | wait if fees have not risen or the node no longer holds the hash, else the replacement fails on its nonce | run.ts:208, 229 |
| T2, T3, T4 | next run | | wait, run stops `pending-transaction` | run.ts:104, 208 |
| any | mined | | T5, then T0 | |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill between the broadcast and the record write | T2. The runner waits for the transaction and never replaces it | accepted limit, pinned by "waits for a pending transaction whose record was never written" (`web/test/draw-runner.test.ts:1437`) |
| Record write fails after the broadcast | Same as the kill | accepted limit |
| Uncertain broadcast answer on a first send | Record written. If nothing reached the pool the next run finds T0 and sends normally | safe |
| Uncertain broadcast answer on a replacement | Before 5d05063 the record was overwritten with a hash the node may not hold. Finding 2 | fixed |
| Node lags on the nonce | A stale low nonce makes the send fail with "nonce too low", reported unknown. No second transaction can be mined at a used nonce | safe |
| Pool view lags (pending read from a node without the transaction) | The runner sends at the same nonce. The pool keeps one of the two | safe |
| Reorg returns a mined transaction to the pool | `latest` drops back. The record may name a later nonce, so the runner waits (T2) until it is mined again | safe by reading |
| Two overlapping runs | Excluded by the lease. If both ran, both would sign the same nonce and one would be dropped | safe |
| Clock skew | No clock is compared here | not affected |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| A step sent at nonce N+1 while the runner's transaction for that step at nonce N is being mined | Reachable before 5d05063: the nonce was read after the estimate. Test: "does not send the step again at the next nonce when its pending transaction is mined right after the estimate and fees %s" (`web/test/draw-runner.test.ts:1478`). Finding 1b |
| Record names a hash the node does not hold while the node holds the runner's earlier send | Reachable through a replacement lost in transit, on `main` and on this branch. Confirmed and not fixed: see issue 2 |
| A replacement of someone else's transaction | Unreachable: `pendingAt` must confirm hash, nonce and sender. Test: "waits instead of replacing a transaction that took its recorded send's place" |
| A replacement above the fee cap | Unreachable. Test: "stops at the 50 gwei fee cap instead of replacing above it" |
| A new nonce used behind a pending transaction | Unreachable: every send uses `nonce.latest` (run.ts:214). Test: "waits for an earlier runner transaction instead of sending behind it" |

### 3. Runner lease, scan cursor and low-water mark

Code: `web/lib/draw-runner/run.ts:80-88, 119-142, 249-251`, `web/lib/draw-runner/decide.ts:43-91`.

#### States

| Machine | Encoding | States |
|---|---|---|
| Lease | One permanent row per five-minute bucket, `draw-runner:lease:5m:<bucket>` (run.ts:87), written with one atomic `setIfAbsent` for every bucket the run's `[start, deadline]` touches (run.ts:123) | free, held. A held bucket is never released; the next bucket is a new key |
| Scan cursor | `draw-runner:cursor` (run.ts:33), a raffle id | any id; out of range falls back to the low-water mark (decide.ts:46) |
| Low-water mark | `draw-runner:low-water` (run.ts:35), `<contract>:<id>` | every raffle below `id` was settled or cancelled when a scan read it; another contract's mark is ignored (run.ts:132) |

#### Invariants

- I11. Two runs whose `[start, deadline]` intervals share an instant on the same clock cannot both pass the lease.
- I12. A lease holder that died is replaced no later than the next free bucket.
- I13. The low-water mark never moves past a raffle that a scan did not read as final, or did not read
  (decide.ts:82-87).
- I14. The cursor is a hint. Any value is safe: the scan window always starts inside `[lowWater, nextId)` and wraps
  (decide.ts:43-50).
- I15. One unreadable raffle cannot stall the scan: the cursor resumes after it (decide.ts:89, run.ts:246).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| bucket free | run starts | all its buckets free | held, run proceeds | run.ts:123 |
| bucket held | run starts | any of its buckets held | report `busy`, ok, nothing read | run.ts:125 |
| held | run ends, is killed or times out | | stays held until the bucket passes | |
| cursor c | scan completes | | first id not read, wrapping | decide.ts:88 |
| cursor c | scan read fails | | id after the failed read | decide.ts:89 |
| cursor c | scan runs out of time | | first id not read | decide.ts:90 |
| cursor c | run stops at raffle id | | id, or id + 1 after a failed read, estimate or refused send | run.ts:142 |
| mark m | scan counted raffles m..k as final | k + 1 not final or not counted | k + 1 | decide.ts:86-87 |
| mark m | saved mark above the raffle count or for another contract | | scan restarts from 1 | decide.ts:69, run.ts:132 |
| cursor, mark | end of run | both writes within 2 s | saved | run.ts:250 |
| cursor, mark | cursor write fails or times out | | report `interrupted`; old values stay and the next run rescans | run.ts:251 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill before the cursor write | Old cursor and mark stay. The next run reads the same raffles again | safe |
| Kill between the two writes | They are independent `set` calls. Either alone is safe (I14, and the mark only ever rises over final raffles) | safe |
| Lease write lands but is reported failed | The run aborts with 503 and the bucket is spent with no work done | low, self-heals in the next bucket |
| Two overlapping invocations | One reports `busy`. Tests: "lets only one of two overlapping runs send", "lets only one of two runs straddling a boundary send" | safe |
| Run starts more than 4 min 4 s into its bucket | It also takes the next bucket, so the next scheduled run reports `busy` | low, one skipped run |
| Clock skew between two overlapping invocations | Buckets come from each server's own clock. Skew of minutes could give two overlapping runs disjoint buckets. Even then the nonce limits them to one transaction per nonce | accepted, see suspicions |
| Lagging node at scan time | A stale block shows fewer final raffles and a lower raffle count, so the mark can only stay or restart from 1 | safe |
| Reorg after a scan read a raffle as final | The mark has passed that raffle and never returns | see suspicions |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Mark above a raffle that is not final | Unreachable without a reorg: the mark advances only over counted reads that pass `finalPhase`, and final phases have no exits in the contract. Test: "never moves past a raffle whose read failed or did not finish" |
| Cursor outside the raffles | Harmless: falls back to the mark. Test: "restarts at the first raffle when the saved cursor is out of range" |
| Two runs sending in the same instant | Unreachable on one clock (I11). Test: "gives every pair of overlapping runs around a bucket boundary a shared key" |
| A run that never ends holds the runner forever | Unreachable: the lease is per bucket, and all work ends 4 s before the run deadline (run.ts:120) |

### 4. Notification ingestion cursors and activation boundary

Code: `web/lib/notifications/processor.ts:119-258` (run), `260-329` (pages), `625-645` (hints).

#### States

All keys share the prefix `raffle-notifications:v1:<chainId>:<contract>`.

| Record | Key | Kind | Meaning |
|---|---|---|---|
| Activation | `:activation` | first-wins, hash may be rewritten once | Block number and hash the deployment started watching from (processor.ts:127, 147) |
| Verified boundary | `:activation-verified` | first-wins | The activation block is final and its hash is the stored one (processor.ts:149) |
| Page | `:page:<start>` with `:ingestion-proof:<next>` | first-wins, written atomically together | The verified events of blocks `start..actualEnd` (processor.ts:321-324) |
| Ingestion hint | `:ingestion-hint` | overwritten | Next block to ingest. Trusted only if `:ingestion-proof:<hint>` names a stored page that ends just before it (processor.ts:625-645) |
| Last page | `:last-ingested-page` | overwritten | Start of the newest ingested page, so it is retried next run |

Activation states: not activated (no `:activation`), activated and unverified (`:activation` only), verified (both, same
hash), and invalid (both, different hash; every run throws at processor.ts:151).

Ingestion states: caught up (hint above the finalized block), behind (hint at or below it), replaying (hint missing or
unproven, so the run walks stored pages again from the first event block, two pages a run), and blocked (a source read
failed; an incident is recorded and the report is degraded, processor.ts:212-227).

#### Invariants

- I16. The activation block number never changes. The first event block is always that number plus one.
- I17. Nothing is ingested or mailed before the activation block is final and verified (processor.ts:136-152).
- I18. A page is immutable and covers only finalized blocks whose logs matched their canonical block hash
  (`web/lib/notifications/events.ts:140, 162, 174-180`).
- I19. Pages are contiguous: a page starts where the previous one ended, and the chain of pages from the first event
  block is unique, because each start has one first-wins record.
- I20. The ingestion cursor never skips a block. It is set only to the `nextBlock` of a stored page (processor.ts:202),
  and an unproven hint is treated as "start over", not as progress (processor.ts:638).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| not activated | first run | | activated, report `activated`, nothing else done | processor.ts:127-134 |
| unverified | run | finalized block below activation | unchanged, report `idle` | processor.ts:141 |
| unverified | run | activation block final, same hash | verified | processor.ts:149 |
| unverified | run | activation block final, different hash (reorg) | activation hash rewritten, then verified | processor.ts:145-149 |
| verified | run | stored hashes agree | proceed | processor.ts:151 |
| behind | run | page not stored | read events, halve the range while it is too dense, store page and proof, set hint | processor.ts:269-324, 202 |
| behind | run | page already stored (another run, or a replay) | load it, set hint | processor.ts:325-328, 202 |
| behind | source read fails or times out | | blocked for this run, incident recorded, hint unchanged | processor.ts:212-227 |
| any | hint missing, malformed or without a proof | | replaying from the first event block | processor.ts:632-638 |
| any | proof names no stored page, or a page that ends elsewhere | | run throws; ingestion stops until repaired | processor.ts:639-643 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill between the page write and the hint write | The next run starts at the old hint, finds the stored page and moves on | safe |
| Kill between the activation rewrite and the verified write | The next run reads the block again, finds the hashes equal and writes the verified record | safe |
| Two overlapping runs ingest the same start | One page write wins. The other run reads the stored page. Hint writes are last-writer-wins and can move the hint back, which only causes a re-read | safe |
| Two overlapping runs at an unverified, reorged activation | Both rewrite the same hash. A run that parsed the old activation and then reads the other's verified record throws once (processor.ts:151) and succeeds next time | safe by reading, one failed run |
| Store write lands but is reported failed | Page: the next run loads it. Hint: stays behind, re-read | safe |
| Reorg | Only finalized blocks are read. The activation block is re-anchored once before anything is ingested | safe. Test: "re-anchors a reorged activation block to the finalized block" |
| Lagging node | Finalized height below activation gives `idle` or a blocked run. A log read that silently returns fewer logs for a finalized range would be stored for good | see suspicions |
| Clock skew | Only deadlines within one process use the clock | not affected |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Verified record whose hash differs from the activation | Unreachable unless the node gives two different hashes for the same finalized block to two overlapping runs. See suspicions |
| Hint beyond a block with no stored page | Unreachable: the hint is written only after the page and its proof exist. Tests: "treats unproved future progress hints as replay hints", "fails closed when an immutable progress proof is malformed" |
| Two pages with the same start and different events | Unreachable: one first-wins key per start |
| An event from a block that is not final | Unreachable: events.ts:140 refuses the range, and the finalized head is pinned and rechecked (events.ts:172-180) |

### 5. Notification delivery reservation

Code: `web/lib/notifications/delivery.ts:91-178`, `web/lib/notifications/processor.ts:344-550`.

#### States

Per event, with `K = raffle-notification:<keccak(deployment, block hash, transaction hash, log index, event name)>`
(delivery.ts:48-49):

| State | Encoding |
|---|---|
| Unreserved | `K` absent |
| Reserved, retryable | `K` holds a valid reservation (immutable payload, `createdAt`, provider identity); no `K:accepted`, no `K:reconciliation`; same provider identity; the reader's clock is before `createdAt + 23 h` and not more than 1 h behind `createdAt` |
| Accepted | `K:accepted == "accepted"`. Terminal |
| Reconciliation required | `K:reconciliation` holds a reason, no `K:accepted`. Terminal; no mail is sent again |
| Accepted and reconciliation both present | Reads as accepted, because acceptance is checked first (delivery.ts:129-130) |

Per page, with `P = <prefix>:page:<start>`:

| Record | Kind | Meaning |
|---|---|---|
| `P:terminal:<i>` | first-wins | Event i reached accepted or reconciliation (processor.ts:503-507) |
| `P:terminal-prefix` with `P:terminal-proof:<n>` | hint with first-wins proof | The first n events are terminal (processor.ts:509-550) |
| `P:resume` | overwritten | Index to continue from, so a failed event yields to later ones (processor.ts:364-365, 428) |
| `<prefix>:retry-hint` with `:retry-proof:<next>` | hint with first-wins proof | Every page before the hint is all terminal (processor.ts:436-441) |
| `<prefix>:retry-scan-hint` | overwritten | Where the search for later non-terminal pages resumes (processor.ts:466-491) |

#### Invariants

- I21. An event is mailed at most once. Every send for an event carries the same key `K` and the same stored payload,
  and no send starts 23 h or more after the reservation, which is inside the provider's 24 h retention.
- I22. A terminal marker implies `K:accepted` or `K:reconciliation` was read back from the store
  (processor.ts:394-400, delivery.ts:162, 175).
- I23. The retry cursor never moves past an event without a terminal marker (processor.ts:434-441).
- I24. A page behind a page that stays pending is still retried inside its window (processor.ts:455-493).
- I25. At most three sends start per run, and no reservation is made when no send can start (processor.ts:371,
  delivery.ts:105).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| Unreserved | run reaches the event | a send can start | Reserved (first-wins) | delivery.ts:103-118 |
| Unreserved | run reaches the event | no send can start | unchanged, run stops this pass | delivery.ts:105 |
| Reserved | stored record fails validation | | Reconciliation `invalid-record` | delivery.ts:125 |
| Reserved | payload built now differs from the stored one | | Reconciliation `payload-configuration-changed` | delivery.ts:139-141 |
| Reserved | provider key changed | | Reconciliation `provider-identity-changed` | delivery.ts:265 |
| Reserved | 23 h passed, or reservation dated more than 1 h ahead | | Reconciliation `retry-window-ended` | delivery.ts:266 |
| Reserved | send acknowledged | no reconciliation written meanwhile | Accepted | delivery.ts:152-163 |
| Reserved | send acknowledged | reconciliation written meanwhile | Reconciliation (mail was sent) | delivery.ts:157-160 |
| Reserved | send refused, thrown or timed out | | Reserved, counted pending | delivery.ts:153-156 |
| Accepted or Reconciliation | run reaches the event | | terminal marker written | processor.ts:394-400 |
| page | all events terminal and page is at the retry cursor | | retry cursor moves to the next page | processor.ts:436-441 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill after the provider accepted, before `K:accepted` | The next run sends again with the same key and payload inside the window; the provider deduplicates. Test: "retries an uncertain provider attempt with the immutable original reservation and key" | safe |
| Same, but no run reaches the event for 23 h | Reconciliation `retry-window-ended`. The mail went once and the operator is told | by design |
| Kill between `K:accepted` and the terminal marker | The next run reads accepted and writes the marker | safe |
| Two overlapping runs on one event | Both send with the same key; one message. Both write acceptance | safe |
| Overlapping run records reconciliation between the answer and the acceptance write | Both markers exist; reads as accepted. Test: "lets acceptance win when an overlapping run records reconciliation between the provider's answer and the acceptance write" (`web/test/notification-delivery.test.ts:116`) | benign |
| Clock skew between overlapping runs | Before 3196610 a reader whose clock was behind the reservation recorded `retry-window-ended`. Finding 3 | fixed |
| Store write lands but is reported failed | Reservation, acceptance and markers are all re-read on the next run | safe |
| Reorg | The key includes the block hash, and only finalized events are stored | safe |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| `K:reconciliation` with reason `retry-window-ended` less than 23 h after the reservation | Reachable before 3196610 with a clock difference of any size. Tests: "retries a reservation written a moment ago by a server whose clock runs ahead" (`web/test/notification-delivery.test.ts:94`), "delivers once and records acceptance when two overlapping runs' clocks disagree by a fraction of a second" (`web/test/notification-processor.test.ts:197`) |
| Mail sent, reconciliation marker, no acceptance | Reachable when an overlapping run records reconciliation while the send is in flight (delivery.ts:157-160). Conservative: the operator is asked to check a delivered alert. Before 3196610 clock skew produced this |
| `K:accepted` and `K:reconciliation` together | Reachable, benign (see events) |
| Terminal marker with neither `K:accepted` nor `K:reconciliation` | Unreachable: both results are returned only after the marker's source record was read back |
| `K:accepted` without `K` | Unreachable: acceptance is written only after the reservation was parsed |
| Two mails for one event | Unreachable inside the provider's retention while the writer's and reader's clocks disagree by less than one hour in total; no send starts later than 23 h after the reservation by the reader's clock. The review showed that a writer 59 minutes ahead and a reader 59 minutes behind allow a send at a real age of 24 h 30 min. This predates the audit and is not changed by it |
| Retry cursor past a pending event | Unreachable (I23). Tests: "retries a later page's failed event inside its window while an earlier page stays pending", "stops a slow terminal-prefix scan at its phase deadline without advancing retry progress" |

### 6. Receipt delivery slots

Code: `web/lib/receipt-delivery.ts:25-63` (send), `75-88` (status).

#### States

Per purchase, with `S0 = receipt:v2:<keccak(chain, contract, transaction hash, log index)>`, `S1 = S0:1`, `S2 = S0:2`
(receipt-delivery.ts:90-97). A slot is reserved for one address, compared without letter case.

| Slot state | Encoding | Status shown |
|---|---|---|
| Empty | key absent | not listed |
| Reserved, retryable | record present, no `:sent`, same provider key, reader's clock before `createdAt + 23 h` and not more than 1 h behind `createdAt` | pending |
| Reserved, not retryable | record present, no `:sent`, provider key changed or window ended | unconfirmed |
| Delivered | `<slot>:sent == "delivered"` | delivered |

Slots fill in order. Full means all three are used (receipt-delivery.ts:87).

#### Invariants

- I26. Only the buyer of a finalized purchase can reserve a slot: the request is signed over the address, and the
  purchase is verified before the first write (receipt-delivery.ts:28, 39).
- I27. One address holds at most one slot of a purchase, and a purchase reaches at most three addresses.
- I28. `:sent` implies its reservation (receipt-delivery.ts:53-61).
- I29. No address is sent the same receipt twice: every send for a slot carries that slot's key and stored payload,
  inside the 23 h window.

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| Empty | request for a new address | signature valid, purchase verified | Reserved (first-wins) | receipt-delivery.ts:34-44 |
| any | request for an address already in a slot | | that slot is used | receipt-delivery.ts:50 |
| all three used | request for a fourth address | | refused | receipt-delivery.ts:52 |
| Reserved | send acknowledged | | Delivered | receipt-delivery.ts:59-61 |
| Reserved | send not acknowledged | | Reserved; the caller is told to retry | receipt-delivery.ts:60 |
| Reserved | provider key changed | | request refused; slot stays unconfirmed | receipt-delivery.ts:56 |
| Reserved | 23 h passed, or reservation dated more than 1 h ahead | | request refused; slot stays unconfirmed | receipt-delivery.ts:57 |
| Delivered | request again | | answered as a repeat, nothing sent | receipt-delivery.ts:54 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill or store failure after the provider accepted, before `:sent` | A retry inside 23 h sends again with the same key; the provider deduplicates. Test: "does not send if reservation fails and safely retries an uncertain delivered-marker write" | safe |
| Same, with no retry for 23 h | The slot stays unconfirmed for good. The buyer can use another address | by design, see ambiguities |
| Two overlapping requests, same address | One reservation wins, both send with the same key. Test: "reserves each purchase for one recipient across concurrent requests and recovers a lost response" | safe |
| Two overlapping requests, the later-started one reserves first | Before 3196610 the earlier request was refused as expired. Finding 3 | fixed |
| Two overlapping requests, different addresses | Each takes its own slot in order | safe |
| Reorg | The purchase must be in a finalized block before any slot is written | safe |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| A slot refused as expired less than 23 h after its reservation | Reachable before 3196610 without any clock skew. Test: "serves a request that started just before the overlapping request that reserved the receipt" (`web/test/receipt-agreement.test.ts:191`) |
| `:sent` without a reservation | Unreachable: the marker key is derived from a slot that was just read |
| The same address in two slots | Unreachable: a request walks the slots in order and stops at the first that holds its address, and each slot is first-wins |
| A slot reserved by a wallet that is not the buyer | Unreachable: an existing slot must carry the requester's address (receipt-delivery.ts:49), and a new one needs the verified purchase |
| A fourth address | Unreachable. Test: "lets the buyer correct the address, sending once to each address and to at most three" |

### 7. Commitment reservation

Code: `web/lib/reserve.ts:33-96, 124-144`, `web/lib/workflow-records.ts:19-49`, `web/app/api/reserve/route.ts`.

#### States

| State | Encoding |
|---|---|
| None | `reserve-request:v3:<identity>` absent. The identity is the hash of chain, contract, seller and the commitment input, without the signature deadline (workflow-records.ts:24) |
| Saved | `reserve-request:v3:<identity>` holds the commit hash and `reserve:<commit>` holds the record. Both are written in one atomic `setIfAbsent` (reserve.ts:87) |
| Saved, unbound (legacy callers only) | `reserve:<commit>` written with `set` and no request key (reserve.ts:93). No route uses this path |

#### Invariants

- I30. One signed request identity maps to one commitment for good. Retries and overlapping requests get the same
  nonce, salt and commit.
- I31. A request key always points to a record that passes its integrity check (reserve.ts:142).
- I32. A record is returned only to the seller who signed it, on the same chain and contract (workflow-records.ts:26,
  32, 47).
- I33. Nothing is saved before the signature is verified and the seller is shown to own the NFT
  (workflow-records.ts:21-22).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| None | signed request | signature valid, seller owns the NFT | Saved | reserve.ts:87 |
| None | two overlapping signed requests | | Saved once; the loser reads the winner's record | reserve.ts:88-92 |
| Saved | signed retry, any deadline | | same record returned | reserve.ts:48-49 |
| None | preparation recovery | | 404, the seller starts over | workflow-records.ts:45 |
| Saved | preparation recovery | seller, deployment and NFT match | public part returned | workflow-records.ts:46-48 |
| any | NFT does not exist or has no code | | 404, nothing saved | `web/app/api/reserve/route.ts:12-25` |
| any | ownership read or store fails | | 503, retry | `web/lib/workflow-failure.ts:14-18` |

Environment events: a write that lands but is reported failed is recovered by the retry, which finds the request key
(test "recovers the original immutable commitment after an ambiguous atomic-write timeout"). A kill before the write
leaves None. A lagging node can refuse a seller who just received the NFT, which a retry fixes. No clock is compared
except the signature deadline (see small machines).

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Request key without a record, or pointing to a record that fails integrity | Unreachable: one atomic write. Test: "never acknowledges failed writes or corrupt commitment records" |
| Two commitments for one request identity | Unreachable. Test: "atomically recovers one commitment across concurrent requests and signed retries" |
| A record returned to another wallet | Unreachable. Test: "keeps recovered secrets wallet-bound even with a valid attacker signature" |

### 8. Agreement record

Code: `web/lib/agreement-record.ts:17-42`, read side `web/lib/private-records.ts:24-50`.

#### States

One key per wallet, raffle and terms version: `agree:v2:<keccak(identity)>` (agreement-record.ts:28).

| State | Encoding |
|---|---|
| Absent | key absent |
| Recorded, valid | record present and its stored signature still verifies at its stored time |
| Recorded, unverifiable | record present, but the signing contract wallet no longer validates the signature (for example after its owners changed) |

#### Invariants

- I34. The first signed agreement for a wallet, raffle and terms version wins and is never replaced
  (agreement-record.ts:34).
- I35. A stored agreement is reported as recorded only while its signature verifies. A node that gave no verdict fails
  the request so it can be retried (private-records.ts:37-45).
- I36. One unverifiable agreement does not hide the wallet's other records.

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| Absent | signed agreement | terms published, signature valid and fresh | Recorded | agreement-record.ts:34 |
| Recorded, valid | another signed agreement, any deadline | | unchanged; the stored one is re-verified and its key returned | agreement-record.ts:35-41 |
| Recorded, valid | signing wallet stops validating the signature | | Recorded, unverifiable | |
| Recorded, unverifiable | records read | | shown as not recorded, other records returned | private-records.ts:43-45 |
| Recorded, unverifiable | another signed agreement | | refused: the stored record fails its re-check | agreement-record.ts:40 |

Two overlapping writes are safe: one wins and the other validates the winner. There is no external side effect, and
the only clock comparison is the signature deadline.

#### Illegal combinations checked

| Combination | Result |
|---|---|
| A record for terms that were not published | Unreachable: checked before the write (agreement-record.ts:19) |
| An unverifiable agreement reported as recorded | Unreachable. Test: "leaves out a stored agreement its contract signer no longer validates and returns the other records" |
| A wallet that can never record again for a raffle | Reachable by reading: Recorded, unverifiable has no exit, because the key is first-wins and the stored record must pass (agreement-record.ts:40). Accepted in the earlier audit: no UI writes agreements since easy buy |

### 9. Small machines

| Machine | Location | States and encoding | Invariant | Checked |
|---|---|---|---|---|
| Runner run status and ok verdict | `web/lib/draw-runner/run.ts:76-78, 142, 253-254` | Status: complete, busy, send-cap, deadline (healthy) and low-funds, fee-cap, pending-transaction, send-failed, interrupted. One mutable `report.status` | An unhealthy status is never overwritten by a later stop (run.ts:142). Ok needs a healthy status, progress on a deadline stop, and every item succeeded or skipped | A failed scan read stays reported when the run later stops at the send cap. Test: "still reports a failed scan read when the run later stops at the send cap" |
| Notification run status | `web/lib/notifications/processor.ts:239-242`, `web/lib/notifications/http.ts:70` | activated, idle, ok, degraded, reconciliation-required, from counters | Degraded wins over reconciliation; both make the cron answer not ok | Pending sends alone leave the status ok. See ambiguities |
| Admin connection test | `web/lib/notifications/delivery.ts:64-89` | Same reservation machine as section 5, keyed by the mail configuration | One test mail per sender and provider key | A test that stays unacknowledged for 23 h is reconciliation-required for good for that configuration. See ambiguities |
| Cron gates | `web/lib/draw-runner/http.ts:22-38`, `web/lib/notifications/http.ts:124-144` | not configured (503), unauthorized (401), key missing or privileged (503), run | No chain or key read before the bearer check; the runner key must not be the owner, a Safe signer or the treasury | Tests in `web/test/cron-bearer.test.ts` and "requires the cron secret before reading the key or the chain" |
| Workflow route stage | `web/lib/workflow-failure.ts:14-21` and the routes | A mutable `stage` variable: request, deployment, records | Refusal is 401 and missing is 404 at any stage; otherwise 400 at the request stage and 503 after it | `/api/agreements` and `/api/email/receipt` do not use it and answer 400 for outages. See ambiguities |
| Signature freshness | `web/lib/chain/server.ts:85-86`, `web/lib/request-auth.ts:24-25` | A deadline accepted while it is between now and now + 600 s on the server clock | A signature is single-purpose and short-lived | The client signs now + 300 s, so a client clock more than 5 minutes off in either direction is always refused with a "retry" message. Low, by reading |
| Wallet NFT rate limits | `web/lib/wallet-nfts-server.ts:150-159, 202-209` | Three maps of `{ window, count }` per minute: client address, owner, global upstream | 30 a minute per client and per owner, 120 a minute upstream; maps hold at most 1,024 keys | Eviction lets many distinct keys push out old entries; the per-client limit still bounds one client. Test: "enforces per-owner request limits before a cached response" |
| Wallet NFT concurrency slots | `web/lib/wallet-nfts-server.ts:146-148, 207-215` | `active` counter (0 to 4) and an in-flight map per cache key | A slot is released on every exit; identical misses share one upstream call | Unreachable leak: the counter is raised just before a `try` whose `finally` lowers it. Tests: "times out without retrying and releases the concurrency slot", "coalesces identical misses" |
| Public feed cache and cursor | `web/lib/notifications/public-feed.ts:24, 100-113, 115-131` | Map of promise entries with a 60 s expiry; cursor is an event position or a block bound | A failed read is not cached; a cursor that no longer matches finalized history is refused (public-feed.ts:81) | By reading |
| Points check-in | `web/lib/points.ts:36-55` (not edited here) | `{ balance, lastDay }` per address, read then `set` | One award per UTC day | Two overlapping check-ins both write the same value, so the balance rises once. By reading |
| Store providers | `web/lib/store.ts:113-134` | neon, upstash, memory, file by `LABX_STORE` | Vercel refuses a non-persistent provider | Tests in `web/test/store.test.ts` |

### Findings

#### Issue 1. The draw runner can send the same step twice (high, small amount)

Two sequences, one outcome: a second transaction for a step that already landed. A second `close`, draw request or
settle reverts on chain and costs its gas at up to the 50 gwei fee cap (a successful `close` used 34,698 gas on
Sepolia, and a reverting one uses less), and the run reports not ok. A second count batch continues from the real
position, or reverts when the count had already finished.

**1a. Read behind the runner's own confirmed send.**

1. The runner reads raffle 1 as Open and sends `close` at nonce 0. The receipt says succeeded.
2. The loop reads raffle 1 again (`web/lib/draw-runner/run.ts:156`). The answer comes from a node one block behind, as
   a load-balanced RPC can give, and still shows Open.
3. The pinned simulation and the estimate run against that same stale state and pass. The nonce read is fresh.
4. The runner sends `close` again at nonce 1.

- Test: "does not send %s again when the read after its confirmed send comes from a node one block behind"
  (`web/test/draw-runner.test.ts:985`), for `close` and for `snapshot`.
- Before, observed: sends were `1:close:0, 1:close:1, 1:snapshot:2, 1:requestRandomness:3, 2:settle:4`; for the count
  step `1:snapshot:0, 1:snapshot:1, 1:snapshot:2, 1:requestRandomness:3, 2:settle:4`.
- Fix: the loop keeps the step it saw confirmed and the count position (`lotCursor`) it was sent from
  (run.ts:152, 242). A read that calls for the same step from the same position ends that raffle for this run with a
  skipped item (run.ts:162). A confirmed step always changes the phase or moves the count on, so a real second batch
  never matches.
- After, observed: sends are `1:close:0, 2:settle:1`, items `1:close:succeeded, 1:close:skipped, 2:settle:succeeded`,
  report ok, and the next run sends the count and the draw request.

**1b. Pending transaction mined between the estimate and the nonce read.**

1. A previous run sent `close` at nonce 0 and it is still pending.
2. This run reads Open, simulates and estimates `close`. Both pass, because the pending one is not mined yet.
3. The pending `close` is mined.
4. The runner reads the nonces: latest 1, pending 1. Nothing looks pending, so it sends `close` at nonce 1.

- Test: "does not send the step again at the next nonce when its pending transaction is mined right after the estimate
  and fees %s" (`web/test/draw-runner.test.ts:1478`), with fees unchanged and risen.
- Before, observed: the run reported `sends: 1`, a `close` at nonce 1.
- Fix: the nonce is read before the estimate and again after it. A transaction mined before both fails the
  estimate; one mined between them shows as a changed latest nonce and the run stops with `pending-transaction`.
- Review correction: the first version of this fix read the nonce only before the estimate. The independent review
  showed that this let a transaction that reached the pool during the estimate, such as an operator's cancellation
  at the runner's nonce, go unseen, so the runner replaced it with its own step. The second read decides what is sent,
  as before the change. Test: "sends nothing when another transaction takes the runner's nonce in the pool while the
  step is being estimated". FAILED on the first version (one send), PASSES now (no send).
- After, observed: `sends: 0`, status `pending-transaction`, and the next run sends `snapshot:1,
  requestRandomness:2`.

#### Issue 2. An unconfirmed replacement erases the record of the stuck transaction (medium, not fixed)

1. The runner's `close` at nonce 0 is stuck: fees rose past its own. The record names its hash and fees.
2. The next run sends a replacement at nonce 0 with bumped fees. The request times out or the provider answers with an
   HTTP error, so the outcome is unknown and the node never saw it.
3. The runner overwrote `draw-runner:last-send` with the replacement's hash and fees.
4. Every later run asks the node whether it holds the recorded hash. It does not, so the runner waits. The transaction
   the node does hold is never replaced, and the runner sends nothing until fees fall or the operator steps in with
   the hot key. Draws can still be triggered by anyone on chain.

- Code: the record write after the send in `web/lib/draw-runner/run.ts`.
- Status: confirmed and NOT fixed. The behavior on this branch is the same as on `main`.
- Why it is not fixed: three attempts each failed independent review. Keeping the original record stalled the runner
  when the node had accepted the replacement. Recording the replacement together with the sends before it recovered
  both cases, but a third review showed it could forget a send after several unanswered broadcasts across nodes that
  disagree, drop its history on an acknowledged lower-fee send, and widen which stored records authorize a
  replacement. Each version traded one stall for another, so the change was withdrawn rather than merged.
- What a fix needs: the runner must know which of its own transactions the pool holds. That means recording the signed
  transaction's hash before it is broadcast and treating every recorded hash for the nonce as its own until the nonce
  is used, with a design review before code.
- Until then: a stuck runner transaction whose replacement was lost is waited for. It ends when the transaction is
  mined, when fees fall to it, or when the operator replaces it by hand with the cron stopped. Draws can still be
  triggered by anyone on chain.
- A related case that already works and is now pinned: a replacement the node accepted without answering is replaced
  later with fees bumped from its own. Test: "replaces a replacement the node accepted without answering, bumping from
  that replacement's fees".

#### Known limits of the runner's send path, not fixed

The second independent review would not fund the runner on mainnet because of the first two items. Both exist on
`main` today and are not made worse by this branch. They are recorded here for the owner's decision, together with
issue 2 above.

1. A transaction from the runner's key that reaches the pool after the runner's last check is replaced by the
   runner's step if the step pays more. The check and the send are separate calls, so this window cannot be closed
   from inside the runner; this branch narrows it to the time between the second nonce read and the broadcast.
   Operational rule: stop the cron, or wait out its lease, before using the runner key by hand.
2. A step that was mined before the run's nonce reads can be sent again at the next nonce when the gas estimate is
   answered by a node one block behind. The contract refuses the duplicate, so the cost is the gas of one reverted
   transaction, bounded by the fee and gas caps. Closing it needs the raffle read, the estimate and the nonce pinned
   to one block no older than the runner's last mined transaction.
3. A kill or store failure between the broadcast and the record write leaves a pending transaction with no record.

What this branch does change in the send path costs at most one cron period in three cases, in exchange for not
sending a step twice: a chain reorganisation that removes a step this run just saw confirmed is read as a stale node,
so the step is sent by the next run; a failed first nonce read ends work on that raffle for this run; and two nonce
reads that disagree stop the run with `pending-transaction`.

Accepted limit in the same machine, not fixed: a kill or store failure between the broadcast and the record write
leaves no record, so that transaction is waited for and never replaced. The window is one store write. Closing it
needs the hash before the broadcast, which means splitting `DrawChain.send` into sign and broadcast. Pinned by "waits
for a pending transaction whose record was never written" (`web/test/draw-runner.test.ts:1437`).

#### Issue 3. A reservation dated ahead of the reader's clock is treated as expired (medium for alerts, low for receipts)

Both mail paths stamp a reservation with a clock reading and refused any reader whose own reading was earlier.

**Admin alerts** (`web/lib/notifications/delivery.ts:266`). The refusal writes a permanent reconciliation marker.

1. Two cron invocations overlap. Run A's server clock is 250 ms ahead of run B's.
2. A reserves the event with `createdAt` 5,250 and starts the provider request.
3. B reads the reservation at its own time 5,000, sees `now < createdAt`, and records `retry-window-ended`.
4. If A's request succeeds, A finds the marker and reports reconciliation too. The alert was mailed, but there is no
   acceptance record and the cron answers not ok. If A's request is not acknowledged, the alert is never sent.

- Tests: "retries a reservation written a moment ago by a server whose clock runs ahead"
  (`web/test/notification-delivery.test.ts:94`) and "delivers once and records acceptance when two overlapping runs'
  clocks disagree by a fraction of a second" (`web/test/notification-processor.test.ts:197`).
- Before, observed: `{ status: "reconciliation-required" }`, and in the processor test the stored marker
  `{"version":1,"reason":"retry-window-ended","recordedAt":5000}`.
- After, observed: both runs report accepted, one message key reached the provider, `K:accepted` is set and no
  reconciliation marker exists.

**Receipts** (`web/lib/receipt-delivery.ts:57, 84`). Here `now` is the time the request started, so no clock skew is
needed.

1. Request 1 starts at t. Request 2 for the same receipt and address starts at t + 40 ms and reserves first.
2. Request 1 reads a reservation dated t + 40 ms, later than its own t, and is refused with "Receipt delivery needs
   reconciliation; the safe retry window has ended." Private records show the address as unconfirmed for a reader with
   the earlier time.

- Test: "serves a request that started just before the overlapping request that reserved the receipt"
  (`web/test/receipt-agreement.test.ts:191`).
- Before, observed: status `unconfirmed`, and the request rejected with the reconciliation message.
- After, observed: status `pending`, then `{ delivered: true, repeated: false }` with one send.

Fix for both: a reservation dated up to one hour ahead is accepted (`CLOCK_SKEW_MS`, delivery.ts:12; `CLOCK_SKEW`,
receipt-delivery.ts:14). One hour is the margin the 23 h window already leaves inside the provider's 24 h retention, so
the design already assumes clocks agree that closely. The 23 h cutoff is unchanged, and a reservation dated further
ahead still needs reconciliation (tests "records reconciliation for a reservation dated more than an hour ahead of this
server's clock" and the second half of the receipt test).

### Status of D1 to D7

| ID | Earlier finding | Status at 2078b82 plus this branch | Proof |
|---|---|---|---|
| D1 | A notification on a page behind a pending page missed its retry window | Fixed in 972f46c and 450dee4: later non-terminal pages are searched each run | "retries a later page's failed event inside its window while an earlier page stays pending" and "reaches a later failed event %s pages past a page that stays pending, inside its window" (`web/test/notification-processor.test.ts:105, 151`) |
| D2 | A receipt sent to a mistyped address was bound for good | Fixed: three address slots per purchase | "lets the buyer correct the address, sending once to each address and to at most three" (`web/test/receipt-agreement.test.ts:107`) |
| D3 | An agreement signed by a Safe became invalid after an owner change and `/api/records` answered 503 | Read side fixed: shown as not recorded. Write side open and accepted: that wallet cannot record again for that raffle (section 8) | "leaves out a stored agreement its contract signer no longer validates and returns the other records" (`web/test/workflow-records.test.ts:83`) |
| D4 | A reserve request that never reached the server left Create asking for a recovery signature and getting 503 | Fixed: recovery answers 404 and the seller starts over | "reserve/preparation answers 404, so the seller starts over, when the server never saved that setup" (`web/test/workflow-route-failures.test.ts:195`) |
| D5 | An `ownerOf` revert answered 503 | Fixed: a revert or missing code answers 404; a node failure still answers 503 | "reserve answers 404 with a plain message, and saves nothing, when the NFT read %s" and "reserve answers 503, not a missing NFT, when the node fails the ownership read (%s)" (`web/test/workflow-route-failures.test.ts:185, 179`) |
| D6 | A shallow reorg of the activation block left the deployment reconciliation-required for good | Fixed: the boundary is re-anchored to the finalized block before anything is ingested | "reads and mails nothing before finality, then re-anchors a reorged activation block to the finalized block" and "recovers a deployment that an earlier build marked for activation reconciliation" (`web/test/notification-processor.test.ts:64, 89`) |
| D7 | The runner stalled on a stuck transaction | Mostly fixed in f767de7 by replacement. Two limits remain: a replacement lost in transit leaves the stuck transaction unreplaced (issue 2, not fixed), and a transaction whose record was never written is waited for | "replaces its own stuck transaction at the same nonce with bumped fees once suggested fees rise"; "waits for a pending transaction whose record was never written, as after a kill between the broadcast and the store write" |

### Suspicions not reproduced

These follow from reading the code. None was driven to an invalid state by a test, either because the trigger is an
RPC fault the fakes would only assume, or because it needs two independent faults.

1. Low-water mark and reorgs. The scan reads at the latest block (`web/lib/draw-runner/chain.ts:99`). If a block that
   settled or cancelled a raffle is dropped and that transaction never returns, the mark has already passed the raffle
   and the runner never reads it again. The transaction normally returns to the pool and is mined again.
2. Withdrawn: this concerned the replacement record change, which is not part of this branch (see issue 2).
3. Stale reads the estimate does not catch. If a node serves a stale state to the read, the simulation and the
   estimate while serving a fresh nonce, the runner sends a step another caller already took. Issue 1a covers only the
   runner's own confirmed step.
4. Lease split by clock skew. Two overlapping invocations on servers whose clocks differ by minutes can hold disjoint
   buckets. The nonce still allows one transaction per nonce.
5. Incomplete logs for a finalized range. Log reads are checked against canonical block hashes, not for completeness.
   A node that returns fewer logs without an error produces a permanent page without the event, and that alert is
   never sent.
6. Activation and verified hashes that disagree. If a node gives two overlapping runs different hashes for the same
   finalized block, the last activation write and the first verified write can differ, and every later run throws at
   `web/lib/notifications/processor.ts:151`.
7. Alert throughput after a long outage. Each run starts at most three sends. Events reserved during a provider outage
   share one 23 h window, so with more than about 36 pending events per remaining hour the last ones reach
   reconciliation unsent. Raffle creation and opening are far rarer than that today.
8. Receipt slots spent without mail. A slot is reserved before the send. Three failed attempts to three addresses
   leave the purchase full with nothing delivered.

### Ambiguities of intended behavior

1. Should a notification run whose sends were all unacknowledged answer ok? Today pending sends do not change the
   status (`web/lib/notifications/processor.ts:239-242`), so a provider outage is invisible in the cron answer for up
   to 23 h, after which the events become reconciliation-required.
2. Should an unacknowledged receipt or alert be retried after 23 h? Today it never is. A buyer whose first attempt
   failed and who comes back the next day cannot get the receipt at that address, only at another one. The cost of
   retrying would be a possible duplicate mail.
3. Should a changed sender address or site origin cancel pending alerts? Today the stored payload is not sent and the
   event becomes `payload-configuration-changed` for good (`web/lib/notifications/delivery.ts:139-141`), although the
   stored payload could still be sent under the same key.
4. Should the admin connection test be repeatable? Today one configuration sends one test mail ever, and a test left
   unacknowledged for 23 h can never be completed without changing the sender or the provider key.
5. Should a lagging node make the runner's report not ok? The fix for issue 1a reports a skipped item and keeps ok
   true, like a step another caller took.
6. Should the runner act on a raffle stuck in Drawing when the randomness never arrives? Today it has no step for
   phase 3.
7. Should `/api/agreements` and `/api/email/receipt` answer 503 for outages like the other signed routes? Today they
   answer 400 with a fixed message.
8. Is it intended that the same seller, NFT and texts always get the same commitment, including for a second raffle of
   the same NFT? The identity leaves out the deadline on purpose so retries recover the record
   (`web/lib/workflow-records.ts:23-24`), and the record is permanent, so the nonce and salt repeat.

### Test results

All commands ran in the worktree. The full suite and the type check ran at 3196610, the last code change on this
branch; the commit that adds this file changes no code.

| Check | Command | Result |
|---|---|---|
| Baseline at 2078b82 | `npx vitest run` in `web` | PASS: 75 files passed, 51 skipped; 1,263 tests passed, 369 skipped |
| Regression tests before each fix | `npx vitest run test/draw-runner.test.ts`, `test/notification-delivery.test.ts`, `test/notification-processor.test.ts`, `test/receipt-agreement.test.ts` | FAIL as expected: 5 runner cases (2 for 1a, 2 for 1b, 1 for issue 2), 2 delivery cases, 1 processor case, 1 receipt case |
| Full suite at the final code | `npm --prefix web test` | PASS: 75 files passed, 51 skipped; 1,275 tests passed, 369 skipped |
| Types | `npx --prefix web tsc --noEmit -p web/tsconfig.json` from the repository root | PASS, exit 0 |
| Types, exactly as requested | `npx tsc --noEmit -p web/tsconfig.json` from the repository root | NOT_RUN as written: the root has no `node_modules`, so `npx` fetched an unrelated `tsc` package that exits 1 without compiling. The row above is the same check with the project's TypeScript |
| Opt-in lanes (integration, browser, fork: the 51 skipped files, 369 tests) | | NOT_RUN |
| Independent review of the first candidate (3196610) | Codex review with its own 19-case probe | FAIL: two runner findings (cancellation replaced during the estimate; accepted but unanswered replacement stalls). Both are fixed in the following commit with the two tests named under issues 1 and 2 |
| Second independent review, at cb3599d | Codex review with its own 37-case probe | FAIL: one new corner in the replacement history, plus two findings that predate this branch |
| Third independent review, at 02b9ca1, against `main` | Codex differential review, 37 probes run against both versions | DO NOT MERGE: the replacement history was less safe than `main` in four sequences. The stale-read guard and the nonce reads were rated safer than `main` (no duplicate send where `main` sends two) |
| After withdrawing the replacement history | `npx vitest run test/draw-runner.test.ts` | PASS: 211 of 211 |
| Fourth independent review, at d901c0f | Fresh review of the final runner diff with a probe run against both versions | PASS: record handling is identical to `main`; both changes only add exits before a send. In a sweep of 189 single-fault runs the branch wasted 11 sends against 37 on `main`. Noted: a read two steps behind still sends a duplicate, as on `main`; under lasting node disagreement the nonce check can limit a run to one step |

New tests on this branch: five in `web/test/draw-runner.test.ts` for issue 1 (two stale-read cases, two mined-during-estimate cases, one pool arrival during the estimate), one that pins the accepted unrecorded-transaction limit and one that pins recovery from a silently accepted replacement; three in `web/test/notification-delivery.test.ts`, one in `web/test/notification-processor.test.ts` and one in `web/test/receipt-agreement.test.ts`.

## Client state machines (10 Nov 2026, main 54f317e)

This part covers everything that runs in the browser: the modules under `web/lib/chain` that a page calls and the
components under `web/components`. The contracts and the server are in the other parts.

It builds on the audit of 7 Nov 2026 (`docs/build/implicit-state-machines-20261107.md`, defect IDs A1 to A5, B1 to B7
and C1 to C6), on commit 972f46c, which fixed the verified ones, and on `docs/audits/frontend-consistency.md`, whose
fixed bugs are not repeated here. Section "Status of A1 to A5, B1 to B7 and C1 to C6" says what is fixed, open or
accepted.

### How to read this

A lead counts as a confirmed bug only when a test drove the real module or the rendered page through the sequence and
observed the invalid state. Each confirmed bug has a regression test that failed before its fix and passes after it.
Claims marked "by reading" were not executed.

The environment these machines run in:

- State lives in three places. React state and refs die with the component or the tab. Module singletons (the outcome
  owner, the check registries, the AppKit runtime, the wallet session) live until the page reloads and survive
  client-side navigation. `localStorage` is shared by every tab of the origin and survives reloads; every key that
  holds transaction or recovery data includes the chain, the contract, its runtime code hash and the account.
- Web Locks serialize tabs. A lock is released when its tab closes, so a lock is never left held by a dead tab.
- The wallet is outside LABx's control. It can answer a request with a hash, a rejection, an error that says nothing,
  nothing at all, or a hash it later replaces. It can also send through its own RPC, which LABx's RPC may see late.
- The read RPC is load balanced. A read of "latest" can come from a node behind a transaction the page has just
  confirmed, and a pending-nonce read can miss a transaction another node holds.
- A receipt counts once it is two blocks deep (`RECEIPT_CONFIRMATIONS`, `web/lib/chain/service.ts:35`). That is
  progress, not finality.

Events considered for every deep machine: reload and tab close at each step, two tabs of the same account, an account
or chain switch mid-flow, a wallet rejection, a wallet that returns no hash, a wallet error with a bare -32603 or
-32000 code, an RPC that lags or fails, a dropped or replaced transaction, a reorg, `localStorage` unavailable or full,
and Web Locks unavailable.

Line numbers refer to the tree at 9032cdd, the last code change on this branch.

### Summary of confirmed findings

| # | Severity | Finding | Fixed in |
|---|---|---|---|
| 1 | high (narrow trigger, costs gas and leaves a second draft) | After a wallet error that only a -32603 or -32000 code marked as unsent, Create forgot the draft step's nonce. When the wallet had in fact sent the draft, a later Create sent `createRaffle` again | 3bc0972 |
| 2a | medium | A send that outlasted its first one-minute watch and was then replaced or dropped by the wallet left its control on "Still confirming" for good, and the page kept showing the state from before a replacement that had landed | 8bf7034, 9032cdd |
| 2b | low | The same control stayed on "Still confirming" when another tab of the same wallet confirmed the transaction first | 8bf7034 |

Severity scale, as in the earlier audit: high means a duplicate or unrequested transaction, or money at risk; medium
means a user is stuck until support or a reload; low means extra clicks or cosmetic.

No reachable invalid state was found in the pending journal itself, the outcome owner, the buyer's approve-then-buy
handoff, the owner Safe flow or the wallet connection machines. The leads that were not reproduced are under
"Suspicions not reproduced".

### 1. Pending-send journal and settlement

Code: `web/lib/chain/pending-journal.ts`, `web/lib/chain/service.ts:128-297, 379-483`,
`web/lib/chain/wallet-session.ts:121-136`, `web/lib/chain/wallet-errors.ts`, `web/lib/chain/network-fee.ts`.

#### States

One machine per account and deployment. It is encoded by:

| Part | Encoding | Ref |
|---|---|---|
| Record R | `localStorage` `labx:pending:v1:{chain}:{contract}:{codehash}:{account}` holding `{ id, intentHash, nonce, startedBlock, hash }`, `hash` null until the wallet returns one | pending-journal.ts:5, 58-59, 66-68 |
| Marker M | `labx:pending-cleared:v1:{chain}:{contract}:{codehash}:{account}` holding `{ nonce, startedBlock }`: the last record cleared without proof that nothing was sent. An unreadable marker reads as nonce -1 | pending-journal.ts:7, 25-32, 60, 69-74 |
| Journal lock X | Web Lock named by the record key | pending-journal.ts:75 |
| Request lock Q | Web Lock `{record key}:request`, held while a wallet request for the account is open in any tab | pending-journal.ts:76-87 |
| In-tab guards | `submitting` set by account, and the `used` flag of the reviewed action | service.ts:45-46, 144-145, 233 |
| Chain verdict for the record's nonce N | From the latest nonce L, the pending nonce P and the head: unsent (L = N, P = N), expired (unsent for 25 blocks from `startedBlock`), spent (L > N, P = L, and the nonce at the block below the head equals L), otherwise waiting | service.ts:243-254 |

| State | Encoding |
|---|---|
| J0 idle | no R, no M |
| J0m idle, marker | no R, M present |
| J1 requesting | R with `hash` null and Q held: a wallet prompt is open in some tab |
| J2 hashless | R with `hash` null and Q free: the wallet answered without a usable hash, or the tab reloaded or closed |
| J3 hashed | R with a hash the chain knows, pending or mined less than two deep |
| J4 orphaned | R with a hash the chain no longer knows: the wallet replaced or dropped it |

#### Invariants

- J-I1. At most one record per account and deployment. A send does not start while a record exists
  (service.ts:144, 173) or while any tab holds Q (service.ts:147, pending-journal.ts:78-79).
- J-I2. The record is written under X before the provider is called, after the session was checked again
  (wallet-session.ts:126-134, service.ts:171-177). If the write fails, nothing is dispatched.
- J-I3. A record is removed only by: its own request when the wallet refused or was never asked (service.ts:190-199);
  a wallet failure that is pre-broadcast evidence with nothing at N (service.ts:203-227); a canonical receipt at its
  nonce or for the hash the wallet returned (service.ts:403-416); or `settlePending`, when N is spent, or nothing is at
  N and the person chose Continue (hashless only) or 25 blocks passed (service.ts:260-285).
- J-I4. Every removal without proof that nothing was sent (Continue, the 25-block clear, the code-only retirement)
  writes M first (service.ts:222, 281). M goes only when a mined nonce has passed it (service.ts:163-166), a receipt
  landed at its nonce (service.ts:415) or `settleCheckpoint` saw that nonce spent (service.ts:294).
- J-I5. With M present and P above M's nonce, no wallet request opens (service.ts:162-168).
- J-I6. No tab settles a record from the chain while a wallet request for that account is open in any tab
  (service.ts:266, 271, 291).
- J-I7. Every send carries the pending nonce read just before it (service.ts:158, 170). Two sends LABx makes for one
  intent around a cleared record therefore share a nonce while that nonce is unused, and a wallet that honors the
  nonce mines one of them. This does not hold once the first send's nonce is used and its result is not found: the
  Create recovery then sends at the next nonce (open issue 3).
- J-I8. The service tells a caller that its send was not dispatched, so the caller may drop its own checkpoint, only
  when the wallet refused, was never asked, or its own message says it sent nothing (service.ts:196, 223). Before
  3bc0972 it also did so after a code-only failure. Finding 1.

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| J0, J0m | submit | review unused, session current, account has no contract code, no R | continues below | service.ts:133-147 |
| J0, J0m | submit | another tab holds Q | unchanged, "Your wallet already has a request from LABx open"; the review is spent | pending-journal.ts:78-79 |
| J0, J0m | submit | gas × 1.5 × max fee + value above the balance, or the estimate fails | unchanged, `NotSentError`, wallet not opened | service.ts:157, network-fee.ts:33-43 |
| J0m | submit | P above M's nonce and L above it | J0, `EarlierSendError`, wallet not opened | service.ts:162-167 |
| J0m | submit | P above M's nonce, L not above it | J0m, `EarlierSendError` | service.ts:162-167 |
| J0m | submit | P not above M's nonce | J1 at nonce P | service.ts:162, 170 |
| J0, J0m | wallet request | record written, session still current | J1 | service.ts:171-178 |
| J1 | account or chain changes before the provider call | | J0 or J0m, not dispatched | wallet-session.ts:127-129, service.ts:191-199 |
| J1 | wallet returns a hash | | J3 | service.ts:179-188 |
| J1 | wallet rejects (4001 or 5000) | no hash was returned | J0 or J0m | service.ts:190-199 |
| J1 | wallet error whose message names a pre-broadcast cause | nothing at N | J0 or J0m, `NotSentError` | service.ts:203-229 |
| J1 | wallet error with only a -32603 or -32000 code | nothing at N on three reads over four seconds | J0m, `NotSentError`; the caller keeps its checkpoint | service.ts:210-225 |
| J1 | same | something at N on any read, or a read fails | J2, "The wallet response is uncertain" | service.ts:211, 217, 227, 230 |
| J1 | wallet returns no valid hash, or any other error | | J2 | wallet-session.ts:135, service.ts:230 |
| J1 | reload or tab close | | J2, the browser releases Q | |
| J1 | wallet never answers | | J1 until that tab reloads or closes | service.ts:266-271 |
| J2 | settlePending | Q held anywhere | J2, waiting | service.ts:271 |
| J2 | settlePending | waiting, or unsent without Continue | J2 | service.ts:277 |
| J2 | settlePending with Continue | unsent | J0m, dropped | service.ts:277-283 |
| J2 | settlePending | expired | J0m, dropped | service.ts:277-283 |
| J2 | settlePending | spent | J0 or J0m (M untouched), spent | service.ts:281-283 |
| J2 | a hash is entered (resume) | the transaction is from this account, at N, mined not before `startedBlock` | J3 | service.ts:425-449 |
| J3 | confirm | receipt two deep at N, or for the returned hash | J0; M removed when it is at that nonce | service.ts:401-416 |
| J3 | confirm | the returned hash sits at another nonce | J3 with the record moved to that nonce | service.ts:392-396 |
| J3 | confirm times out | | J3 | service.ts:421 |
| J3 | replaced while the page watches | viem returns the replacement's receipt | J0, outcome confirmed (same call) or replaced | service.ts:401-419 |
| J3 | replaced or dropped while nothing watches | | J4 | service.ts:256-259 |
| J4 | settlePending | spent | J0 or J0m (M untouched) | service.ts:274-283 |
| J4 | settlePending | expired | J0m | service.ts:277-283 |
| J4 | settlePending | unsent, with or without Continue | J4 | service.ts:277 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload or close before the provider call | The record may exist with no request. The page shows "Your wallet didn't send your last transaction" with Continue, or clears it after 25 blocks | safe |
| Reload or close with the wallet prompt open | J2. If the person then approves the old prompt, the nonce shows it and the record waits, then clears as spent. If they choose Continue first, M makes the next send stop once the old one is visible, and a send before that reuses N | safe for a wallet that honors the nonce; see the accepted limit under A3 |
| Reload or close while confirming | J3 with an outcome checkpoint. The saved-hash check settles it by receipt | safe |
| Two tabs | One record, written under X. The second tab's send is refused by the record or by Q. Neither tab settles while Q is held | safe. Tests: "allows only one provider request across two service instances sharing one journal" (`web/test/independent-pending-journal.test.ts:63`), "waits while another tab has a wallet request open" (`web/test/pending-send.test.ts:219`) |
| Account or chain switch | The session check before the provider call fails and the record is removed. After the call, the record stays under the old account's key | safe. Test: "does not invoke the provider if %s changes while journal acquisition waits" (`web/test/wallet-session.test.ts:31`) |
| Wallet returns no hash | J2. Settled from the nonces without a pasted hash | safe |
| Bare -32603 or -32000 | Three quiet nonce reads over four seconds, then J0m | safe for buys by J-I5 and J-I7. For Create see finding 1 |
| RPC lags on the pending nonce | The record can clear as unsent while the wallet's send is in flight. M and the shared nonce cover it | safe for a wallet that honors the nonce |
| RPC fails | Reads throw. A nonce read that fails keeps the record (service.ts:227). The page reports "Can't reach the network" after two failures | safe |
| Dropped transaction | J4, cleared after 25 blocks with nothing at N, with M | safe |
| Replaced transaction | J4, cleared once N is spent two deep | safe for the journal. For the page see finding 2 |
| Reorg | A receipt needs its block hash to match and two confirmations (service.ts:312-325). A reorg deeper than that after a clear returns the transaction to the pool at the same nonce | safe by reading |
| `localStorage` or Web Locks unavailable | Every journal call throws "Safe transaction recovery requires browser storage and Web Locks" (pending-journal.ts:61-64). Nothing can be sent | safe. Test: "fails closed when Web Locks or durable storage are unavailable" (`web/test/pending-journal.test.ts:31`) |
| `localStorage` full | The record write throws or reads back differently (pending-journal.ts:67). Not dispatched | safe. Test: "fails closed on storage failure before the provider request and permits a fresh reviewed retry" (`web/test/independent-pending-journal.test.ts:89`) |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Two records for one account | Unreachable: one key, written only under X after reading it empty (service.ts:173) |
| A wallet request open with no record | Unreachable: J-I2. Test: "sends nothing when durable coordinator storage fails before submission" (`web/test/independent-three-action-create-flow.test.ts:379`) |
| A record removed while its request is open | Unreachable: J-I6 |
| A record cleared while the chain still knows its hash | Unreachable: `settlePending` returns waiting first (service.ts:273). Test: "leaves a hash the chain still knows to its receipt check" (`web/test/pending-send.test.ts:243`) |
| A record cleared by Continue although it holds a hash | Unreachable: service.ts:277. Test: "clears a dropped send only after 25 blocks with nothing at its nonce, never on Continue" (`web/test/pending-send.test.ts:271`) |
| A second wallet request at a later nonce for an intent whose first request may still land | Unreachable for a buy while M stands (J-I5). Reachable for Create before 3bc0972: finding 1 |
| A record that waits forever | Reachable by design when an earlier nonce of the account was dropped from the pool (L below N for good). Pinned by "keeps the record and waits when %s, even on Continue and after 25 blocks" (`web/test/pending-send.test.ts:105`). See ambiguities |
| A marker that outlives what it protects | Reachable, low: a record at M's nonce that later clears as spent through `settlePending` leaves M, so the next send stops once with the earlier-request line. By reading. See ambiguities |

### 2. Transaction outcome ownership

Code: `web/lib/chain/transaction-outcomes.ts`. One owner per service (`transactionOutcomes`, lines 454-459), so one per
page load.

#### States

Rows live in memory, per account (`records`, line 42). Each row has an operation id and one kind:

| Row kind | Meaning | Ref |
|---|---|---|
| submitting | This tab's wallet request is open; id `request-N` | 339-340 |
| rejected | The wallet refused; history only | 356 |
| error, `submitted` null | The wallet's answer was uncertain, or storage failed (id `storage-error`) | 189, 357 |
| checking | This tab is watching the hash | 319, 345 |
| pending | The first watch ended without a receipt | 325 |
| error, with `submitted` | The watch itself failed | 328 |
| recovery | A saved checkpoint not yet inspected | 170-171 |
| unverified | An inspected hash without a canonical receipt yet | 218, 229, 246 |
| terminal | A canonical receipt: confirmed, reverted or replaced | 192-199 |
| overflow | More than 100 saved checkpoints | 180 |

Around the rows: `localStorage` checkpoints `labx:outcome:v1:{chain}:{contract}:{codehash}:{account}:{id}` holding a
hash (lines 40, 57, 105-113); `acknowledged` ids (44); `redirects` from superseded ids (46); `verified` hashes with
their nonce and observed transaction (48); journal `lineages` (49); in-flight maps `checking`, `inspections` and
`recoveries` (45, 47); the per-account `submitting` set (43).

#### Invariants

- O-I1. One row per operation id. A terminal row is never replaced (line 99) and an acknowledged id never returns
  (line 98).
- O-I2. A row is terminal only from a receipt the service validated: block hash, two confirmations, sender, nonce
  (service.ts:312-325).
- O-I3. One wallet request per account at a time in a tab (line 337), one watch per hash (303-304), one inspection per
  hash (201-202), one recovery job per account (255-256).
- O-I4. A saved hash is only a hint. After a reload every row starts as recovery and is rebuilt from the chain
  (173-191, 254-270).
- O-I5. A terminal outcome belongs to a submission only when both hashes were verified at the same nonce and resolve
  to the same operation (391-401). Only then does a control report its own action as done.
- O-I6. A checkpoint is removed only by acknowledging its exact terminal row (402-425) or, with its unfinished rows,
  under the journal lock when the journal record with that hash is cleared from the nonces (432-448).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| none | submit | no submit in flight for the account | submitting | 337-340 |
| submitting | wallet returns a hash | | checking, with a checkpoint once the transaction is seen on chain | 343-347, 316-319 |
| submitting | wallet rejects | | rejected | 355-356 |
| submitting | nothing was sent | `NotSentError` | row removed; `earlierSends` counted for an `EarlierSendError` | 349-354 |
| submitting | any other failure | | error without a hash | 357 |
| checking | receipt | | terminal | 324-326 |
| checking | watch times out | | pending | 325 |
| checking | watch fails | | error with the submission | 328 |
| pending, error, unverified | resume or automatic check | journal record present | checking, then as above | 360-390 |
| pending, unverified, recovery | resume or recovery | no journal record | terminal, or unverified | 200-253, 371 |
| none | reload, storage event or focus | a saved checkpoint | recovery, then inspected | 173-191, 271-290 |
| any row with hash H, not terminal | `settlePending` clears the record holding H | the row's verified nonce is the record's | removed with its checkpoints | 432-448 |
| terminal | acknowledge (Buy again, Dismiss) | wallet session unchanged, no journal record at or below its nonce | removed, id acknowledged | 402-425, service.ts:469-477 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload | Rows are rebuilt from checkpoints as recovery and inspected two at a time | safe |
| Tab close during a watch | The checkpoint and the journal record stay. The next page settles them | safe |
| Two tabs | Each tab has its own rows over shared checkpoints. A storage event or window focus rescans. Either tab may confirm; the other finds the journal empty and retains the same receipt | safe. Tests: "synchronizes another tab's canonical replacement and ignores the old watcher's late result" (`web/test/transaction-outcomes.test.ts:385`), "retains local terminal receipts after remote acknowledgment until an explicit local acknowledgment" (`:406`). For the control that sent it see finding 2b |
| Account switch | Rows are per account. A resume started under one session is refused after the switch (`assertScope`, 365-369) | safe. Test: "does not resume after the pending read changes wallet session" (`:328`) |
| Wallet rejection | rejected row, no hash invented | safe. Test: "preserves a direct numeric %s rejection without inventing a submitted hash" (`:204`) |
| No hash, uncertain error | error row without a hash; hidden behind the journal panel until the journal is clear | safe |
| RPC fails during a watch | error row with the submission. The saved-hash check hands it to the person ("Your transaction needs a check") | safe, one click |
| Replaced transaction | While watched: terminal confirmed or replaced, the old hash redirected to it. Unwatched: the journal settles from the nonces and the rows of the old hash are removed | safe |
| Reorg | A receipt whose block changed fails validation and the row stays unverified until a later check | safe by reading |
| Storage unavailable, malformed or above 10,000 keys | A `storage-error` row blocks new actions until storage reads clean again (173-191) | safe. Tests: "rejects malformed or oversized checkpoint storage without treating any record as success" (`:171`), "removes its storage-error row once storage reads clean again" (`:470`) |
| Storage full | The checkpoint write throws before the journal is touched | safe. Test: "leaves the service journal untouched when checkpoint storage fails" (`:146`) |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Two rows for one hash | Unreachable: `operationId` reuses the owning row (87-93) and `retain` merges rows of the same nonce (124-146). Test: "links distinct same-nonce hashes, keeps one canonical hint and automatically recovers cancellation after reload" (`web/test/transaction-outcomes.test.ts:221`) |
| A terminal row replaced by a late pending or error result | Unreachable: line 99 and `finish` (308-314). Test: "does not resurrect an acknowledged operation when an old attempt returns %s" (`:250`) |
| A purchase shown as done from a hash alone | Unreachable: O-I2, O-I4. Test: "hydrates only unverified hashes, survives owner recreation and requires service revalidation" (`:154`) |
| A control claiming another transaction's receipt as its own | Unreachable: O-I5. Test: "does not authorize a same-intent historical receipt from another nonce or a forged pointer as its own submission" (`:573`) |
| A row left for a hash whose record another tab cleared from the nonces | Reachable by reading: the other tab removes the shared checkpoints, and this tab's unverified row stays and keeps new actions paused until a reload. The existing test "keeps deleted unknown saved activity blocking and never persists unowned unknown input" (`:430`) pins that a removed checkpoint does not release a row. See ambiguities |

### 3. TransactionFlow

Code: `web/components/workflow/TransactionFlow.tsx`. One instance per action control.

#### States

`TransactionState` (lines 15-30), tagged with a scope number (150-151). The scope is a generation that changes when
the service, the wallet object, the wallet revision, the action or the resume hash changes (145-149); state from
another scope reads as idle.

| State | Encoding | Shown |
|---|---|---|
| idle | `{ kind: "idle" }` | the action button |
| preparing | operation claimed (`operation` ref, 164, 195-200) | "Preparing…" |
| review | prepared action | review with Confirm and Back |
| submitting | prepared action, wallet request open | "Waiting for wallet…" |
| confirming | own submission (`ownSubmission` ref, 169) | "Confirming…" |
| pending | own submission after the first watch ended | "Still confirming…" with Check again; "Your transaction needs a check" when the saved-hash check asks for attention |
| recovery | the journal record read at mount or after a failure: `{ hash, nonce, saved, id }` | the chain check for a hashless record, or "Finishing your last step…" for a saved hash |
| rejected, error | message; `plain` for a sentence the person can act on | "Cancelled in your wallet" or the message, with Try again |
| receipt | a terminal outcome that is not this control's own action | "Earlier transaction found" |
| reverted, replaced, confirmed | this control's own terminal outcome | result |

Refs and latches around it: `attemptedScope` (167) for the one automatic prepare; `clearJournalScope` (168), set when
the journal was read empty for the scope; `autoSubmit` and `autoSubmitSpent` (171-172) for the one automatic send;
`mounted` and `mountRevision` (166, 177-183).

#### Invariants

- T-I1. One operation per scope at a time (`begin`, 195-200). A second click during an operation does nothing.
- T-I2. An async result is applied only if the component is mounted and the scope is the one that started it
  (`isCurrent`, 185-189).
- T-I3. The wallet opens only from a click on this control (prepare with `fromClick`, or Confirm), or once from
  `submitOnMount` (T-I4). A click-to-wallet send also refuses inside the service if the control is no longer current
  (line 314).
- T-I4. The automatic send is read once at mount and spent on the first decision: it fires only from idle, with the
  journal read empty for the scope, the control enabled and no unfinished outcome; a record, an error, a disabled
  control or an unfinished outcome ends it without sending (331-343).
- T-I5. No prepare or send starts while the account has an unfinished outcome (`activeOutcome`, 139, 286, 380).
- T-I6. `onConfirmed` runs only for this control's own submission from this visit, matched by nonce and operation and
  by the same call (354-359).
- T-I7. A control in pending leaves it once its record is gone: by its own receipt, by the receipt another tab
  confirmed, or by returning to its button when the wallet replaced or dropped the transaction. Before 8bf7034 only
  the first held. Finding 2.

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| any | scope change (wallet revision, action, service) | | idle; journal read again | 206-226 |
| idle | journal read at mount | record present, no operation running | recovery | 212-219 |
| idle | click | enabled, no unfinished outcome, wallet on the right chain | preparing | 285-293 |
| idle | mount with `prepareOnMount` | journal empty, not yet attempted in this scope | preparing | 323-329 |
| idle | mount with `submitOnMount` | T-I4 | preparing, then submitting | 331-343 |
| preparing | journal has a record | | recovery | 295-300 |
| preparing | prepared | click on a direct-send control | submitting | 307-314 |
| preparing | prepared | otherwise | review | 315 |
| preparing | prepare fails | | error, or recovery if a record now exists; `onUnavailable` first for an automatic send | 301-305, 276-283 |
| review | Confirm | same wallet session as the review | submitting | 379-395 |
| review | Back | | idle | 497 |
| review | wallet changes | | review marked stale, Confirm disabled | 481, 487, 496 |
| submitting | wallet returns a hash | | confirming | 310-313, 391-394 |
| submitting | wallet rejects | | rejected | 363-364 |
| submitting | nothing sent | | error, plain | 365-366 |
| submitting | uncertain answer | record present | recovery | 276-283 |
| confirming | receipt, own action | | confirmed, reverted or replaced; `onConfirmed` for confirmed | 352-360 |
| confirming | first watch ends without a receipt | | pending | 361-362 |
| pending | a terminal outcome of this submission appears | enabled | runs Check again: confirmed, `onConfirmed` with "check" | 258-263 |
| pending | saved-hash check reports settled | enabled | runs Check again | 265-274 |
| pending | saved-hash check reports replaced | enabled | idle. The page's recovery panel shows "Your wallet replaced or dropped your last transaction. Check the page before trying again." and re-reads the chain | 265-274, ResumeTransaction.tsx:91-99, 200 |
| pending | saved-hash check asks for attention | | pending with "Your transaction needs a check" | 505-512 |
| pending | Check again | | the outcome of `owner.resume` | 403-411, 370-377 |
| recovery, hashless | chain check: spent or settled | journal read empty | idle | 228-254 |
| recovery, hashless | chain check: unsent, then Continue | | idle after the clear | 438-443 |
| recovery, saved hash | saved-hash check settled or replaced, or a terminal outcome at its nonce | journal read empty | idle | 228-254 |
| recovery | the journal now holds another record | | recovery for that record | 234-243 |
| rejected, error, reverted, replaced | Try again or Review again | | idle | 535, 545 |
| receipt | Review this action | no unfinished outcome | idle | 524 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload while preparing or in review | Nothing was stored. idle | safe |
| Reload with the wallet prompt open | recovery, hashless: the chain check, never an automatic send | safe |
| Reload while confirming or pending | recovery with the saved hash: "Finishing your last step…", then idle. The receipt shows through the outcome rows | safe |
| Two tabs | The second tab's control starts in recovery for the first tab's record and cannot send | safe. For pending see finding 2b |
| Account or chain switch | New scope: idle. Results of the old scope are dropped. The wallet gate above most controls also unmounts them while disconnected | safe. Tests: "drops a delayed prepare from an old wallet session and allows the fresh wallet action" (`web/test/buyer-ui-repairs.browser.test.ts:234`) |
| Wallet rejection | rejected, "Nothing was sent", Try again | safe |
| No hash or an uncertain error | recovery, hashless, settled from the nonces | safe. Test: "after a wallet error without a code, shows one plain panel and no reconcile wording, then buys after Continue" (`web/test/easy-buy.browser.test.ts:370`) |
| Bare -32603 or -32000 | "Waiting for wallet…" for about four seconds, then a plain sentence and Try again | safe |
| RPC lags or fails | prepare fails into error with Try again; a failed watch becomes "Your transaction needs a check" | safe, one click |
| Dropped or replaced transaction after the first watch | Before 8bf7034: "Still confirming" for good. After: the button returns, and the page says what happened and reads the chain | fixed, finding 2a |
| Reorg | Not seen by this component; the service's receipt rules apply | safe by reading |
| Storage or Web Locks unavailable | The journal read at mount fails: error with the reason. Nothing can be sent | safe |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Two wallet requests from one click | Unreachable: T-I1, the owner's per-account guard and the service's `used` flag |
| An automatic send in a scope other than the one it mounted in | Unreachable in the current tree. The latch itself would still fire if the scope changed between mount and the first journal read, but every control with `submitOnMount` sits under a parent that unmounts it when the wallet revision or the account read changes (`RaffleWorkspace.tsx:734, 802`), and its action is constant. By reading |
| An automatic send after a record was found | Unreachable: line 334. Test: "never opens the wallet by itself once a saved transaction that held the confirmation is checked" (`web/test/seller-draw-runner.browser.test.ts:384`) |
| `onConfirmed` for a transaction this control did not send | Unreachable: T-I6. A foreign receipt shows as "Earlier transaction found" |
| pending with no journal record and no receipt on the way | Reachable before 8bf7034: finding 2 |
| recovery that never ends although the record is gone | Unreachable: every final status of both checks triggers a journal read (228-254) |

### 4. Saved-hash check, pending-send check and the page recovery panel

Code: `web/components/workflow/useTransactionOutcomes.ts`, `web/components/workflow/ResumeTransaction.tsx`.

#### States

Two module registries, keyed per outcome owner (`WeakMap`, lines 132, 241) and then by wallet session:

| Machine | Key | States | Ref |
|---|---|---|---|
| Saved-hash check | `{account}:{revision}:{hash}` | checking; attention (two failed reads, a receipt that is not a plain success of the journal's intent, this tab's failed watch, or three minutes pending); settled (the journal no longer holds the hash); replaced (this check cleared the record from the nonces). replaced is final | 60-129, 142-172 |
| Pending-send check | `{account}:{revision}:{id}:{nonce}` | checking; waiting; unsent; unknown (two failed reads); spent and settled are final | 186-237, 256-306 |

Each entry counts its users and runs one check while it has any (162-168, 278-283). The check reads only while the
page is visible (77, 220) and never prepares, signs or sends. The pending-send entry also counts the visible panels
that show the record, so the page shows one (286-305).

`ResumeTransaction` holds the journal record it last read (`pending`, line 34), `clearJournal` (35), a `generation`
that changes with the wallet snapshot (36, 58-63), the manual hash field, and two lines it keeps until the next send or
another wallet: the earlier-send line (53) and the replaced line (56).

#### Invariants

- C-I1. One check per record and wallet session, however many controls show it.
- C-I2. The journal is cleared only through `owner.resume` after a confirmed read of the exact hash and the journal's
  own intent, or through `owner.settlePending` (useTransactionOutcomes.ts:97-104, 93-95).
- C-I3. Continue is the only path that clears a record with nothing at its nonce before 25 blocks, and only a click
  reaches it (232-235).
- C-I4. The page re-reads the chain when something landed that no receipt on this page reported: a hashless record
  cleared as spent, a saved hash cleared from the nonces, or a send stopped by the marker
  (ResumeTransaction.tsx:92-99), and once per confirmed outcome (101-110).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| saved hash: checking | tick | this tab is watching the hash | checking | 83 |
| checking | tick | journal holds another hash or none | settled | 86 |
| checking | inspection: unmined or too shallow | under three minutes | checking | 89-91 |
| checking | same | three minutes or more | attention | 91 |
| checking | inspection: hash unknown | nonces clear the record (spent or dropped) | replaced | 92-95 |
| checking | inspection: hash unknown | nonces do not clear it, twice | attention | 96 |
| checking | inspection: confirmed, exact hash and intent | | journal cleared through `owner.resume`, then settled on the next tick | 97-104, 86 |
| checking | inspection: reverted, other intent or other hash | | attention | 105 |
| checking, attention | page hidden | | no reads until it is visible again | 77, 116-122 |
| attention | later ticks | | attention; the check keeps reading and still ends in settled or replaced | 74-114 |
| hashless: checking | `settlePending`: waiting or unsent | | waiting or unsent | 197-199 |
| waiting, unsent | `settlePending`: spent | | spent (final), page re-reads | 200-202 |
| unsent | Continue | still unsent | settled (final), record dropped with a marker | 232-235 |
| any | `settlePending`: changed | | settled (final) | 200-202 |
| any | two failed reads in a row | | unknown, manual form behind Details | 209-210 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload | Registries are empty. Each check starts from the journal | safe |
| Two tabs | Each tab runs its own check. `settlePending` re-reads the record under the journal lock, so only one clears it. Test: "lets only one of two tabs clear the record, each inside the journal lock, never overlapping" (`web/test/pending-send.test.ts:183`) | safe |
| Account or chain switch | The key includes the wallet revision, so the old entry loses its users and stops | safe |
| Hidden tab | No reads. On return the check runs at once | safe. Test: "reads nothing while the page is hidden and checks at once when it becomes visible" (`web/test/automatic-outcome-check.test.ts:182`) |
| RPC fails | attention or unknown after two failures; the manual form appears | safe, see suspicion 1 |
| Replaced or dropped transaction | replaced; the page re-reads | fixed, finding 2a |
| Storage or Web Locks unavailable | `service.pending` throws: the saved-hash check asks for attention, the panel shows the error | safe |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| A check that opens the wallet | Unreachable: the check has no path to prepare, submit, sign or connect. Test harness `expectReadsOnly` (`web/test/automatic-outcome-check.test.ts:59`) |
| The journal cleared on a receipt for another intent | Unreachable: lines 98-101. Test: "leaves a confirmed receipt with a different intent from the journal to the manual form" (`:118`) |
| Two Continue panels for one record | Unreachable: panel counting. Test: "shows exactly one Continue panel for an unsent record while Other actions opens and closes" (`web/test/independent-transaction-outcomes.browser.test.ts:892`) |
| A record cleared from the nonces with the page left on the old state | Reachable before 8bf7034 for a saved hash: finding 2a |

### 5. Create flow records

Code: `web/lib/chain/create-flow.ts`, `web/components/workflow/SellerDraftForm.tsx:146-163, 409-551`,
`web/components/workflow/CompleteCreate.tsx`, `web/lib/chain/api.ts:53-69, 118-128`.

#### States

| Part | Encoding | Ref |
|---|---|---|
| Create record | `localStorage` `labx:create:v1:{chain}:{contract}:{codehash}:{seller}`: `preparing { data, requestIdentity }` or `draft { data, creationHash, id, pending, lastFailure? }`, where `pending` is `{ step, hash, checkpoint? }` and the checkpoint is the journal record's id, intent, nonce and starting block | create-flow.ts:8-17, 27-58 |
| Raffle page record | the same shape under `...:raffle:{id}`, used when Studio's record is not for this exact draft | create-flow.ts:116-128 |
| Generation | `...:generation`, a UUID advanced when a record is created or retired, so a click made against an older record is refused | create-flow.ts:59-70 |
| Archives | `...:retired:{uuid}` and `...:completed:{id}` | create-flow.ts:129-136, 149-159 |
| Create lock | Web Lock named by the record key | SellerDraftForm.tsx:428, CompleteCreate.tsx:31 |
| In memory | `createLifetime` (mounted, generation, busy, operation) and the `creation` view state | SellerDraftForm.tsx:146-158 |

| State | Encoding |
|---|---|
| R0 none | no record |
| R1 preparing, unsigned | `preparing`, `requestIdentity` null |
| R2 preparing, requested | `preparing` with a request identity |
| R3 draft, nothing sent | `draft`, `id` null, `creationHash` null, `pending` null |
| R4 step in the wallet | `pending { step, hash: null, checkpoint }` |
| R5 step sent | `pending { step, hash, checkpoint }` |
| R6 draft on chain | `id` and `creationHash` set, `pending` null; the chain decides whether approval and escrow are still needed |
| R7 done | record archived as completed |

#### Invariants

- R-I1. One Create runs per seller at a time, across tabs (the Create lock), and only against the record the seller
  saw when they clicked (`assertCreateGeneration`, and the serialized comparison at SellerDraftForm.tsx:431-435).
- R-I2. The record names a step before the wallet is asked for it: the checkpoint is saved from the service's
  `beforeRequest`, under the journal lock (create-flow.ts:263-266).
- R-I3. `createRaffle` is sent only when the record has no `id`, no `creationHash` and no pending draft step that the
  chain can still settle (create-flow.ts:281-304).
- R-I4. A step whose journal record is gone is settled from the chain before anything is sent: nothing at its nonce
  drops the step, something pending waits, and a mined nonce looks for the draft's `RaffleCreated` event at that nonce
  from the step's starting block to the head (create-flow.ts:281-293, service.ts:286-310).
- R-I5. The create record and the journal record agree: a checkpoint with another intent, or a journal record with
  another id, stops Create (create-flow.ts:178-180).
- R-I6. A record is retired only when nothing of it can still land: no id, hash or pending step, and no journal record
  (create-flow.ts:72-86); or its draft changed on chain and no wallet transaction is unresolved (92-110).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| R0 | Create | no journal record | R1, then the signature request | SellerDraftForm.tsx:439-448 |
| R1 | signature requested | | R2 | SellerDraftForm.tsx:450-453, api.ts:59-60 |
| R1, R2 | wallet refuses, request never left, or the server answers 404 | | R0 | SellerDraftForm.tsx:456-461 |
| R2 | server saved the setup | | R3 | SellerDraftForm.tsx:455 |
| R2 | reload, then Create | recovery signature; server has the setup | R3 | SellerDraftForm.tsx:462-478 |
| R2 | same | server never saved it (404) | R0 with the form restored | SellerDraftForm.tsx:468-477 |
| R1 | reload, then Create | | stays R1: "Your raffle setup wasn't saved", Start over under Advanced | SellerDraftForm.tsx:463 |
| R3, R6 | Create | step needed | R4 for that step | create-flow.ts:258-266 |
| R4 | wallet returns a hash | | R5 | create-flow.ts:272 |
| R4 | wallet refuses, or its message says nothing was sent | | back to R3 or R6 | create-flow.ts:267-270, service.ts:196, 223 |
| R4 | bare -32603 or -32000, nonces quiet | | stays R4 with no journal record; the next Create settles it from the chain | service.ts:221-224, create-flow.ts:281-293 |
| R4 | uncertain answer | | stays R4 with a hashless journal record | create-flow.ts:187-188 |
| R4, R5 | Create, journal record gone | nothing at the nonce | R3 or R6, and the step is sent again at that nonce | create-flow.ts:286-291 |
| R4, R5 | same | nonce spent, draft step, event found | R5 with the found hash | create-flow.ts:287-291 |
| R4, R5 | same | nonce spent, no event (or another step) | R3 or R6; the chain decides what is still needed | create-flow.ts:291 |
| R4, R5 | same | something pending, or a gap | unchanged, "Wait for canonical confirmation" | create-flow.ts:285 |
| R4 | Create, journal record still hashless | | unchanged, "The wallet response is uncertain"; the page's chain check settles the record | create-flow.ts:187-188 |
| R5 | receipt, exact call, success | | R6, or the next step | create-flow.ts:198-212, 303, 311, 317, 325, 333 |
| R5 | receipt reverted, or another call at that nonce | | step cleared with `lastFailure`; Create retries the stage | create-flow.ts:206-210 |
| R5 | no receipt in two minutes | | unchanged, Create resumes | create-flow.ts:201 |
| R6 | escrow confirmed and custody read back | | R7 | SellerDraftForm.tsx:496-505, CompleteCreate.tsx:45-49 |
| R3 | Start over | no journal record | R0, archived | create-flow.ts:72-86 |
| R6 | Create, draft edited, cancelled, listed or expired on its own page | no pending step, no journal record | R0, archived | create-flow.ts:92-110 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload or close at any step | The record names the step. Create resumes from it and from the chain | safe |
| Two tabs | The lock runs one Create. The other tab's click fails the generation check | safe. Tests: "detects a null-to-null cross-tab ABA through the durable creation generation" (`web/test/independent-three-action-create-flow.test.ts:343`), `web/test/independent-complete-create-race.browser.test.ts` |
| Account or chain switch mid-flow | `assertIntent` fails at the next step; nothing more is sent. The record stays under the seller's key | safe |
| Wallet rejection | Step cleared, "Press Create to continue when you're ready" | safe |
| No hash | R4 with a hashless journal record. The dashboard's chain check clears it, then Create finds the draft | safe. Test: "finds the draft a wallet sent despite its error, after the mined nonce clears the record, and makes no second draft" (`web/test/three-action-flow.integration.test.ts:218`) |
| Bare -32603 or -32000 | Before 3bc0972 the step's checkpoint was dropped: finding 1 | fixed |
| RPC lags | A draft the log read cannot find yet is not searched again once the step was dropped. See suspicion 3 | open, by reading |
| RPC fails during the search | The step stays pending. Test: "keeps the lost draft step when a read fails part way through the search, then finds the draft" (`web/test/three-action-flow.integration.test.ts:250`) | safe |
| Dropped or replaced step | Settled from the nonce. Tests: "continues from the faster copy of a draft whose saved hash was replaced" (`:328`), "sends the draft again once when its saved hash never landed (%s)" (`:336`) | safe |
| Reorg | The created draft is re-read with its block hashes before the next step (service.ts:105-127) | safe by reading |
| Storage unavailable or full | The record write throws before the wallet request. Test: "sends nothing when durable coordinator storage fails before submission" (`web/test/independent-three-action-create-flow.test.ts:379`) | safe |
| Web Locks unavailable | "This browser isn't supported" before anything is read or sent | safe |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Two `createRaffle` requests for one Create | Reachable before 3bc0972 after a code-only wallet failure: finding 1. Otherwise unreachable by R-I3 and R-I4 |
| A record with a pending step and no way to settle it | Unreachable for records with a checkpoint. A record from before checkpoints existed needs the pasted hash (create-flow.ts:186, 207) |
| The record points at one draft while the journal holds another transaction | Unreachable: R-I5. Test: "blocks an unrelated global journal before preparing or submitting" (`web/test/independent-three-action-create-flow.test.ts:280`) |
| A record retired while its transaction can still land | Unreachable: R-I6. Tests: "does not reset an on-chain or globally journaled creation stage" (`:326`), "retains the record when a global journal exists or the scope retires during its read" (`web/test/create-recovery.builder.test.ts:43`) |
| Studio's record used for another raffle's page | Unreachable unless the two drafts are byte-identical (create-flow.ts:121). The server gives the same seller, NFT and texts the same commitment, so a second raffle of the same NFT with the same title, deadline and packs would match. By reading; see the server part's ambiguity 8 |

### 6. Buyer checkout

Code: `web/components/workflow/RaffleWorkspace.tsx:527-757`.

#### States

React state only; nothing is stored.

| Part | Encoding | Ref |
|---|---|---|
| Order | `packId`, `quantity`, `payment` | 541-543 |
| Consent | `{ account, checked }`, tied to the wallet that ticked it | 544, 605-616 |
| Quote | `quote`, `quoteState`, `quoteRequest` counter | 552-555, 585-602 |
| Handoff | `buyAfterApproval { order, revision, block }`: the order whose approval this page just confirmed | 548 |
| Own approvals | the approvals this page sent in this visit | 550 |
| Derived | `needsApproval`, `approvalFirst`, `buyReady`, `autoBuy` | 620-623, 648-650 |

| State | Encoding |
|---|---|
| B0 choosing | no handoff; shows the approve control (allowance short) or the buy control |
| B1 approving | the approve control is in a wallet or confirming state |
| B2 handoff | `buyAfterApproval` set, reads not yet at the approval's block: "Approved. Opening your purchase…" |
| B3 buying | the buy control mounted, with `submitOnMount` when the handoff matched |
| B4 bought | a confirmed purchase outcome for this raffle: receipt with Buy again or Dismiss |

#### Invariants

- B-I1. At most two wallet prompts per purchase: the exact approval, then the purchase. With enough allowance, one.
- B-I2. The purchase opens by itself at most once per approval, and only when the first reads at or after the
  approval's block show the same order, the same wallet session, USDC payment and enough allowance (648-650). The
  handoff is cleared in the same commit that decides (651-653), and the control reads `submitOnMount` once
  (TransactionFlow T-I4).
- B-I3. A failed read, a quote error, another wallet or another order ends the handoff without sending (652).
- B-I4. The handoff is never stored, so a reload never opens a wallet.
- B-I5. The purchase call carries the pinned terms hash and is built only with the tick of the connected wallet
  (612, 631-637).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| B0 | Buy click, allowance short | agreed, writes enabled | B1 | 739 |
| B0 | Buy click, allowance enough | agreed | B3, one prompt | 740 |
| B1 | approval confirmed from this control (first watch or a later check) | | B2; page re-reads from the approval's block | 655-659 |
| B1 | pack, quantity or payment changes | | B0 for the new order; the approval's control unmounts and its confirmation re-reads the account once | 663-671 |
| B1 | wallet rejects | | B0 with "Cancelled in your wallet" | |
| B2 | reads at or after the approval's block, same order and session, allowance enough | | B3 with the automatic send | 648-650 |
| B2 | same reads, anything differs | | B0, a click is needed | 650-653 |
| B2 | read fails, quote fails, wallet changes | | B0 | 652 |
| B3 | purchase confirmed | | B4 | 563-565 |
| B3 | wallet rejects | | B0, Try again | |
| B4 | Buy again or Dismiss | reads at or after the purchase's block | B0 | 673-681 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload at any step | B0 from the chain. An approval already mined shows the buy control, one click | safe |
| Two tabs | The journal lets one request through. A purchase confirmed in the other tab shows here after its outcome is recovered or the page is re-read | safe; for a slow purchase see finding 2b |
| Account or chain switch | The handoff ends (652), the tick is cleared for another account (605-611), the quote restarts | safe. Test: "clears only stale recovery feedback after an account switch and leaves the original wallet journal intact" (`web/test/buyer-ui-repairs.browser.test.ts:199`) |
| No hash on the approval | No handoff. After the chain check clears the record the buy control shows; one click | safe, extra click |
| Bare -32603 or -32000 on the purchase | Plain sentence and Try again. If the purchase had landed, the next click stops at the marker and the page shows the membership | safe; see the accepted limit under A4 |
| RPC lags after the approval | Reads repeat until they reach the approval's block (frontend consistency bugs 1 and 2) | fixed earlier |
| Replaced or dropped purchase | See finding 2a | fixed |
| Reorg | Not seen by this component; the service's receipt rules apply | safe by reading |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Three wallet prompts for one purchase | Unreachable without a rejection or an order change. Tests: "buys every membership the raffle offers with one click: two wallet transactions without an allowance and no signatures" (`web/test/easy-buy.browser.test.ts:98`), frontend consistency bug 2 |
| Two automatic purchases for one approval | Unreachable: B-I2 |
| An automatic purchase for another order or wallet than the approval's | Unreachable: 650, 652 |
| An automatic purchase after a reload | Unreachable: B-I4 |
| A purchase prompt with no tick | Unreachable: `purchaseAction` is null without it (631) and the button is disabled (738) |

### 7. Owner Safe approve and revoke flow

Code: `web/components/review/OwnerReview.tsx:419-988`, `web/lib/chain/service.ts:70-104`,
`web/lib/chain/owner-execution.ts`, `web/lib/chain/owner-execution-discovery.ts`.

#### States

| Part | Encoding | Ref |
|---|---|---|
| Flow | `FlowState`: idle, preparing, requested or exported (same screen, by channel), recovery, confirming, pending, executed, error | OwnerReview.tsx:42-50 |
| Discovery | `DiscoveryState`: idle, range, error; a cursor ref with a block checkpoint | OwnerReview.tsx:52-55, 500 |
| Selection and attestations | `selection`, `attestations` bound to the review digest | OwnerReview.tsx:486-488, 509 |
| Operations | `lifetime` ref: mounted, generation, operation counter, the one exclusive operation, the digest | OwnerReview.tsx:499, 514-541 |
| Saved intent | `localStorage` `labx:owner-review:v1:{chain}:{contract}:{codehash}:{owner}:{id}`: the exact call, its review block, generations and revision | OwnerReview.tsx:419-421, owner-execution.ts:78-113 |
| Channel | `...:handoff`: `{ intent, channel }`, channel `wallet-request` or `file` | OwnerReview.tsx:786-799 |
| Exposure | `...:manual-exposure`: the intent whose call fields were shown, copied or downloaded | OwnerReview.tsx:803-817 |
| History | `...:history:{digest}:{block hash}`: an intent replaced by a fresh download | OwnerReview.tsx:910-912 |
| Lock | Web Lock named by the intent key | OwnerReview.tsx:711, 748, 811, 902 |

The component is remounted when the wallet session, the deployment, the raffle or the owner changes
(OwnerReview.tsx:464-475).

#### Invariants

- S-I1. The Safe is asked once per saved intent. A wallet request is refused while an intent is saved
  (OwnerReview.tsx:713), and the reviewed action can be used once (service.ts:90-92).
- S-I2. The intent is saved under the lock before the provider is called (OwnerReview.tsx:706-719,
  service.ts:99-103).
- S-I3. The saved intent is removed only by a confirmed canonical execution (655, 853), by a rejection or a request
  that never left, and then only if the call fields were never exposed (743-757), or by Discard on a recorded
  revocation (871-881).
- S-I4. "Approval recorded" needs the executed transaction's own event with the same raffle, approver, digest and
  revision, two confirmations and matching block hashes (owner-execution.ts:43-74). A Safe proposal hash or a wallet's
  answer is never taken as execution.
- S-I5. One exclusive operation at a time; a result is applied only if it is still the latest operation for the same
  digest (514-541).
- S-I6. Attestations belong to one digest; a changed digest clears them (60-62, 589-617).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| idle | Approve | draft ready, trust check passed, no saved intent | preparing, then the Safe request | 690-730 |
| idle | Download revocation file | approved digest exists | preparing, then exported with the file | 731-741 |
| preparing | intent saved, request handed to the wallet | | requested; discovery starts | 706-727, 783 |
| preparing, requested | wallet rejects, or the request never left | call fields never exposed | error "The wallet request was cancelled", intent removed | 743-763 |
| same | same | call fields were exposed, or storage could not be read | requested, "Saved recovery is still being watched" | 764-766 |
| requested | wallet error after dispatch | | requested with "The wallet response is uncertain. Do not send another approval" | 767-774 |
| requested, exported, recovery, pending | discovery finds a candidate with two confirmations | | executed; intent removed; page re-reads from that block | 636-660 |
| same | candidate not yet two deep | | pending | 666-673 |
| same | nothing found | | unchanged; cursor advances; checked again every 15 s while visible | 620-634, 679-680 |
| same | discovery fails or times out | | unchanged, error line with Retry | 675-682 |
| requested, exported | Review and download call | same digest | exported, exposure recorded | 883-909, 921-924 |
| same | same | digest changed | old intent archived, fresh intent saved and downloaded | 910-919 |
| requested, exported, pending | hash entered and confirmed | | executed | 842-860 |
| any with intent | digest changes to the state right after this revocation | | recovery (the stored call is historical) | 423-433, 596-602 |
| any with intent | digest changes otherwise | | the handoff screen for the saved intent | 604-607 |
| recovery | Discard recorded review | | idle, intent removed | 871-881 |
| executed, error | Review current state, Return | | idle | 949, 952 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload or close after the intent is saved | The handoff screen returns from storage and discovery resumes | safe |
| Reload or close before it is saved | Nothing was sent. idle | safe |
| Two tabs | The lock and the saved intent let one request through. Both tabs discover the execution | safe. Test: `web/test/independent-owner-review-race.browser.test.ts` (NOT_RUN here) |
| Account or chain switch | The flow remounts. A request not yet dispatched is refused by `assertIntent` (service.ts:93-103) | safe |
| Wallet rejection | Intent removed unless its fields were exposed | safe |
| No hash, or a bare -32603 or -32000 | The wallet's answer is only a reference. The flow watches the chain | safe. Test: "warns that the wallet response is uncertain when the Safe request fails after discovery started" (`web/test/safe-approval-handoff.browser.test.ts:281`) |
| RPC lags or fails | Discovery reports an error and retries; a confirmed execution is re-read from its block (`readAdmissionFrom`, 68-76) | safe |
| Reorg | The cursor's checkpoint hash is compared on every page; a mismatch restarts the scan from the review block (owner-execution-discovery.ts:99-105). Confirmation re-checks every block hash at the end (owner-execution.ts:70-73) | safe. Tests in `web/test/owner-execution-discovery.test.ts` |
| Storage full | The intent is not saved and the request is not dispatched | safe by reading |
| Web Locks unavailable | "Safe recovery requires a browser with secure Web Locks" before the request | safe |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| Two Safe requests for one review | Unreachable: S-I1 |
| "Approval recorded" without the event | Unreachable: S-I4. Tests in `web/test/owner-execution-discovery.test.ts` and `web/test/chain.integration.test.ts` |
| A saved intent removed while the Safe could still execute it from exposed fields | Unreachable: S-I3 |
| A request that the Safe never proposed, with the page unable to ask again | Reachable by design: after an uncertain wallet answer the intent stays saved, so Approve is refused. The way on is Advanced recovery, which downloads a fresh call. See ambiguities |

### 8. Wallet connection machines

Code: `web/lib/chain/wallet-session.ts`, `web/lib/chain/wallet-connectors.ts`, `web/lib/chain/wallet-consent.ts`,
`web/lib/chain/appkit-provider.ts`. These have the densest existing tests (`wallet-session.test.ts`,
`wallet-connectors.test.ts`, `wallet-restoration.test.ts`, `independent-wallet-restoration-adversarial.test.ts` and
five `appkit-*` files), so this section records the encoding and the rules and reports what was checked by reading.

#### States

| Machine | Encoding | States | Ref |
|---|---|---|---|
| Session base | `state` (snapshot with a revision), `provider`, `epoch`, `suspended`, `disposed` | no provider; disconnected and listening; connected (any chain; callers compare the chain); suspended after a local disconnect; disposed | wallet-session.ts:8-16 |
| Browser session | `connection` status (idle, pending, error), `attempt` counter, `abort`, `chooser`, `chooserLoad`, `cleanup` promise chain, `cleanupFailures`, `cleanupNotice`, `inFlight`, `activeOwner`, `restoring` | idle; restoring; connecting for an owner; connected; blocked on an unconfirmed cleanup | wallet-connectors.ts:53-69 |
| Consent | `localStorage` `labx:wallet-consent:v1:{origin}:{projectId}:{scope}`: `{ connectorId, account, chainId, id }`; `sessionStorage` `{key}:revoked` for this tab | none; saved; revoked globally; revoked for this tab only | wallet-consent.ts:4-47 |
| AppKit runtime | module values `runtime`, `runtimeScope`, `pendingAttempt`, `cleanupLease`, `cleanupFailed`; per runtime `active`, `adoption`, `startupPending`, `initializationFailed` | not loaded; starting; ready; startup timed out (cleared if readiness arrives later); cleanup failed (until reload) | appkit-provider.ts:405-446, 520-630 |
| Connection attempt | `Attempt`: `cancelled`, `pending` count, `awaitingStart`, `completed` connectors, controller claim | open; connector running; cancelled and cleaning up; settled | appkit-provider.ts:17-28, 47-133, 222-259 |
| WalletConnect cleanup | `WalletConnectCleanup`: provider, topic, `completed`, `deleting`, `failure`; `releasedWalletConnectProvider` | observed; deleting; completed; failed; released | appkit-provider.ts:30-38, 261-356 |

#### Invariants

- W-I1. The revision rises on every published change, and every account or chain event first publishes a
  disconnected snapshot (wallet-session.ts:29-33, 69, 91). Every review, control scope and check key carries the
  revision, so nothing prepared under one session is used under another.
- W-I2. A transaction or signature request reaches the provider only after the session was re-read and compared,
  before and after the caller's own preparation (wallet-session.ts:121-134, 141-148).
- W-I3. A read started under one provider, epoch or revision is dropped if any of them changed (wallet-session.ts:85).
- W-I4. One connect or restore runs at a time. A connect from another owner while one is running is refused
  (wallet-connectors.ts:262-265). A superseded attempt cannot publish (`active`, 303-305, checked after every await).
- W-I5. Restoring never prompts: it reads accounts and chain, and requires the saved consent, the connector, the
  account and the chain to match before and after (wallet-connectors.ts:167-219, appkit-provider.ts:734-751).
- W-I6. An explicit Connect revokes the saved consent first, and a failed one removes it
  (wallet-connectors.ts:271-274, 352-354). Disconnect revokes it, in this tab at least (221-249).
- W-I7. A new chooser is not used until the previous chooser's cleanup finished, or failed within eight seconds, in
  which case connecting asks for a reload until that cleanup finishes after all (wallet-connectors.ts:122-157).
- W-I8. One attempt at a time in the AppKit runtime. A cancelled attempt disconnects every connector it completed
  before another attempt can start (appkit-provider.ts:47-65, 245-252, 758-763, 884-888).
- W-I9. The chooser hands over only the provider AppKit selected, after two matching reads of account and chain and
  after the connect call itself has settled (appkit-provider.ts:771-823).
- W-I10. A consent change in another tab, or cleared storage, disconnects this tab (wallet-connectors.ts:79-95).

#### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| disconnected | page load | consent saved for this chain | restoring | browser.ts:47, wallet-connectors.ts:167-179 |
| restoring | provider, account and chain match the consent | | connected | wallet-connectors.ts:192-205 |
| restoring | anything differs, or a read fails | | disconnected; chooser released | wallet-connectors.ts:194-214 |
| restoring | Connect click | | restore retired; connecting | wallet-connectors.ts:253-261 |
| disconnected | Connect click | chooser available | connecting (pending) | wallet-connectors.ts:266-289 |
| connecting | Connect from the same owner | | the same attempt | wallet-connectors.ts:263 |
| connecting | Connect from another owner | | refused, "A wallet request is still pending" | wallet-connectors.ts:264 |
| connecting | wallet approved, right chain | | connected; consent saved | wallet-connectors.ts:332-349 |
| connecting | cancelled, rejected, wrong chain, 20 s chooser load or 120 s approval timeout | | disconnected with an error line; consent removed; chooser disconnected | wallet-connectors.ts:350-367 |
| connecting | Cancel connection, or the gate unmounts | same owner, not yet connected | disconnected | wallet-connectors.ts:292-301 |
| connected | `accountsChanged` or `chainChanged` | | disconnected at once, then re-read up to three times over three seconds, then again on window focus | wallet-session.ts:20-34 |
| connected | provider `disconnect` or `session_delete` | | disconnected, suspended | wallet-session.ts:35, 111-116 |
| connected | account or chain differs on a passive read | | connected with the new values and a new revision | wallet-session.ts:91 |
| connected | Disconnect | | disconnected; consent revoked; chooser disconnected | wallet-connectors.ts:221-249 |
| connected | consent key changes in another tab | | disconnected; chooser released | wallet-connectors.ts:80-91 |
| any | chooser cleanup exceeds eight seconds | | connecting is refused with a reload message until that cleanup finishes | wallet-connectors.ts:132-157 |
| any | AppKit not ready in 20 s | no adopted connection | connecting is refused with a reload message until readiness arrives | appkit-provider.ts:613-628, 753 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload | Restore from consent without a prompt, or stay disconnected | safe |
| Two tabs | Each tab has its own session. Connect or Disconnect in one disconnects the other (W-I10) | safe; see ambiguities |
| Account or chain switch mid-flow | W-I1 and W-I2: the pending review is void and the provider is not called | safe. Tests: "does not invoke the provider if %s changes while journal acquisition waits" (`web/test/wallet-session.test.ts:31`), "rejects old actions when the selected provider changes during a journal wait" (`web/test/wallet-connectors.test.ts:312`) |
| Wallet rejects the connection | Error line, Connect again | safe |
| Session read fails after an event | Three tries, then on focus. Until then the wallet shows as disconnected | safe. Tests at `web/test/wallet-session.test.ts:55, 66` |
| Storage unavailable | Connect works for this tab with "this wallet will not be remembered" (wallet-connectors.ts:320-322, 346-348). Disconnect falls back to the tab marker or reports that LABx may reconnect (wallet-consent.ts:28-47) | safe |

#### Illegal combinations checked

| Combination | Result |
|---|---|
| A connected snapshot whose provider is not the one the person chose | Unreachable: W-I9, and restore compares the provider (wallet-connectors.ts:192-201). Test: "adopts only the exact provider returned by AppKit" (`web/test/wallet-connectors.test.ts:78`) |
| Two attempts sharing a chooser | Unreachable: W-I4, W-I8. Tests: "deduplicates only the same owned attempt" (`:89`), "does not let an old owner cancel a newer attempt" (`:155`) |
| A late wallet approval connecting after Cancel | Unreachable: the attempt counter. Test: "cancels only the matching owned attempt and ignores late provider approval" (`:103`) |
| A wallet restored after Disconnect in this tab | Unreachable: the tab marker or the removed consent. Test: `web/test/independent-wallet-restoration-adversarial.test.ts` |
| A wallet request sent under a session that has since changed | Unreachable: W-I2 |

No reachable invalid state was found in these machines.

### 9. Small machines

| Machine | Location | States and encoding | Invariant | Checked |
|---|---|---|---|---|
| Raffle page read and background poll | `web/components/workflow/RaffleWorkspace.tsx:79-192, 283-306` | loading, unavailable, legacy, mismatch, missing, error, ready with refresh idle, loading or error; `request` counter; `confirmedBlock` and `polledBlock` refs | A read older than a confirmed transaction or than a newer background read is never shown; writes pause while a refresh runs or failed | Covered by the frontend consistency audit (bugs 1 and 3). The poll reads the DOM for a review or a busy control (line 298), so a control that stays busy holds the page still; none was found that stays busy without a wallet request or a handoff |
| Account read | `RaffleWorkspace.tsx:232-265` | idle, loading, ready, error; `accountRequest` counter | Shown only when its raffle, block hash and account match the page | By reading |
| Seller step chain | `RaffleWorkspace.tsx:777-886` | `reclaimAfter` (the cancellation this page just confirmed), reveal preflight idle, loading or error with a `preflightInFlight` ref, `recovered` draw setup | Reclaim NFT follows only a cancellation confirmed straight from its own click, once, for the same wallet session and a read at or after its block; the reveal goes to the wallet once after its signature | Tests in `web/test/seller-draw-runner.browser.test.ts`; the latch is TransactionFlow T-I4 |
| Listing policy | `RaffleWorkspace.tsx:888-927` | loading, ready, error per scope (snapshot, wallet revision, retry) | The policy hash sent with List is the one read for the current snapshot | By reading |
| Edit-draft review | `web/components/workflow/SellerDraftForm.tsx:35-41, 553-605` | editing, review, saving, committed, retained, error; `commitmentInFlight` ref | One signature request at a time; unsaved edits survive a page re-read (`draftEdits`, `RaffleWorkspace.tsx:240, 320-322`) | Test: "keeps unsaved draft edits open through the page Refresh" (`web/test/seller-portal.browser.test.ts:492`) |
| NFT gallery and selection | `SellerDraftForm.tsx:30-34, 186-407` | inventory idle, loading, ready or error; selection pending or chosen; generation counters and an `AbortController` | An answer for another wallet, chain or request is dropped; ownership is read on chain when an NFT is chosen | Covered by `web/test/independent-create-selection-race.browser.test.ts` |
| Seller dashboard | `web/components/workflow/SellerDashboard.tsx:35-83` | idle, loading, ready, error; `request` counter | A superseded scan is dropped | By reading |
| Private records | `web/components/workflow/PrivateRecordsPanel.tsx:26-140` | loading-history, ready-history, loading-records, ready, error; `request` counter; per-operation tokens; delivery map per receipt | A signature or result from another wallet session is dropped; signed records survive Load more | Test: "keeps signed receipts through Load more and asks to sign only for the older purchases it finds" (`web/test/private-record-feedback.browser.test.ts:333`). A failed step still discards them: suspicion 5 |
| Entry records | `web/components/workflow/DrawProgress.tsx:12-27` | list, cursor (null when done), loading, error; `generation` and `busy` refs | A new raffle read resets the list and frees the next click | Test: "loads entry records on the first click after a refresh replaced a load still in flight" (`web/test/buyer-ui-repairs.browser.test.ts:495`) |
| Action trust | `web/components/workflow/useActionTrust.ts:8-21` | checking, trusted (null), failed (reason), per snapshot | Presentation only; preparation checks again | By reading |
| Notification feed | `web/components/NotificationFeed.tsx:22-90` | loading, ready, error; `flowRef` generation, refreshing flag and more-token | A refresh cancels a load of older items; a stale page is dropped | By reading |
| Notifications bell | `web/components/NotificationsBell.tsx:18-232` | unread flag; read watermark in `localStorage` `labx:notifications:read:{chain}:{contract}`; one request in flight | The watermark only moves forward by block and log index | Tests in `web/test/notification-unread.test.ts` |
| Wallet controls | `web/components/workflow/WalletConnectionControls.tsx:11-74` | the session's connection status plus the attempt owner this control started | Unmounting cancels only its own attempt | Test: "does not let synchronous gate unmount cancel a newly established session" (`web/test/wallet-connectors.test.ts:123`) |
| Paging lists | `SellerActivity.tsx`, `AccountHistory.tsx`, `BuyerRaffles.tsx`, `RaffleCatalog.tsx` | loading, ready, error; `request` counters | A superseded page is dropped; all pages of one load are pinned to one block | Covered by the frontend consistency audit |
| Intro film | `web/components/BrandSplash.tsx:78-83` | checking, playing, done; `sessionStorage` flag | Shown once per tab | By reading |

### Findings

#### Issue 1. Create sends a second draft after a wallet error that only a code marks as unsent (high, narrow trigger)

A wallet can answer `eth_sendTransaction` with a bare -32603 or -32000 after its own RPC already took the transaction.
The service treats those codes as weak evidence: it reads the account's nonces for about four seconds and, if they stay
quiet, removes the pending record and leaves a marker so that the next send checks that nonce first. It also called
the caller's `onNotDispatched`, and Create answered by dropping the step's checkpoint. With the checkpoint gone, Create
had no nonce to settle the step from.

Sequence:

1. The seller presses Create. The record holds `pending { step: "createDraft", hash: null, checkpoint }` at nonce N.
2. The wallet sends the transaction through its own RPC and answers with `{ code: -32603 }`.
3. LABx's RPC shows nothing at N for four seconds. The journal record is removed, the marker is written, and Create
   shows "Your wallet couldn't send this transaction. Nothing was sent." The create record now has `pending: null`.
4. The draft is mined. LABx's RPC now shows it.
5. The seller presses Create. The send stops at the marker with "Your wallet sent an earlier LABx request. Check the
   page before trying again." The marker's nonce is mined, so the marker is removed.
6. The seller presses Create again. Nothing remembers nonce N. The wallet is asked for `createRaffle` a second time.

The contract accepts the second draft (`contracts/src/LabxRaffle.sol:438-454` has no duplicate rule), so the seller
pays its gas, the NFT is locked into the second raffle, and the first stays as an orphan draft in their list. The
trigger needs a wallet that reports an error after broadcasting and an RPC that lags it by four seconds, which is the
case the marker was added for (A4).

- Code: `web/lib/chain/service.ts:221-224` (was the unconditional `onNotDispatched` call),
  `web/lib/chain/create-flow.ts:267-270, 281-293`.
- Tests:
  - "keeps the draft step's nonce after a bare -32603 error, so Create finds the draft the wallet sent and never asks
    for a second one" (`web/test/client-state-machines.test.ts:88`), default suite, the real service and create flow
    over a scripted chain.
  - "finds the draft a wallet sent behind a bare -32603 error that LABx's RPC saw only later, and makes no second
    draft" (`web/test/three-action-flow.integration.test.ts:361`), on Anvil with the real contract.
- Before, observed on Anvil: wallet requests were `createDraft, createDraft, approvePrize, escrow`; the first press
  after the draft landed stopped with the earlier-request message and the second sent the draft again; `nextId - 1`
  was 2; the record ended at `id: "2"`. In the default-suite test the record's `pending` was null right after step 3.
- Fix: the service reports a send as not dispatched only when the wallet refused it, was never asked, or its own
  message says it sent nothing. After a code-only failure the caller keeps its checkpoint, and Create settles the step
  from the chain as it already does after Continue and the 25-block clear: nothing at the nonce sends the draft again
  at that same nonce, something pending waits, and a mined nonce finds the draft. This is what
  `web/lib/chain/README.md` already described. What reaches a wallet is unchanged except that the second
  `createRaffle` is no longer sent when the first one landed.
- After, observed on Anvil: wallet requests were `createDraft, approvePrize, escrow`; one raffle; the record ended at
  `id: "1"`, `pending: null`. In the default-suite test three presses made no further wallet request and the record
  held the found creation hash.
- Also pinned: "sends the draft again at the same nonce when nothing landed there after a bare -32603 error" and
  "still retires the draft step at once when the wallet's own message says it sent nothing" (same file).

#### Issue 2. A slow send's control keeps waiting after its record is settled elsewhere (medium)

A send that is not two blocks deep after one minute leaves its control on "Still confirming on the network" and the
automatic saved-hash check takes over. That check can end in ways the control did not handle. In each, the journal
record was gone, no receipt was on its way to this control, and the control kept waiting.

**2a. The wallet replaced or dropped the transaction (medium).**

1. The buyer presses Buy and confirms in the wallet. The transaction stays unmined for more than a minute. The
   checkout shows "Still confirming on the network".
2. The buyer speeds it up or cancels it in the wallet. The old hash leaves the pool.
3. The replacement is mined two deep. The saved-hash check finds the old hash unknown, reads the nonces, and clears
   the record as spent, with the old hash's outcome rows and checkpoints.
4. The checkout still shows "Still confirming on the network", with no end. By reading, Check again then answers
   "Action unavailable" with the RPC's not-found text. The page is not re-read: after a speed-up the membership is
   bought and the page still shows the checkout from before it, with an allowance that is already spent; after a
   cancel the Buy button never returns.

- Tests (`web/test/client-state-machines.browser.test.ts`): "stops waiting for a purchase the wallet cancelled after
  the first watch, and buys again on the next click" (line 98) and "shows the membership a faster copy of the purchase
  bought after the first watch" (line 121).
- Before, observed: 60 seconds after the cancel was two blocks deep, "Still confirming on the network" was still on
  the page (count 1, expected 0). After the speed-up, "Membership price paid" did not appear within 60 seconds.
- Fix: the saved-hash check reports a record it cleared from the nonces as replaced
  (`web/components/workflow/useTransactionOutcomes.ts:95, 158`). The page's recovery panel then re-reads the chain, as
  it already did for a record without a hash, and shows "Your wallet replaced or dropped your last transaction. Check
  the page before trying again." until the next send or another wallet
  (`web/components/workflow/ResumeTransaction.tsx:56, 91-99, 200`). The control returns to its button
  (`web/components/workflow/TransactionFlow.tsx:265-274`). The line also shows when the replaced transaction is found
  after a reload.
- After, observed: "Still confirming" was gone, the line was shown above the page, the Buy button was back and the
  next click bought, which removed the line (two wallet requests in total, both from clicks). After the speed-up the
  page showed "Membership price paid" and the line, with one wallet request in total.
- Correction after a rerun: the first version (8bf7034) showed the notice inside the control with a Try again button.
  The page re-read remounts the checkout control, so the notice was gone within a second, and a second run of the
  sequence failed when Try again detached before the click. 9032cdd moved the line to the recovery panel, where the
  earlier-request line already lives for the same reason.

**2b. Another tab of the same wallet confirmed it first (low).**

1. The buyer presses Buy in tab A and confirms in the wallet. The transaction is slow. They switch to tab B, also on
   LABx with the same wallet. Tab A is hidden and stops checking.
2. The transaction is mined. Tab B's check confirms it and clears the journal record. Tab B shows "You're in".
3. The buyer returns to tab A. Its check finds the record gone and reports settled. Tab A's own outcome row is still
   "pending", so nothing looks for the receipt: "Still confirming on the network" stays until the buyer presses Check
   again.

- Test: "shows the receipt of a slow purchase that another tab of the same wallet confirmed first" (line 141).
- Before, observed: "You're in" did not appear in tab A within 60 seconds of returning to it.
- Fix: when the check reports settled while the control is still pending, the control runs the same read-only check as
  its Check again link (`TransactionFlow.tsx:265-274`), which finds the receipt and reports the control's own action
  as confirmed.
- After, observed: tab A showed "You're in" and no "Still confirming", with one wallet request in total.

What this changes about wallet sends: nothing is sent by the fix itself. One existing automatic send can now follow
from it: an approval that tab A sent and tab B confirmed is now confirmed in tab A without a click, and a confirmed
approval of this page's own click opens its purchase, exactly as it already does after a slow confirmation in one tab
(`web/test/easy-buy.browser.test.ts:425`). The journal still allows one wallet request per account across tabs.

Not covered by the fix: the manual Check again in the page's recovery panel (`ResumeTransaction.tsx:121-126`) clears a
replaced record through the same nonce rule without reporting it as replaced, so in that path the control ends on
"Action unavailable" with the RPC's text, the line is not shown and the page is not re-read. By reading; see
suspicion 2.

#### Open issue 3. Create sends a second draft when the creation log is not found (high, narrow, not fixed)

This predates the audit and is not changed by this branch. The independent review reproduced it on Anvil with an
injected lagging log read: two `createRaffle` requests and two raffles for one saved intent.

1. The seller's Create is broadcast and the wallet answers with a bare -32603. The checkpoint is kept (issue 1).
2. The draft is mined. The seller clicks Create. The nonce reads show the checkpoint's nonce as used.
3. `findCreation` reads the `RaffleCreated` logs up to the head and gets nothing, because the node that answers the
   log read is behind the node that answered the nonce read (`web/lib/chain/service.ts:298-310`).
4. The recovery treats the nonce as used by something else, drops the checkpoint (`web/lib/chain/create-flow.ts:291`)
   and sends `createRaffle` at the next nonce.

Cost: the gas of a second `createRaffle` and a spare draft the seller can cancel. No buyer money is involved.

Why it is not fixed here: a log range read cannot tell "no such log" from "this node has not seen those blocks yet",
and the two exact alternatives each have a cost that needs a decision. Finding the block in which the nonce was used
and reading that one block by hash is exact, but needs account state at past blocks, which pruning RPC providers do
not keep. Requiring two searches some blocks apart before giving up is provider-independent, but adds a field to the
saved create record and makes a seller whose wallet really did replace the draft wait and click again.

#### Open issue 4. A tab keeps an unverified row after another tab settles the same send (medium, not fixed)

This predates the audit. The independent review observed it at module level: two tabs recover a pending purchase;
after the wallet cancels it, tab A settles it and removes the shared recovery data; tab B keeps its `unverified` row
(`web/lib/chain/transaction-outcomes.ts:179`), which pauses transactions in tab B until a reload. Whether a tab
should drop a row whose checkpoint has gone is ambiguity 3.

#### Independent review of this branch

A Codex review of `54f317e..9032cdd` with eleven module probes and two browser probes found no defect in the three
changes. It confirmed that the kept record is the seller workflow's checkpoint and not the account-wide journal, that
a Create after a real no-send goes out at the same nonce, and that an approval confirmed in a second tab leads to
exactly one `buyPack` request across both tabs (the tab that sent the approval opens the purchase; the other does
not). It answered DO NOT MERGE because of open issues 3 and 4, which exist on `main` regardless of this branch. It
also noted that an RPC missing both a hash and its pending nonce can report a send as dropped while it is still
pending; the existing marker then holds the nonce, so a retry replaces that send and does not add one.

### Status of A1 to A5, B1 to B7 and C1 to C6

The earlier document gives one line per ID. Where the line covers two IDs (C5 and C6) the split below is inferred from
the commits of 972f46c. "Ran" says whether the proving test ran for this audit.

| ID | Earlier finding | Status at 54f317e plus this branch | Proof | Ran |
|---|---|---|---|---|
| A1 | Create stalls after an uncertain create step once the journal record is settled without it | Fixed in 972f46c: a step whose record is gone is settled from the chain | "sends the draft again after Continue clears its unsent record on another page, and makes one draft" and "finds the draft a wallet sent despite its error, after the mined nonce clears the record, and makes no second draft" (`web/test/three-action-flow.integration.test.ts:208, 218`) | yes |
| A2 | A wallet that overrides the nonce while the RPC lags leaves the journal waiting forever | Fixed for a returned hash: the record follows it to the wallet's nonce. Open and accepted when an earlier nonce of the account was dropped: the record waits until that gap is filled outside LABx (ambiguity 1) | "moves the record to the nonce a wallet chose for its returned hash, so it settles when that hash mines (watched: %s)" (`web/test/pending-send.integration.test.ts:495`); the accepted case is pinned by "keeps the record and waits when %s, even on Continue and after 25 blocks" (`web/test/pending-send.test.ts:105`) | yes |
| A3 | A hashless record cleared by Continue or expiry while the wallet still holds the prompt can be sent twice | Mitigated in 972f46c, residue accepted: the marker stops the next send once the old one is visible, and before that the next send reuses the nonce. A wallet that ignores the requested nonce can still send both; the exact allowance then makes the second purchase revert | "stops the next send before the wallet when a request cleared by Continue lands first, then sends on the next click" and "sends at the same nonce after Continue, and reports the old request as a replacement when it lands instead" (`web/test/pending-send.integration.test.ts:410, 434`); "after Continue, stops Buy once when the old approval lands meanwhile, shows it, then buys with one more wallet step" (`web/test/easy-buy.browser.test.ts:395`) | yes |
| A4 | A bare -32603 or -32000 clears the record after four seconds; a retry can duplicate a send the wallet's RPC took | Mitigated the same way for buys. For Create it was still open: finding 1, fixed in 3bc0972. The same wallet residue as A3 is accepted | "after a code-only failure is retired, a send the wallet's own RPC delivers later stops the retry before the wallet" (`web/test/pending-send.integration.test.ts:461`), and the tests of finding 1 | yes |
| A5 | A storage-error row stays after storage reads clean | Fixed in 972f46c | "removes its storage-error row once storage reads clean again, so new actions are no longer blocked" (`web/test/transaction-outcomes.test.ts:470`) | yes |
| B1 | The automatic purchase is lost to a trust-check race | Fixed in 972f46c | "still opens the purchase by itself when the action check finishes after the account and quote" (`web/test/easy-buy.browser.test.ts:454`) | yes |
| B2 | Background re-reads stay held after a rejected or failed action | Fixed in 972f46c | "keeps re-reading after a step is cancelled in the wallet, so the page moves on when someone else runs it" (`web/test/buyer-ui-repairs.browser.test.ts:468`) | yes |
| B3 | | Refuted in the earlier audit; nothing to check | | |
| B4 | Refresh discards draft edits | Fixed in 972f46c | "keeps unsaved draft edits open through the page Refresh" (`web/test/seller-portal.browser.test.ts:492`) | yes |
| B5 | Load more after signing drops the signed records | Fixed in 972f46c for a Load more that succeeds. A failed Load more or a rejected signature still discards them (suspicion 5) | "keeps signed receipts through Load more and asks to sign only for the older purchases it finds" (`web/test/private-record-feedback.browser.test.ts:333`) | yes |
| B6 | A late automatic send on reveal | Fixed in 972f46c: the automatic send is spent on the first decision | "never opens the wallet by itself once a saved transaction that held the confirmation is checked" (`web/test/seller-draw-runner.browser.test.ts:384`) | yes |
| B7 | A control inside a closed disclosure is not counted, so the recovery panel shows twice or not at all | Fixed in 972f46c | "shows exactly one Continue panel for an unsent record while Other actions opens and closes" (`web/test/independent-transaction-outcomes.browser.test.ts:892`) | yes |
| C1 | The owner flow's uncertain warning is lost once discovery has started | Fixed in 972f46c | "warns that the wallet response is uncertain when the Safe request fails after discovery started" (`web/test/safe-approval-handoff.browser.test.ts:281`) | yes |
| C2 | Entry records: a new read during a load leaves the button ignoring clicks | Fixed in 972f46c | "loads entry records on the first click after a refresh replaced a load still in flight" (`web/test/buyer-ui-repairs.browser.test.ts:495`) | yes |
| C3 | | Refuted in the earlier audit; nothing to check | | |
| C4 | AppKit taking more than 20 s to start disables the chooser until reload | Fixed in 972f46c: a late readiness clears the block. A startup that fails or never settles still needs the reload | "becomes usable without a reload when SDK readiness arrives after the startup timeout" and "keeps requiring a reload when SDK readiness %s after the startup timeout" (`web/test/appkit-provider.test.ts:256`) | yes |
| C5 | A wallet event whose session read fails leaves the wallet disconnected | Fixed in 972f46c: three reads, then again on focus | "retries the read after %s so a transient failure does not leave it disconnected" and "stops after three failed reads and reads again when the window regains focus" (`web/test/wallet-session.test.ts:55, 66`) | yes |
| C6 | A chooser cleanup that outlasts its bound blocks connecting until reload | Fixed in 972f46c when the cleanup finishes later. A cleanup that fails still needs the reload | "connects again without a reload when a cleanup that outlasted its bound later finishes", "clears the reload message a Connect click showed once that cleanup finishes after all" and "keeps requiring a reload when a cleanup that outlasted its bound later fails" (`web/test/wallet-connectors.test.ts:222, 247, 270`) | yes |

### Leads from the frontend consistency audit

Its eight unverified suspicions, as they stand after this audit:

| # | Suspicion | Result |
|---|---|---|
| 1 | One render of the previous account's data on a direct account change | Not examined: not a state machine of this slice |
| 2 | A failed step on the receipts page discards signed receipts | Still open, by reading. Suspicion 5 below |
| 3 | The seller studio after Create on a lagging node | Not examined |
| 4 | A catalog refresh leaves the load-more banner | Not examined |
| 5 | The bell's first fetch in development | Not examined |
| 6 | The "needs attention" status of a saved-hash check outlives its components | Confirmed by reading and wider than stated: the status never returns to checking, in the same mount either. Suspicion 1 below |
| 7 | A quote retried after its inputs changed keeps reading | Not examined |
| 8 | A confirmed draft edit and the recovery panel's refresh re-read without the confirmed block | Still open. This branch adds one more caller of that refresh (a replaced transaction), which also carries no block |

### Suspicions not reproduced

These follow from reading the code. None was driven to an invalid state by a test.

1. Attention is sticky. Once a saved-hash check has asked for a person (two failed reads, or three minutes pending),
   the entry keeps that status for the wallet session, also after the RPC recovers and on later pages
   (`web/components/workflow/useTransactionOutcomes.ts:74-114, 156-161`). The check keeps running and still ends in
   settled or replaced, so the cost is a manual panel shown while the automatic check is working. Low.
2. The recovery panel's manual check of a replaced hash. `ResumeTransaction.tsx:121-126` clears the record from the
   nonces without the replaced report, so a control in pending then runs its check, gets the RPC's not-found text
   under "Action unavailable", and the page is not re-read. It needs a person to press Check again in the panel in the
   seconds before the automatic check would have done the same. Low.
3. Confirmed by the independent review; see open issue 3 under findings.
4. Confirmed by the independent review; see open issue 4 under findings.
5. Signed receipts lost on a failed step. A failed Load more or a rejected signature sets the error state, and Retry
   starts again with nothing signed (`web/components/workflow/PrivateRecordsPanel.tsx:75, 114`). Low.
6. The automatic-send latch and a scope change. If a control with `submitOnMount` stayed mounted through a wallet
   revision change that happened before its first journal read, the send would fire in the new scope
   (`web/components/workflow/TransactionFlow.tsx:331-343`). Every current parent unmounts the control in that case,
   so this is a trap for a future caller, not a reachable state today.

### Ambiguities of intended behavior

1. Should a record that waits behind a dropped earlier nonce offer a way out? Today it waits until something fills the
   gap, and LABx itself cannot send to fill it, so the account needs a transaction from outside LABx. The page says
   "Waiting for your last transaction to confirm…" throughout. A create step kept without its journal record follows
   the same rule and answers "Wait for canonical confirmation"; since 3bc0972 that includes a step kept after a
   code-only wallet failure, which before would have been sent again at once.
2. Should a marker be removed when a later record at its nonce clears as spent? Today it stays, and the next send
   stops once with "Your wallet sent an earlier LABx request", which is not what happened.
3. Should a tab drop an unfinished outcome row when its checkpoint disappears from storage? Today it keeps it, pinned
   by "keeps deleted unknown saved activity blocking and never persists unowned unknown input"
   (`web/test/transaction-outcomes.test.ts:430`). That protects against deleted storage, and it is also what leaves
   suspicion 4.
4. Should the owner be able to ask the Safe again after an uncertain wallet answer? Today the saved intent blocks
   Approve for good, and the way on is Advanced recovery with a downloaded call. A Safe that never received the
   request therefore needs the manual path.
5. Should Connect in one tab disconnect the other tabs? Today any change of the saved consent does, including a
   Connect to the same account. A buyer between approval and purchase in the other tab loses the automatic purchase
   and needs one more click after reconnecting.
6. Should a replaced transaction get a receipt? After finding 2a the page says the wallet replaced or dropped the
   last transaction and shows the chain's state, but a purchase bought by a speed-up after the first watch has no "You're
   in" receipt, because LABx never learns the replacement's hash. While the first watch is still running, the same
   speed-up does get its receipt.
7. Is "Nothing was sent" the right wording after a code-only wallet failure? The service keeps a marker precisely
   because it cannot know, and after finding 1 the next Create first reads the chain.

### Test results

All commands ran in the worktree at the commit named. Opt-in lanes ran one at a time with `--maxWorkers=1`.

| Check | Command | Result |
|---|---|---|
| Baseline at 54f317e | `npm --prefix web test` | PASS: 78 files passed, 52 skipped; 1,293 tests passed, 376 skipped |
| Finding 1 before its fix, on Anvil | `RUN_CHAIN_INTEGRATION=1 npx vitest run test/three-action-flow.integration.test.ts --maxWorkers=1 -t "bare -32603"` in `web`, service at 54f317e | FAIL as expected: 1 failed. Requests `createDraft, createDraft, approvePrize, escrow`, two raffles |
| Finding 1 before its fix, default suite | `npx vitest run test/client-state-machines.test.ts` in `web`, service at 54f317e | FAIL as expected: 1 failed, 2 passed |
| Finding 1 after its fix | `RUN_CHAIN_INTEGRATION=1 npx vitest run test/three-action-flow.integration.test.ts test/pending-send.integration.test.ts --maxWorkers=1` | PASS: 2 files, 49 tests |
| Finding 2 before its fix, at 3bc0972 | `RUN_CLIENT_STATE_MACHINES_BROWSER=1 npx vitest run test/client-state-machines.browser.test.ts --maxWorkers=1` | FAIL as expected: 3 of 3. The cancel sequence was run again with its first assertion on the old screen: "Still confirming" still shown after 60 s |
| Finding 2, first version of the fix (8bf7034) | same | PASS 3 of 3 on the first run. FAIL on the second run: 1 failed (the cancel sequence, Try again detached before the click), 2 passed. See the correction under finding 2a |
| Finding 2, final fix (9032cdd) | same | PASS: 3 of 3, run twice (once before the commit, once at 9032cdd) |
| Full default suite at 9032cdd | `npm --prefix web test` | PASS: 79 files passed, 53 skipped; 1,296 tests passed, 380 skipped |
| Types at 9032cdd | `npx --prefix web tsc --noEmit -p web/tsconfig.json` from the repository root | PASS, exit 0 |
| Default suite plus every lane behind `RUN_CHAIN_INTEGRATION`, at 9032cdd | `RUN_CHAIN_INTEGRATION=1 npm --prefix web test` | PASS: 98 files passed, 34 skipped; 1,483 tests passed, 193 skipped |

Opt-in browser lanes at 9032cdd, each as `RUN_<SWITCH>=1 npx vitest run test/<file> --maxWorkers=1` from `web`, with a
local chain (anvil) and the contract artifacts built by `forge build --root contracts`:

| Lane | Switch | Result |
|---|---|---|
| `client-state-machines.browser.test.ts` (new) | `RUN_CLIENT_STATE_MACHINES_BROWSER` | PASS, 3 of 3 |
| `easy-buy.browser.test.ts` | `RUN_EASY_BUY_BROWSER` | PASS, 11 of 11 |
| `buyer-ui-repairs.browser.test.ts` | `RUN_BUYER_UI_REPAIRS_BROWSER` | PASS, 14 of 14 |
| `independent-transaction-outcomes.browser.test.ts` | `RUN_INDEPENDENT_TRANSACTION_OUTCOMES_BROWSER` | PASS, 11 of 11 |
| `independent-buyer-state.browser.test.ts` | `RUN_INDEPENDENT_BUYER_STATE_BROWSER` | PASS, 2 of 2 |
| `frontend-consistency.browser.test.ts` | `RUN_FRONTEND_CONSISTENCY_BROWSER` | PASS, 7 of 7 |
| `seller-draw-runner.browser.test.ts` | `RUN_SELLER_DRAW_RUNNER_BROWSER` | PASS, 13 of 13 |
| `seller-portal.browser.test.ts` | `RUN_SELLER_PORTAL_BROWSER` | PASS, 14 of 14 |
| `independent-transaction-lineage.browser.test.ts` | `RUN_INDEPENDENT_TRANSACTION_LINEAGE_BROWSER` | PASS, 1 of 1 |
| `private-record-feedback.browser.test.ts` | `RUN_PRIVATE_RECORDS_BROWSER` | PASS, 6 of 6 |
| `safe-approval-handoff.browser.test.ts` | `RUN_SAFE_APPROVAL_BROWSER` | PASS, 5 of 5 |
| `independent-empty-raffle-recovery.browser.test.ts` | `RUN_INDEPENDENT_EMPTY_RECOVERY_BROWSER` | PASS, 12 of 12 |
| `independent-seller-simplification.browser.test.ts` | `RUN_INDEPENDENT_SELLER_SIMPLIFICATION_BROWSER` | PASS, 5 of 5 |
| `activation-trust.browser.test.ts` | `RUN_BROWSER_ACCEPTANCE` | PASS, 5 of 5 |
| `independent-three-action-safe.browser.test.ts` | `RUN_INDEPENDENT_THREE_ACTION_BROWSER` | PASS, 3 of 3 |
| `independent-five-tier-form.browser.test.ts` | `RUN_FIVE_TIER_VERIFICATION` | PASS, 1 of 1 |
| `wallet-restoration.browser.test.ts` | `RUN_WALLET_RESTORE_BROWSER` | PASS, 1 of 1 |
| `independent-wallet-restoration.browser.test.ts` | `RUN_INDEPENDENT_WALLET_RESTORE_BROWSER` | PASS, 1 of 1 |
| `independent-complete-create-race.browser.test.ts` | `RUN_INDEPENDENT_COMPLETE_CREATE_RACE` | PASS, 1 of 1 |
| `independent-create-selection-race.browser.test.ts` | `RUN_INDEPENDENT_CREATE_SELECTION_RACE` | PASS, 4 of 4 |

That is twenty lanes and 120 tests. The first eight existing lanes also passed at 8bf7034 (73 tests) before the
correction. After every lane `git status --short` showed no change made by a lane to `web/tsconfig.json` or to any
other tracked file.
The seller simplification lane wrote screenshots under `artifacts/`, which were removed and not committed.

NOT_RUN: six browser lanes that do not render the changed components (`owner-review-race`,
`independent-owner-review-race`, `independent-owner-export-rejection-race`, `owner-recovery.builder`,
`wallet-nft-picker.verification`, `browser-chain-lifecycle`); the four integration files with their own switches
(`draw-runner.integration`, `independent-transaction-lineage.integration`,
`independent-wallet-review-repairs.integration`, `independent-claude-final-repairs.integration`); and
`draw-runner.fork`.

No independent review of these commits was run from this slice.

New tests on this branch: three in `web/test/client-state-machines.test.ts` (default suite), one in
`web/test/three-action-flow.integration.test.ts`, three in `web/test/client-state-machines.browser.test.ts`, and two
tightened assertions in `web/test/automatic-outcome-check.test.ts`.

Limits of the evidence: the browser lanes use an injected local wallet, so WalletConnect, AppKit and a real Safe were
covered only by their unit tests. Lag, replacement and wallet errors were simulated on a local chain or a scripted
client. No production RPC was called.
