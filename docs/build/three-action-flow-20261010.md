# Three-action raffle workflow contract

Base: 01d567043cbed72fb5ecef97d096fedc37da19e3. User requirement: "1 button create, 1 button approve. 1 button list. thats it". This supersedes the prior scope that retained per-operation website confirmations and normal-path Safe JSON export. Risk R3: user-intent orchestration, signatures, custody and canonical execution. Root Astra design preflight approves the bounded implementation below, subject to independent verification/review and the standing human website-release authorization.

## Acceptance and visible journey

The connected seller fills the existing validated NFT, title, deadline and five-tier fields and clicks Create once. Without more website prepare/review/continue clicks, the app securely saves the signed draw commitment, creates the on-chain draft, approves the exact NFT token if required, and escrows it. Each distinct wallet signature/transaction still requires the human's wallet confirmation. The visible Create consent must state the NFT will be locked and multiple wallet confirmations may follow. Never imply these are one atomic transaction. No on-chain submission happens merely by mounting or restoring a page.

The connected owner reviews the canonical NFT identity, custody, economics and draw funding facts, then clicks Approve once. Display concise adjacent language that the click confirms review of canonical collection provenance, transfer restrictions/upgradability and draw funding. The click binds all three explicit attestations to the currently displayed digest. Remove the three separate checkboxes from the normal path. Prepare and send the exact approval request through the connected Safe via the existing wallet provider. Normal approval requires no JSON export/import, copied calldata, hash paste, extra website confirmation, or unrequested SDK/account. Wallet/Safe signatures and execution remain user-controlled. Advanced recovery retains the existing manual tools.

The seller sees List after valid approval. Show the short policy/fee summary before it. Clicking List prepares and sends openWithPolicy bound to the displayed expectedPolicyHash, with no extra website confirmation. No actual opening happens without that explicit click and wallet approval.

Each successful normal path has exactly one site activation for its stage, after wallet connection/form entry. Connection and selecting an NFT are prerequisites, not additional transaction preparation screens. Exception/recovery states may require an explicit retry/resume using the same stage button. Keep old receipts/accounting/technical details disclosed secondarily; critical unresolved transactions remain prominent. Preserve artwork, brand, legal copy, buyer lifecycle, ownership policy and the current V3 deployment.

## Required invariants

1. Never bypass RaffleService's prepared-action ownership, fresh simulation, exact calldata/value/recipient, deployment attestation, connected wallet revision/account/network, journal and canonical receipt checks. Existing direct transaction path and buyer flow stay fail-closed.
2. Create orchestration is a finite explicit intent captured at the click, scoped to immutable form/draft fingerprint, seller, chain, manifest and operation generation. Session, route, unmount, changed inputs, chain/policy or invalidated draft retires stale work. No continuation may sign or submit after its scope is retired. Never recreate a failed/refreshed intent automatically.
3. Only proceed to the next create step after exact canonical success with the required two-confirmation depth and a fresh raffle/account read. Resolve created ID from the canonical manifest-address RaffleCreated log and exact create calldata. Verify seller/NFT/token/commitment and draft identity; never infer nextId or take a catalog entry by order. Replaced, reverted, unknown or inconsistent transactions stop progression. Approved token skipping requires a fresh chain read.
4. Persist signed commitment before draft transaction. Keep private commitment material out of browser persistence, URLs, logs and error reports; persist only validated public recovery identifiers and already-public draft fields needed for exact recovery. Reuse the established durable preparation recovery. A refresh cannot create a second draft or silently generate a new draw setup. An in-progress or uncertain journal blocks all new sends and uses canonical recovery first. The same Create button resumes chain-proven stages only after explicit user activation.
5. Coalesce double clicks. Storage failure before wallet invocation sends nothing. Rejection stops with no automatic retry; ambiguous post-request failures retain recovery state and prevent blind duplication. A queued async wallet request cannot outlive the user's scope. Do not clear pending data solely to enable another send.
6. Safe requests have a separate service boundary from EOA submit. Preferred API: requestOwnerExecution({prepared,wallet,beforeRequest}) constructs/validates from the service-owned PreparedAction, persists the OwnerExecutionIntent through beforeRequest before wallet dispatch, consumes the capability exactly once and requests only the exact to/data/value from the current Safe. Do not accept arbitrary reconstructed caller intents as dispatch authority. No EOA nonce or EOA transaction journal on this path.
7. Safe eth_sendTransaction returns a wallet/proposal reference, not necessarily an Ethereum transaction hash. Use a distinct typed result and never feed that result to confirmOwnerExecution/EOA receipt tracking. Start existing canonical event discovery from the persisted review block, then confirmOwnerExecution verifies the real outer transaction, exact contract/event/raffle/reviewHash/approver and generations, state, two confirmations and reorg safety. No false approval success on wallet acceptance or Safe proposal alone. Reload restores observation, never resubmission. Rejected/pre-dispatch requests can be safely retired only with proof; uncertain or accepted requests remain pending.
8. Existing Safe JSON/manual hash tools remain Advanced recovery only. Do not weaken stale-digest, wrong-owner, malformed log, rejected inner call, ownership/policy generation, revision, or canonical block checks. New one-button attestation must occur only on the explicit Approve click, never automatically when review data arrives.
9. List uses the displayed hash, then fresh preparation/submission. Any policy change rejects and requires the updated visible policy plus another explicit List click. No automatic listing after creation or owner approval.

