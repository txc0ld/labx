# Seller portal and percentage fees design preflight

Decision: PASS for implementation under the concrete contract below. This approves the bounded source design, not deployment, financial transactions, final code or release. Incorporate these refinements into the task contract before handing off implementation.

Reviewed candidate: b5b8a53b5a962967c44926f3b8e5c04a5c8a9906. The only dirty item observed was the untracked task contract at docs/build/seller-portal-fees-20261007.md. Assigned review routing is GPT-6 Astra High per the coordinator's task packet. Effective model and effort telemetry are unavailable to this agent, so routing is not independently verified. Token usage and cost are unknown. No child agents were spawned and no production files were edited.

Applied the invoked unslop and karpathy-guidelines skills, and the TypeScript best-practices/type-system-discipline skills while reviewing TypeScript.

## Required accounting contract

1. Add immutable protocol constants BUYER_FEE_BPS = 200 and SELLER_FEE_BPS = 200, both uint16, and FEE_DENOMINATOR = 10_000. Remove the fixed LAB_FEE from the v3 ABI and active code. No fee setter or constructor fee parameters are needed.
2. Append buyerFeeBps and sellerFeeBps, both uint16, to RafflePolicy after nativePayment. Populate them in _openingPolicy, so getRafflePolicy and openingPolicyHash bind both rates when the seller opens. A draft's unpinned policy remains zero; opening review must use openingPolicy's current constants. Do not infer a draft policy from a default 200-bps fallback in a quote for an open raffle.
3. Each purchase transaction computes principal = priceUsdc * qty, then buyer fee = floor(principal * pinned buyerFeeBps / 10_000). This explicitly rounds the entire selected quantity once per transaction. It does not round a single unit and multiply by quantity. Example in USDC base units: price 49, quantity 2 charges principal 98 plus fee 1, while two separate quantity-1 transactions collect total fee 0. This is the selected interpretation of the task contract's per-purchase rounding and must be stated in terms and tests.
4. Increment a single cumulative buyer-fee counter per raffle in _credit. Keep the existing principalOf, feeOf, principalEscrow and feeEscrow accounting. The new cumulative counter is never decremented by refunds or claims and is not itself an obligation.
5. Do not store a cumulative gross-principal counter. The current code permits pack changes only in Draft, purchases only in Open, and does not decrement sold. Therefore sum(priceUsdc * sold) across the at-most-eight packs exactly preserves lifetime gross sales after every permitted claim, cancellation and refund. No additional sold or paid counter is necessary.
6. Preserve RaffleView and getRaffle's existing tuple exactly. Add a separate struct RaffleAccounting { uint256 grossPrincipal; uint256 buyerFees; } and getRaffleAccounting(uint256 id) external view returns (RaffleAccounting memory). Derive grossPrincipal with the bounded pack loop and buyerFees from the cumulative counter. Return one struct, not two named scalar return values: viem's existing struct convention is an object, while multiple scalar outputs would be a positional tuple. Invalid ids can follow existing getRaffle's zero-value convention; the reader already rejects a zero seller.
7. At settle, after existing phase/reveal checks, compute seller commission = floor(r.principalEscrow * pinned sellerFeeBps / 10_000). Subtract it from principalEscrow and add it to feeEscrow in the same call, then leave the raffle terminally Settled. Current state transitions guarantee no refunds occurred on a raffle that can settle, so principalEscrow is gross principal at that point. Repeat settlement is rejected by the existing phase check. Keep independent pull claims and no external call in settlement.
8. Retain the existing Settled event signature; its principal and fee values are the resulting seller net escrow and combined treasury fee escrow. Describe that v3 meaning in source documentation and tests. PackPurchased and Refunded event signatures need not change. A separate commission event is unnecessary because the pinned policy and persistent gross figure reconstruct it exactly.

The source currently sets Settled without fee movement at LabxRaffle.sol:640, clears principal and fee escrows in claims at 659/670, and subtracts buyer balances on refunds at 723. Those are the exact mutation points to cover. Deriving lifetime revenue from either live escrow is incorrect. Deriving cumulative buyer fees from gross principal is also incorrect because purchase-level floors do not distribute over a sum.

## Exact shared TypeScript interface

The critical implementation owner owns and publishes these interfaces before the isolated portal slice is integrated:

