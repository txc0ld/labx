# Seller workflow simplification

Base: `ce7c74cbef2507f6fa0979b5e53d02be5329e30a`. Risk: R3, bounded read-only transaction orchestration. Preflight: `artifacts/workflow-simplification-20261010/preflight-ux-only.md` in the parent workspace.

## Contract

- Select the seller's next step using canonical phase, custody, admission and existing eligibility. Keep cancellation and recovery accessible under Advanced. Put the next step before secondary accounting.
- Collapse terminal history and definite nonbroadcast failures into Activity. Keep all unresolved wallet-wide recovery and storage failures visible. Preserve subscriptions, retention and explicit acknowledgement.
- Automatically load opening policy with scope invalidation and explicit retry. Keep the complete policy visible and bind preparation to its displayed hash.
- Opt in only primary approvePrize, escrow, open and explicitly reviewed/saved createDraft to automatic read-only preparation. Require the connected intended-network session, enabled writes, no active outcome and a successful clear journal read. One automatic attempt per semantic scope. Cancellation and errors require explicit retry. Mount must never sign, submit, connect, save commitments or reveal private calldata.
- Preserve the displayed service-owned PreparedAction and explicit Confirm. Service/journal/confirmation/contracts and EIP-7702 admission remain unchanged.
- Show the three unchecked, digest-bound owner attestations immediately. Preserve deliberate revocation, manual export, stored recovery and canonical discovery.

## Threat and recovery assumptions

Wallet/session, route, action and policy can change during any read. Pending storage can fail or contain an uncertain send without a hash. Late work cannot replace current review or recovery. Simulation sends calldata to RPC, so reveal remains explicitly triggered. Retain the existing recovery owner and storage semantics. This is a reversible frontend patch; rollback is a source revert with no migrations or on-chain action.

## Acceptance

Behavioral checks cover phase/eligibility selection, Activity visibility, deferred journal/preparation and session changes, cancellation/failure without retry loops, exact explicit confirmation, immediate owner checklist, manual reveal and saved-create boundaries. Run affected seller, transaction outcome, owner/Safe and wallet regressions, TypeScript and production build. Browser fixtures use isolated local chain accounts and sequential Next output. Independent verification and separate Astra review must bind to the final candidate; this document does not approve release.

Evidence: parent `artifacts/workflow-simplification-20261010/builder/`. Usage: unknown.