## Design and ownership

Use the existing wallet, commitment, service, reader, outcome and disclosure modules. Add a bounded create coordinator and narrow created-ID resolver rather than duplicating low-level signing and journal logic in components. Keep new states as discriminated unions. One critical builder owns implementation and regression tests in an isolated worktree, including ports/types/service and affected UI. No dependency or schema changes expected; escalate an actual necessity to root before adding them. Existing manual V3 drafts must remain recoverable into the same Create/Approve/List sequence.

Root is the only integration/shared-release owner. Independent verification uses a separate worktree and owns only its new verification tests/evidence. Workers cannot spawn agents or agent subprocesses. Do not edit another worktree, rewrite git history, publish or submit on-chain actions. The production signature/receipt guarantees are required behavior, not optional polish.

## Required evidence

- One site click completes Create's signed durable preparation/create/approve/escrow with wallet fixtures, ordered canonical confirmations and exact token/created ID; skips only proven completed steps.
- Partial creation, reload, rejection at each stage, uncertain/hashless send, pending/replaced/reverted receipt, mismatched creation event/intent, storage failure, duplicate clicks and stale wallet/input/unmount.
- One Approve click sends exact Safe payload; returned safeTxHash is never queried as a receipt or labeled executed; proposal-only/multisig waiting, executed canonical discovery, reload, rejection, stale digest/session/owner/policy and altered target/value/data.
- One List click uses displayed policy; policy drift blocks submission and retry remains explicit.
- Existing transaction outcome/lineage/recovery, seller, buyer, owner/Safe race, admission and service-boundary regressions.
- Mobile-first browser checks at320/390/768/1440, keyboard access and no clipped primary controls. Test200% zoom and RTL mirror if tooling permits; distinguish unavailable native devices from simulated viewport evidence.
- Aggregate web tests, TypeScript, production build, contract regressions/fuzz via existing CI, fresh independent Astra final review and Claude source review. Retain failed attempts and bind final results to exact revisions.

Website main publication is already authorized after all gates pass. No contract deployment/funding/wallet signing/permission expansion is part of this implementation. Do not call live Safe prompts or the entire testnet lifecycle verified by headless fixtures alone.

## Builder evidence

Critical implementation candidates: 3520162, e73926a, and the follow-up commit containing this record. Root owns integration, independent verification/review and release; these checks are not approval.