```ts
// types.ts, derived from the generated v3 ABI
export type RaffleAccounting = ContractFunctionReturnType<
  typeof raffleAbi, "view", "getRaffleAccounting"
>;

// Added to the existing RaffleSnapshot; remove labFee.
accounting: RaffleAccounting;

// fees.ts, arguments use raw integer USDC units and uint16-derived numbers
export function buyerFee(principal: bigint, buyerFeeBps: number): bigint;
export function sellerAccounting(snapshot: RaffleSnapshot): {
  grossPrincipal: bigint;
  buyerFees: bigint;
  sellerCommission: bigint;
  netProceeds: bigint;
  claimableProceeds: bigint;
  paidProceeds: bigint;
  escrowHeld: bigint;
  pendingPrincipal: bigint;
  refundLiability: bigint;
  refundedPrincipal: bigint;
  refundedBuyerFees: bigint;
};
```

No new RaffleService methods are needed for fee accounting itself. The coordinated portal reader extension below adds discovery and activity methods. readRaffle reads getRaffleAccounting at the same pinned block as getRaffle, packs and policy; listRaffles consequently returns complete per-raffle accounting. RafflePolicy remains ABI-derived, with uint16 rates represented as numbers. openingPolicy includes both constants in its returned policy. RaffleSnapshot.accounting is required, not optional or zero-filled on failed reads. Update all fixture factories under the fee owner's ownership.

All quoters, approval preparation and buyer cards use the same buyerFee helper. buyerFee must use bigint arithmetic; an active quote must receive a verified pinned rate. MembershipQuote's existing principal/fee/totalUsdc shape can remain. Update the bounded approval recovery check in service.ts: its current 20_000_100_000_000 ceiling only covers the old 5-USDC economics. A max-price quantity-20 purchase now totals 20_400_000_000_000 units. Derive or consistently update that bound and test recovery at the maximum.

For the helper, let G = accounting.grossPrincipal, B = accounting.buyerFees, P = raffle.principalEscrow and F = raffle.feeEscrow. Exact semantics:

| Field | Meaning/formula |
| --- | --- |
| grossPrincipal | G, cumulative pack principal purchased, including sales later refunded |
| buyerFees | B, cumulative buyer fees paid, including fees later refunded |
| sellerCommission | Settled only: floor(G * policy.sellerFeeBps / 10_000); otherwise 0 |
| netProceeds | Settled only: G - sellerCommission; otherwise 0 |
| claimableProceeds | Settled only: P; otherwise 0 |
| paidProceeds | Settled only: netProceeds - P; otherwise 0 |
| escrowHeld | P + F in every phase; current funds owed by this raffle |
| pendingPrincipal | Open/Closed/Drawing/Drawn only: P; otherwise 0 |
| refundLiability | Cancelled only: P + F; otherwise 0 |
| refundedPrincipal | Cancelled only: G - P; otherwise 0 |
| refundedBuyerFees | Cancelled only: B - F; otherwise 0 |

Only settled netProceeds may be labelled lifetime seller revenue. Label grossPrincipal as gross pack sales and explicitly disclose that it includes cancelled sales. Pending principal is not earned revenue and buyer fees are not seller revenue. Escrow held is the broader current obligation, while refundLiability is the amount currently claimable by cancelled-raffle buyers. No metric should use principalOf/feeOf as a global liability after settlement, because those per-wallet mappings intentionally remain populated when refunds are no longer possible.

Aggregate seller totals only after scanning every catalog page at one BlockRef. Until nextCursor is null, show loading/scanning or explicitly partial totals, never a completed total or definitive empty state. A scan error must preserve an error/incomplete state. A reorg, account change, chain change, disconnect or a new query must invalidate the old scan. The existing SellerDashboard can show an empty state after the first page despite later seller raffles; replace that behavior. Keep large values as bigint through formatting, not Number.

## Ownership boundaries

