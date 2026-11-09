# State machines: contracts and deploy tooling

Part of the state machine audit of 10 November 2026, based on main at 2078b82. This part covers
`contracts/src/LabxRaffle.sol` and the deploy tooling in `contracts/script/`. It builds on the audit of 7 November
(`docs/build/implicit-state-machines-20261107.md`, defect IDs E1 to E8).

`LabxRaffle.sol` is deployed on mainnet and immutable. Nothing under `contracts/src/` changed in this work. Contract
findings carry a test and an operational mitigation. Tooling findings carry a fix and its before and after result.

Line references are to `contracts/src/LabxRaffle.sol` unless a path is given, and to the tree at the head of branch
`audit/state-machines-contracts-20261110`.

## Summary

| ID | Severity | Where | What | Status |
|---|---|---|---|---|
| C1 | high, conditional | `LabxRaffle.sol:520-528`, `835-843` | A collection that does not check `from` lets anyone re-escrow a held token and take a live raffle's prize. | Open. Contract cannot change. Mitigation below. |
| D1 | low | `contracts/script/mainnet-deploy.sh:138-147` | A driver killed outright during stage 2 left forge's run file unkept, unused and then deleted. | Fixed in f7bb36a. |

No other invalid state or transition was reached. The transition table below was executed cell by cell, and a stateful
invariant run with a model of every guard found no disagreement in 38,400 calls.

E1, E2, E3, E7 and E8 are fixed. E4 is fixed with one residual question (A3). E5 is accepted as dead code. E6 was
refuted on 7 November and nothing found here reopens it. Details are under "Status of E1 to E8".

## How the evidence was produced

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

## 1. Raffle phase

### States

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

### Invariants

1. Phase only moves along these edges: Draft to Open or Cancelled; Open to Closed or Cancelled; Closed to Drawing or
   Cancelled; Drawing to Drawn or Cancelled; Drawn to Settled. Settled and Cancelled are terminal. There is no back
   edge.
2. `nextId` is one more than the number of raffles, and ids are dense.
3. A raffle in Open, Closed, Drawing or Drawn has `escrowed == true`, a pinned policy and `approvedAtOpening == true`.
4. Draft has no lots. Draft and Open have `lotCursor == 0`, `snapshotted == false`, `snapshotTotal == 0`.
5. Pause changes exactly two cells of the table: `open` and `buyPack` (`:625`, `:951`).

### Transition table

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

### Illegal combinations checked

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

## 2. VRF request lifecycle

### States

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

### Invariants

1. `activeDrawings` equals the number of raffles in Drawing (`:720`, `:830`, `:1068`).
2. Drawing implies a non-zero request id that maps back to the raffle on its pinned coordinator, a complete snapshot
   and `snapshotTotal > 0`.
3. A raffle is drawn at most once. Drawn or Settled implies exactly one Drawing to Drawn step, a winner that never
   changes afterwards, `vrfRequestedAt <= drawnAt < vrfRequestedAt + 7 days`, and a winner who bought a pack.
4. Outside Drawn and Settled, `winner`, `drawnAt` and `randomWord` are zero.
5. A Cancelled raffle holds no request, and an aborted request no longer maps to any raffle.
6. A request id is used once per coordinator (`:1052`). `retryRandomness` always reverts (`:727-729`).

### Transition table

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

### Orderings attacked

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

## 3. Admission and approval

### States

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

### Invariants

1. A raffle opens only when its stored approval equals the current hash and was given by the current owner.
2. `approvedAtOpening` is true exactly when a policy is pinned.
3. Every opened raffle keeps a non-zero `approvedReviewHash`: approval can only be revoked in Draft.
4. `reviewRevision` only grows.

### Transition table

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

### Orderings attacked

Approval revoked, owner changed, owner away and back, each policy setter (including identical and restored values),
and a seller edit, all between approve and open: covered by `Admission.t.sol` (8 tests) and
`IndependentAdmissionAccountingVerification.t.sol`. The handler adds a model of the open guard (`_admitted`) checked on
every `open` call, with owner changes and policy setters interleaved at random. Self-transfer of ownership is covered
by `test_pendingOwnerIsReplacedNotClearedAndSelfAcceptVoidsApprovals`.

## 4. Claims and payouts

### States

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

### Invariants

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

### Orderings attacked

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

## 5. Snapshot progress

### States

