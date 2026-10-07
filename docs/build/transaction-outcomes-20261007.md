# Transaction outcome recovery

This contract covers ordinary buyer and seller transactions. External Safe approval execution keeps its separate reviewed-intent flow. These changes do not change on-chain fees, custody, permissions or deadlines.

## Ownership

The transaction owner lives outside conditional React controls. It retains wallet prompts, submitted hashes and confirmation work when a control unmounts, a page refreshes its data or the connected wallet changes. Results belong to the original account, network and deployment. Returning to that account restores its result; it does not restore permission to sign an obsolete review.

Browser storage contains untrusted recovery hashes. It never proves payment, success, action type or permission. Purchase feedback must use the actual canonical transaction's sender, target, calldata, raffle and successful receipt. An approval, refund, another raffle's purchase or a cancelled replacement must not become the current raffle's purchase confirmation.

## Two recovery operations

Read-only receipt inspection checks the deployment, sender, canonical receipt block and existing two-confirmation depth. It may inspect a cancellation or contract-creation replacement. It must not create, rewrite or clear a nonce journal, request a signature or authorize a new transaction. Historical receipt recovery uses this operation.

Guarded reconciliation resolves the wallet's pending nonce. It retains the existing wallet revision, sender, nonce, intent and canonical receipt checks. It can follow a same-nonce replacement, but cannot reconcile an unrelated action or another wallet's transaction. Recheck the initiating wallet after awaited work and validate every persistence callback's account and chain before writing.

## Persistence and replacement rules

- Persist a replacement's recovery hash before updating the pending journal. Persist the actual canonical hash before removing that journal, even when the requested hash resolves to a different transaction.
- A failed checkpoint write leaves the matching journal recoverable. A crash before journal removal requires guarded reconciliation. A crash afterward requires only read-only canonical receipt inspection.
- Associate attempts only through validated transaction identity and checked journal lineage. Saved aliases and wallet-requested nonces alone do not establish that two transactions are related.
- An older pending or failed attempt cannot replace a terminal result or recreate an acknowledged operation.
- Acknowledgment uses service-validated receipt metadata and runs its exact checkpoint check under the account journal lock. It must retain a hash still needed by an unresolved same or older nonce and leave a newer unrelated journal unchanged.

## Interface and bounded history

Keep the receipt and recovery controls available independently of the action that submitted the transaction. Automatically revalidate saved receipts with bounded concurrency. Completed historical receipts must not block ordinary navigation or invalidate seller controls when their blocks are already included in the current authoritative snapshot.

History limits must be explicit. An uninspected overflow cannot silently hide a purchase and bypass its repeat-purchase barrier. Provide a safe way to advance through the remaining history. Never evict unknown or pending activity to make room.

After a purchase, require an explicit **Buy again** action and fresh raffle, account and quote data at or after the receipt block. An acknowledgment failure must not reset consent or unlock the form. When purchases are permanently unavailable under the published raffle rules, a verified receipt may be acknowledged after fresh raffle and account reads. Temporary pauses and failed reads are not evidence that sales have permanently ended.

## Verification and limits

The independent browser regressions cover unrelated transaction semantics, refresh during confirmation, late wallet responses, real same-nonce cancellation, cold reload, newer-journal isolation and wallet changes during recovery. Service and owner tests cover persistence failures, canonical replacements, acknowledgment ordering, bounded history and stale completions. Normal seller creation, opening, settlement and refund journeys remain acceptance criteria.

Use the aggregate and serial browser commands in [portable verification](repository-cleanup-plan-20261007.md). Bind results to the tested revision; passing a smaller suite does not waive a failed browser journey. Final source review must inspect the actual service boundary and consumers.

These checks establish local source behavior. They do not establish a live Safe/Chainlink lifecycle, physical-device compatibility, production capacity or formal audit assurance. The v3 deployment remains a separate user-signed operation described in [the release plan](../../LAUNCH.md).