- Critical contract and fee-service owner: contracts/src/LabxRaffle.sol; necessary contract tests and deploy fixtures; generated web/lib/chain/abi.ts and web/lib/LabxRaffle.abi.json; web/lib/chain/types.ts, reader.ts, actions.ts, deployment.ts, browser.ts, server.ts; new web/lib/chain/fees.ts; published-terms and its exact v2 archive; terms-related record verification if needed; fee/service/ABI test fixture updates. This owner is explicitly responsible for the R3 logic, its tests and repairs. Assign the configured critical_builder role rather than an ordinary feature worker. It supplies MAX_MEMBERSHIP_TOTAL_USDC from fees.ts, equal to 20_400_000_000_000n under this version, for the portal owner's service.ts bound replacement.
- Portal owner: seller dashboard/detail/draft components, seller and studio routes, RaffleWorkspace presentation/mode isolation, buyer-facing fee copy and displays in workflow components, navigation, product legal copy rendering, portal styles and portal-specific tests. It also owns ports.ts, service.ts wiring, new seller-reader.ts and seller-types.ts as specified below. It consumes the shared interfaces above and does not edit existing chain types.ts, reader.ts, actions.ts, ABI or financial formulas. Existing transaction service remains authoritative. In service.ts, replace the old recovery approval ceiling with the critical owner's MAX_MEMBERSHIP_TOTAL_USDC import; do not independently invent a second fee formula.
- Root integration owner: shared docs, release/checkpoint records, lockfiles if unexpectedly needed, deployment artifacts and migration instructions. Resolve overlap before edits. Keep independent writers in separate worktrees and isolate test ports/local chains as needed.
- Independent verifier: behavioral tests/evidence, especially exact fee arithmetic and role isolation. It does not repair production logic. Fresh independent Astra High final reviewer inspects the integrated candidate and affected code, rather than relying on this preflight or builder reports.

The portal's seller-only mode must gate direct routes by the live account's equality with raffle.seller before rendering seller workspace content or preparing actions. Permitted seller-facing kinds are updateDraft, approvePrize, escrow, open, close, snapshot, requestRandomness, reveal, settle, claimProceeds, cancel, abortDrawing and reclaimPrize, subject to existing availability checks. createDraft remains in the seller draft flow. Exclude approveUsdc, buyMembership, claimPrize and claimFee from seller management. Refund is a buyer-owned action even when the seller bought a pack; route it through the existing buyer/account flow instead of presenting other buyers' refund balances or a fictitious seller refund action. The seller can enable refunds via cancel/abortDrawing where the contract permits it.

Reuse availableActions plus an explicit seller presentation filter. Do not change the underlying permissionless close/snapshot/draw/recovery/settlement rules. Opening still binds expectedPolicyHash, and prepared actions still pass simulation, a visible review and wallet/account revalidation. Ownership filtering is presentation and workflow isolation, not privacy for public chain data.

### Coordinated seller reader addition

The portal owner implements createSellerReader(client, manifest, reader) in seller-reader.ts and exposes its methods through RaffleService in ports.ts and service.ts. Its reader dependency uses existing readRaffle, listRaffles and checkedBlock; raw PublicClient access stays inside this factory, never inside UI components. New types live in seller-types.ts. This assignment supersedes any earlier proposal to let the fee owner edit service.ts.

```ts
listSellerRaffles(input: {
  seller: Address; cursor?: bigint; limit?: number; block?: BlockRef;
}): Promise<Page<RaffleSnapshot>>;

listRaffleActivity(input: {
  id: bigint; cursor?: bigint; block?: BlockRef;
}): Promise<Page<SellerRaffleActivity>>;
```

listSellerRaffles scans one bounded page of general raffle IDs via reader.listRaffles, filters by case-insensitive seller equality, and returns the original nextCursor/block. limit bounds scanned IDs, not matching sellers. An empty page with a non-null cursor means discovery is incomplete. The dashboard consumes all pages at one pinned block to establish totals; it may progressively render already discovered raffles while marking the scan incomplete. No network-side seller assertion is an authorization boundary.

listRaffleActivity reads and validates the requested raffle at the pinned block, scans at most 2,000 blocks starting at cursor or manifest.deploymentBlock, and returns a block-number nextCursor. Reject invalid/out-of-range cursors; retain a bounded event-count guard such as the existing 5,000-log threshold, and report failure instead of a partial page. Query this contract, strictly decode known financial events, and keep only args.id equal to the selected raffle. Include PackPurchased from every buyer, ProceedsClaimed, FeeClaimed and Refunded. Define SellerRaffleActivity as a discriminated union by these event names with ABI-derived args, plus transactionHash, logIndex and blockNumber. Refunded.args.amount is a combined refund, not gross principal; do not fabricate a fee split in its activity label. Ignore unrelated recognized events; malformed relevant data fails the page. Never reuse history(account=seller) to infer sales because that method filters PackPurchased to purchases by the seller.

Activity is optional supporting detail and must retain its own pagination/completeness state. Revenue and liability totals continue to use pinned accounting snapshots, never an incomplete event feed. All returned chain data remains public. Add independent service tests for seller matches beyond the first scanned page, buyer-originated purchase events, unrelated raffle isolation, cursor boundaries and reorg rejection.

## Version and terms transition