`lotCursor`, `snapshotTotal`, `snapshotted` (`:87`, `:92-93`), with `cumulatives[id]` and `snapshotOwners[id]`
(`:247-248`).

| State | Encoding |
|---|---|
| not started | `lotCursor == 0`, not snapshotted |
| in progress | `0 < lotCursor < lots` |
| complete | `snapshotted`, `lotCursor == lots` |
| complete and empty | complete with `snapshotTotal == 0` |

### Invariants

1. `lotCursor <= lotCount`, and `snapshotted` implies equality.
2. `snapshotTotal` never exceeds the entries sold, and equals them for every raffle that reaches Drawing.
3. For a raffle that reaches Drawing, the last cumulative equals `snapshotTotal`.
4. Lots cannot be added after Closed, so the lot list is fixed while the cursor moves (`:954`).

### Transitions and orderings

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

## 6. Escrow and custody

### States

| State | Encoding |
|---|---|
| not held | `escrowed == false`; the seller (or, after a claim, the winner) owns the token |
| held | `escrowed == true` and `IERC721(nft).ownerOf(tokenId) == this` |
| flag without token | `escrowed == true` and the token is elsewhere |

`escrowed` (`:86`) is a flag per raffle. Custody is the external `ownerOf` answer (`:526`, `:591`). Nothing ties a
token to one raffle.

### Invariants

1. With a collection that follows ERC-721: `escrowed` implies the contract holds the token, the contract holds exactly
   one token per escrowed raffle, and a token released goes to the winner (Settled) or the seller (Cancelled).
2. `onERC721Received` accepts only a transfer the contract itself started (`:939-942`).
3. The NFT and token id cannot change once escrowed (`:469`).

Invariant 1 depends on the collection. See C1.

### Transition table

| From | Event | Guard | To | Who | Ref |
|---|---|---|---|---|---|
| not held | `escrow` | Draft; `safeTransferFrom(seller, this)` succeeds and `ownerOf == this` | held | S | `:520-528` |
| held | `claimPrize` | Settled | not held (winner) | W | `:770-778` |
| held | `reclaimPrize` | Cancelled | not held (seller) | S | `:835-843` |
| held | the collection moves the token by itself | external | flag without token | NFT | none |

### Illegal combinations checked

| Combination | Result | Evidence |
|---|---|---|
| Two raffles escrowed on one token, standard collection | unreachable: the second `safeTransferFrom` fails because `from` is not the owner | `test_standardCollectionRefusesASecondEscrowOfAHeldToken` |
| Two raffles escrowed on one token, collection that ignores `from` | reachable: finding C1 | `test_collectionThatIgnoresFromLetsAStrangerTakeALivePrize` |
| A draft naming USDC as its collection reaching `escrowed`, then `reclaimPrize` calling `transferFrom` on USDC (same selector) | unreachable: `escrow` needs `safeTransferFrom` and `ownerOf` | `test_draftNamingUsdcAsItsCollectionCannotEscrowOrReclaim` |
| An NFT sent with `safeTransferFrom` by anyone else | refused | `LabxRaffle.t.sol:589`, `:606` |
| An NFT sent with plain `transferFrom` | accepted by the collection and stuck; the contract cannot refuse it | E7, accepted |
| A prize that reverts on the way out | blocks only that prize; USDC claims and refunds still work | `test_stickyNftBlocksClaimButNotUsdc`, `test_stickyNftCancelStillRefunds` |

## 7. Cancellation

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

## 8. Ownership and coordinator migration

### Ownership

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

### Coordinator migration

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

## 9. Pinned policy

States: `_policies[id]` is all zero before opening, and a full copy of the opening defaults after (`:638`,
`:608-622`).

Invariants: the pinned policy never changes after opening (handler `policyChanged == false`, with every setter
interleaved); it holds a non-zero coordinator, treasury and terms hash and the constant fee rates; buys check the
pinned terms (`:952`), fees use the pinned rates (`:961-962`, `:762`), the request uses the pinned VRF settings
(`:1027-1042`), and fees go to the pinned treasury (`:796`).

`openWithPolicy` lets the seller refuse an opening whose defaults changed since they looked (`:599-602`). Plain `open`
takes whatever is current. Both need a current approval, and every setter makes approvals stale, so a setter between
approve and open stops both.

## 10. Deploy driver record (`contracts/script/mainnet-deploy.sh`)

### States

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

### Invariants

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

