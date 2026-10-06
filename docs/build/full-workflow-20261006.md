# Full seller and buyer website workflow

## Current scope and authorization

R3. The user requests complete seller and buyer journeys directly through the website, an easy guided portal, and protection against raffle manipulation. This extends the earlier screens-only scope. The current source base is `66fcd02d977a493a41644d19b5c31f68256ae4ac` on `design/artwork-first-20261006`. Site polish and the simplified footer remain a separate verification milestone.

Authorized: local implementation, contract changes within the stated policy, isolated test-chain execution, regression/fuzz tests, browser QA and independent review. No main merge, push, hosted deployment, real wallet signature/transaction, funding, ownership transfer or identity-provider contract acceptance. User wallets must approve their own real signatures and transactions through a secure wallet flow. No zero-risk, formal-audit or launch-readiness claim.

## Buyer-protective policy and seller flexibility

The user wants seller flexibility without harming buyers. Sellers can edit draft title, packs, prices, supply and closing time before Open. NFT identity cannot change while escrowed. Once Open, prize, economics and deadline are fixed. No seller or operator early closing, reroll or winner selection. Discretionary cancellation requires no entry lots; retain empty-snapshot recovery and the approved seven-day draw-start and randomness deadlines, plus settlement after the existing seven-day reveal grace.

Opening a raffle pins its full VRF configuration, terms and treasury recipient. Delayed coordinator changes apply to future openings only. Request tracking must distinguish identical request IDs from different coordinators. Global operator pause stops new admissions/opening, never closing, snapshotting, requesting a draw, revealing, settling, claims or timed recovery. No new seller power to pause or alter an open raffle. The remaining global admission pause is disclosed operator discretion. Configured multisig identity/owners/threshold need operational verification; a contract address alone does not prove a Safe.

User correction supersedes the earlier personhood discussion: there are NO free entries. Customers buy memberships that include bonus raffle entries. Membership is the product; bonus entries are an included benefit. Do not label the purchase as buying entries or tickets. Remove complimentary-entry/AMOE issuance, CAPTCHA entry gates and personhood onboarding from the new source and UI. Retire old API paths with explicit unavailable responses so they cannot issue signatures. New contract version must reject the old free-entry selector, including already-signed vouchers. Remove stale free-entry copy and points-to-entry promises; preserve unrelated records where needed. Use membership-first labels in checkout, receipts, history and guides. Do not silently keep a signer or browser-only gate that could still issue entries. Existing deployed bytecode cannot be changed by this work and must be identified as legacy. No identity-provider selection, integration or identity collection is required.

## Required journeys

Seller: connect the intended wallet/network; validate NFT ownership; prepare title/deadline/custom pack configurations; save a commitment durably and provide recovery; review exact economics and rules; create Draft; edit Draft; approve one NFT; escrow and verify custody; open; inspect real entries; close at deadline; snapshot in resumable batches; request randomness; follow its deadline; recover and reveal commitment hashes; settle; claim proceeds. Cancellation/recovery must lead to buyer refunds and seller NFT reclaim. Explain that current commitment proves hashes, not a monetary reserve threshold.

Buyer: browse authoritative listings and direct detail URLs; inspect real supply/prices/fees/deadline and protections; connect; read and explicitly agree to the applicable versioned rules; review quantity and amount; approve exact USDC; purchase; wait for confirmed receipt; see real entries/history/receipt status; follow draw/settlement; claim prize if winner; trigger permissionless recovery when eligible and claim principal plus lab fee when cancelled. There is no free-entry onboarding. ETH payment needs explicit enabled-state, live quote, slippage/deadline and change handling, otherwise show its precise unavailability. Partner codes stay visibly invalid `XXXX` until supplied; no invented membership entitlements.

Portal UX: one primary next action, concise status, optional explanation, exact amounts and recipients before confirmation, clear pending/rejected/reverted/replaced/confirmed states and recovery after reload. Profile/history/receipt/guide/fairness navigation must connect these journeys. Keep existing brand, fonts, artwork, tiers, noise, spacing and simple footer. No duplicate page kickers or walls of text.