Set contractVersion to 3; DeploymentManifest.version must be literal 3 and attestation must compare on-chain version to 3n. New runtime hash is mandatory. Both local manifest parsers must validate the supplied version instead of silently rewriting an arbitrary input as the current version. Preserve the existing chain, code hash, USDC and mainnet gates. Keep APPROVED_DEPLOYMENTS empty. Do not insert the existing live v2 0xef27306567a5ADA354fe9403008D041d0b468213 or historical v1 address as a v3 deployment, and do not issue any deployment/ownership/VRF transaction in this task.

Publish a new terms id such as labx-membership-2026-10-07-v3 and a new content hash. Describe the 2% buyer charge on transaction principal, floor rounding to a USDC base unit, the separate 2% seller commission on total principal once at settlement, full cancellation refund of actual buyer principal/fee, and the absence of seller commission on cancellation. State that this describes prepared v3 contracts; the live v2 contract still has its fixed fee. The new terms hash must populate all local deployment fixtures and later reviewed deployment instructions.

Preserve the exact previous terms JSON bytes/hash/version in a historical registry or archive and expose read-only lookup/display by known hash. Do not rewrite historical 5-USDC statements to describe 2%. Keep requirePublishedTerms strict for current financial writes. Historical display/record verification may resolve an archived known hash separately; unknown hashes fail closed.

Do not mechanically change every v2 suffix. agree:v2, receipt:v2, stored record.version = 2 and authorizationMessage's v2 are storage/signature protocol versions, not the raffle contract version. workflowMessage already says v3 today. Keeping these protocols unchanged is the bounded compatible choice. Old signatures must verify against their original origin/chain/contract/terms context. Private record keys include contract and terms identity, so a new deployment must not claim that old records migrated automatically. If a historical signed-record read is supported, retain wallet authorization and use a trusted historical context; never accept a caller's arbitrary contract/terms selection as authorization. Archive rendering does not require enabling historical financial writes.

## Required acceptance evidence

1. Contract arithmetic examples and fuzzing across price/quantity, including quantities 1 and 20, prices 1/49/50/51 base units and maximum price, and purchase splits that distinguish floor-per-transaction from aggregate rounding. Verify USDC and ETH routes credit and refund identical totals.
2. Settlement tests with multiple packs, transactions and buyers where sum(purchase buyer fees) differs from floor(total gross * 2%). Seller commission uses total gross once. Check all available prize/proceeds/treasury claim orders, payout failure isolation, second settlement and duplicate claims, and treasury pinning after admin defaults change.
3. Full and partial refund tests across buyers, timed cancel and abortDrawing; buyerFees and grossPrincipal remain lifetime totals, no seller commission accrues, refundable escrows reach zero. Verify lifetime net proceeds remain unchanged after seller payment. Verify two-raffle solvency with interleaved claim/refund activity and unsolicited transfers treated as surplus.
4. ABI regenerated from the actual compiled contract, one-struct accounting decode and policy fee field/hash coverage; readRaffle pins accounting to the same block. Attestation rejects version-2 bytecode/manifests and mismatched v3 runtime/token/network. Unknown or historical terms cannot approve or buy v3. Historical terms preserve exact old hash/content/signature reconstruction. Test current max-value approval recovery.
5. Portal behavior for disconnected/wrong-chain/unapproved/RPC-error/loading/empty/multiple raffles; seller found only after page one; all-page totals; mid-scan failure and reorg; wallet switch and delayed old-account responses; direct URL for another seller including operator/winner accounts. No buyer or treasury transaction control appears in seller mode. Wallet review and confirmation remain available for each seller lifecycle stage. Browser verification at desktop/mobile includes keyboard access and reduced-motion behavior with actual rendered pages.
6. Existing aggregate CI gates: forge build --sizes, forge test, web npm test and npm run build. Add explicit TypeScript checking, since it is required by the task contract. Bind all final evidence and fresh Astra High review to the exact integrated revision. Do not claim local fixtures or passing tests establish public availability or on-chain activation.

## Evidence limits

This was a source-only preflight. Tests/build/browser QA are NOT_RUN by this reviewer and are mandatory for implementation acceptance. Source reads covered the contract, lifecycle/action service, current ABI-derived types, deployment readers/parsers, policy/terms, signed agreement/private-record code, seller dashboard, package scripts and CI. Git HEAD/status reads succeeded; the combined final inspection command exited 1 because no repository-root AGENTS.md exists, after printing the expected HEAD/status. Applicable user-provided instructions were supplied in the task context. Some exploratory rg invocations reported absent scripts/test directory spellings; subsequent reads used the actual web/test and tools paths. No production or external state changed.