### Transition table

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

### Retries and concurrency checked

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

## 11. DeployMainnet fresh, resume and verify (`contracts/script/DeployMainnet.s.sol`)

### States

The script keeps no state. Each run reads the mode from `DEPLOY_MODE` (`:167-170`) and everything else from chain.

| Dimension | Values | Read at |
|---|---|---|
| mode | fresh, resume, verify | `:169-170`, `:234` |
| raffle | none; created; native billing on; ownership offered; owned by the Safe | `:205`, `:212`, `:290-294` |
| subscription | untouched; consumer added; funded to target; ownership offered; owned by the Safe | `:86-93`, `:206-215` |
| launched | the Safe owns the raffle, nothing pending, not paused | `:316-318` |

### Invariants

1. A fresh run sends a CREATE only at `EXPECTED_NONCE` and only to an untouched subscription the deployer owns
   (`:192-196`).
2. A resume sends only the missing steps and only the funding shortfall (`:205-215`), and only for a raffle whose code
   hash equals a fresh deployment's and whose settings are the reviewed ones (`:279-313`).
3. After any successful run the handoff holds: reviewed settings, native billing, the raffle is the only consumer,
   and both the raffle and the subscription are owned by the Safe or offered to it (`:323-337`).
4. `verify` sends nothing and takes no missing step (`:234-257`).

### Transition table

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

### DeploySepolia and DeployLocal

`DeploySepolia` (`contracts/script/DeploySepolia.s.sol`) has no resume and no record: three transactions in one
broadcast. A run that stops part way leaves a raffle the deployer still owns, and a rerun deploys another. Testnet
only, accepted. Since 7c8c6ed it leaves the raffle paused. `DeployLocal` accepts chain 31337 only and unpauses, for
fixtures.

## Findings

### C1. A collection that does not check `from` lets anyone take a live raffle's prize

Severity: high (the prize of a live raffle and the buyers' money are at risk), conditional on the collection. A
collection that follows ERC-721 is not affected. No raffle exists on mainnet today.

Reachable sequence, with a collection whose `transferFrom` moves a token for its owner without checking that `from`
is the owner:

1. Raffle A is escrowed, approved and Open on token T. The contract owns T.
2. Anyone calls `createRaffle` for the same collection and T. No approval is needed for a draft.
3. They call `escrow` on their draft. The contract calls `safeTransferFrom(caller, this, T)` as the token's owner.
   The collection moves T from the contract to the contract. `ownerOf == this` holds, so the draft is `escrowed`
   (`:524-526`).
4. They call `cancel` on their own draft (`:805-819`), then `reclaimPrize` (`:835-843`). The contract sends T to them.
5. Raffle A still reads `escrowed == true`, keeps selling, draws and settles. `claimPrize` reverts for its winner, and
   the seller can still claim the proceeds.

Cause: `escrowed` is per raffle and custody is `ownerOf == this` (`:526`, `:591`). Neither says which raffle a held
token belongs to, and `escrow` does not check that the seller owned the token before the transfer.

Test: `contracts/test/StateMachine.t.sol` `test_collectionThatIgnoresFromLetsAStrangerTakeALivePrize` (passes, which
shows the sequence works). Control: `test_standardCollectionRefusesASecondEscrowOfAHeldToken`.

Mitigation, since the contract cannot change:

- Admission review, before `approveRaffle`: prove the collection refuses a transfer whose `from` is not the owner.
  Simulate, as the current holder, `transferFrom(<some other address>, <raffle>, <tokenId>)` and require a revert,
  for example `cast call <nft> "transferFrom(address,address,uint256)" <other> <raffle> <tokenId> --from <holder>`.
  Add it to the NFT review in `LAUNCH.md` section 5 next to the proxy and transfer-restriction checks. The collections
  in common use (OpenZeppelin, Solmate, ERC721A) pass.
- Review, before `approveRaffle`: no other raffle that is not Settled-and-claimed or Cancelled-and-reclaimed names the
  same collection and token.
- Monitoring: alert on an `Escrowed` event whose collection and token are already held for another raffle, and on
  `PrizeReclaimed` for a raffle whose token is named by a raffle in Open, Closed, Drawing or Drawn.
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

### D1. A driver killed outright during stage 2 loses forge's run file

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

## Status of E1 to E8

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

## Suspicions not reproduced

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

## Ambiguities: is this intended?

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

## Test results

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