## Financial and trust invariants

- Identity binds chain 11155111, approved deployment runtime bytecode/version, bigint raffle ID and current wallet. Unknown or historical bytecode never acquires current-source policy claims or write access by address presence alone.
- Read contract state at an explicit block; missing/RPC-error is different from an empty catalog or zero entitlement. Bound pagination and metadata reads. No executable metadata or server-side arbitrary URL fetching.
- Use integer atomic units and validated input. Custom pack names/max8 and contract quantity limits must not inherit fixture-only assumptions.
- Subscribe to wallet accounts/chain/disconnect changes; invalidate stale asynchronous results. Revalidate identity, phase, deadline, amount and payee before simulating and immediately before requesting a user signature.
- Approvals and purchases are separate explicit actions. No unlimited allowance, automatic signing, agent-custodied keys or success on hash alone. Pending actions cannot duplicate accidentally. Confirm receipts and reread actual state.
- Prize only to winner; proceeds only to seller; fee only to pinned treasury; refunds only to paying wallet. Show that anyone may trigger a fee transfer to treasury, not collect it themselves.
- Any entry prevents discretionary cancellation. Callback acceptance and refund eligibility never overlap. Pausing cannot trap recovery or existing claims.
- Commitment, agreement and receipt writes must acknowledge durable success. Authorization remains scoped and versioned. Legal document/version association must be checked before requesting acceptance, not inferred from an arbitrary on-chain hash.
- Only a confirmed permitted membership purchase credits its configured bonus entries. No complimentary-entry endpoint/selector, local state, browser storage, CAPTCHA, identity claim or LLM output grants entries or privileged actions.

## Ownership and sequence

Astra High critical owner owns contract design/implementation and typed financial/chain modules. Sol may own UI composition after interfaces are fixed, in a separate worktree. One writer per worktree; root owns integration, shared manifests/lockfiles and final evidence. Independent verification uses real isolated Anvil flows plus adversarial wallet/provider simulations. A fresh Astra High reviewer must inspect exact integrated code and evidence. No worker self-approval.

1. Contract buyer-protection slice, regressions/fuzz and size check; preserve no-live-deploy boundary.
2. Typed deployment/read/transaction/session services and authenticated backend integration.
3. Complete portal/forms/routes/guide and explicit failure/recovery UX.
4. Integrated local-chain/browser verification, repairs and independent final review.
5. Prepare exact reviewable diff and deployment/configuration checklist. Operational execution requires separate user action/approval.

## Fresh operational evidence

Read-only Sepolia check at block 11856552, 2026-10-06T14:46:43Z, recorded in `artifacts/full-workflow-20261006/sepolia-readonly.json`: historical address has nextId=1, so no created raffles. Owner, pending owner and treasury have no deployed code. VRF subscription has 0 LINK, 0.05 native ETH and zero requests. `VRF_ABORT_AFTER` is 86400 seconds, `DRAW_START_GRACE` and `nativePayment` reads fail. Existing bytecode has not acquired local hardening. Runtime code hash is `0x1779eba7b981194cf65c900bb8a527672d40f1c7088d1e291bedd1bce22a379d`. This is read evidence, not approval to use this deployment for new transactions.

## Mandatory evidence

Foundry regression/fuzz tests for frozen policy, coordinator namespace collisions, per-raffle payees, all timeout boundaries, pause/recovery, transfer accounting and replay. Anvil seller-to-buyer prize path and cancelled-to-refund/reclaim path through website transaction services. Wallet rejection, chain/account drift, unknown bytecode, RPC outage, reverted/replaced/pending receipt, duplicate click and reload. Existing web tests/build and responsive browser journeys including keyboard/reduced motion. Record unrun live wallet/device checks honestly. Current orchestration/provider token and cost telemetry unavailable, recorded as unknown.

Status: design preflight complete; implementation not started. Site-polish final browser verification/review still pending. New deployment identity, Safe verification, funding and release remain operational prerequisites.