The preparation-recovery addendum uses the existing `reserve-request:v3` mapping. The browser persists only the public request hash and draft calldata. Authenticated `/api/reserve/preparation` validates seller, deployment and NFT and returns `PublicReserve` only. Proven pre-provider and pre-POST failures carry service-owned classification; ambiguous sends retain recovery. Custody preparation and fresh submission bind the original full draft. Completed creations retain a public receipt pointer before retiring the matching active record.

Observed checks in `../artifacts/three-action-flow-20261010/builder/`:
- `forge-build.log`: PASS, fixture contracts compiled locally.
- `focused-second.log`: PASS, 30 service/coordinator, EIP-7702, wallet and authenticated-record tests.
- `safe-browser-third.log`: PASS, four headless Safe handoff/discovery tests, including responsive widths 320/390/768/1440.
- `seller-browser-first.log`: PASS, 11 headless seller/five-tier tests, including 320/390/768/1440, keyboard and 200% zoom fixtures.
- `types-final-stage.log`: PASS, TypeScript.
- `unit-aggregate-second.log`: PASS, ordinary aggregate with opt-in suites skipped as reported in the log.

Retained failures: initial chain tests ran before fixture compilation finished; first Safe browser run used obsolete selectors; second Safe browser run exposed unstable Advanced button bounds and a dependent follow-on timeout, repaired before the third run; first aggregate expected the removed download label and obsolete View link. No live wallet signing, deployment or release was performed. Native device and RTL evidence are not claimed.

## Approved wallet restoration addendum

The user reported that the seller wallet disconnects on every refresh. Root Astra approved a bounded R2 follow-up. The installed AppKit1.8.19 base client disconnects persisted WalletConnect sessions when reconnect is disabled; its Ethers adapter's syncConnection requests accounts when reconnect is enabled. Restoration therefore needs a read-only override, not a flag change alone.

Restore only a prior explicit connection matching a validated nonsecret marker scoped to origin, project, deployment and version. Require the exact SDK connector, account and Sepolia chain, plus an unexpired authorized WalletConnect namespace where applicable. Permit only account/chain reads and existing session inspection during restore. Never open a chooser or request accounts, switching, signatures or transactions. Disable fallback-first-connector restoration. Disconnect, cancellation and cross-tab marker changes retire delayed restoration. A failure leaves the app disconnected and does not destroy an unrelated wallet session. Existing users may connect once to establish the marker. Relevant acceptance checks include actual installed-SDK lifecycle behavior and callback races; root owns independent review and release.

Wallet restore implementation evidence: `restore-regressions-fourth.log` passes 61 focused tests. `restore-sdk-first.log` exercises the actual AppKit 1.8.19 constructor, initialization, controllers, existing-connection dispatcher, account synchronization and Ethers adapter; only network/DOM discovery, identity and balance lookup are fixtures. The provider traps all methods except `eth_accounts` and `eth_chainId`. Existing actual UniversalProvider cleanup/orchestration tests still pass. `restore-types-fourth.log` passes TypeScript. A prior concurrent typecheck collided with Next regenerating its type files; the failed log is retained.

Disconnect writes a per-generation sessionStorage revocation record before localStorage deletion, with local replacement as a fallback. This suppresses the old generation on same-tab reload when deletion fails. New explicit successful connection writes a new generation. If both stores refuse all mutation, the current session still disconnects and reports that the browser could not save the change; persistence is impossible under that condition. Disposal retires pending restoration and public restore becomes inert. Local fixtures now follow the same no-consent startup rule as production.

The first browser reload check exposed the old local fixture constructor attaching its injected provider before consent; that was repaired. `restore-browser-first.log` retains the failure. The second reload browser run is pending at this checkpoint. Run it with `RUN_WALLET_RESTORE_BROWSER=1 npm test -- --run test/wallet-restoration.browser.test.ts` in `web`. Independent verification, fresh review and release remain root-owned.
