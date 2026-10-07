# Seller portal and percentage fees

## Request and authority

User requested a high-quality seller dashboard with access to the seller's own raffle management and revenue, and confirmed: 2% added to each membership purchase, 2% deducted from the seller's pack-sale principal at settlement, buyer purchase fees refunded on cancellation/refund. Preserve LABx branding and existing buyer protections. Build and prepare the portal for deployment. The newly deployed v2 Sepolia contract cannot be changed in place. No new on-chain transaction or mainnet activation is authorized by this task; prepare the reviewed migration separately. User signs any subsequent approved deployment.

Base is b5b8a53b5a962967c44926f3b8e5c04a5c8a9906, remote main and production READY at that commit. No open PRs and current CI passes. Existing checkout clean. New isolated integration branch work/seller-portal-fees-20261007. Live v2 raffle 0xef27306567a5ADA354fe9403008D041d0b468213 is configured with Safe owner/treasury, native VRF and consumer registration; deployment evidence remains in the parent task artifacts. Its fixed 5-USDC policy must never be represented as 2%.

## Risk and design contract

Portal is R2 for seller identity and action isolation. Fee accounting and ABI/version transition are R3. Root coordinates; independent Astra High design preflight is required before implementation. The current host reports Astra Medium for root; consequential design/review will be explicitly assigned to Astra High, with effective routing evidence where exposed. No claim of inaccessible routing telemetry.

Fee invariants, proposed for preflight:

- Immutable buyer and seller rates:200 basis points each. Basis denominator10,000. Integer USDC6-decimal arithmetic only; round each purchase's buyer fee down to the nearest USDC base unit, and the seller fee once on total membership principal at settlement. State rounding explicitly in product terms.
- A purchase transfers principal plus buyer fee and credits exactly those refundable balances. The optional ETH route buys the identical USDC total.
- Cancellation before settlement returns all paid principal and buyer fee; no seller commission accrues or becomes claimable.
- Settlement moves exactly the seller fee from principal escrow to the pinned treasury fee escrow once. Seller receives net principal; treasury receives buyer fees plus seller commission. Sum of outstanding obligations equals held funds, subject to unsolicited transfers. No double collection, re-settlement or fee-dependent claim ordering.
- Preserve separate pull claims, checks/effects/interactions, reentrancy protection, immutable raffle policy and all existing timed recovery/fairness rules. No new privileged fee setter.
- Version the ABI/terms/deployment attestation for the new economics. Reject mismatched/old deployments for new writes; never silently treat v2 as percentage-fee v3. Keep public deployment registry empty pending review and activation. Preserve access to historical signed record content where needed.
- Revenue metrics must be reproducible from current pinned chain data and/or fully paginated events. Distinguish gross sales, buyer fees, seller commission, net proceeds, claimable escrow, paid proceeds and refundable liabilities. No claimed revenue reset after payout, no cancelled funds labelled earned revenue, no partial pagination presented as totals.

Portal invariants:

- Extend existing Studio workflow, preferably canonical /studio and seller detail route, instead of a second disconnected transaction system. Filter discovered raffles by current wallet seller address, with direct-route identity checks and stale-account invalidation. Public chain data is not private; dashboard filtering is not a secrecy guarantee.
- Only render seller-relevant actions in seller management. Exclude buyer purchase/winner-claim/operator configuration from that portal. Reuse the existing chain service for real simulation, wallet review, confirmation, recovery and contract-enforced authorization. No new API trusting a caller-supplied seller address.
- Preserve draft, NFT approval/escrow, draft edits, opening, closing, snapshot, draw, commitment reveal, settlement, proceeds claim and allowed refund/NFT recovery. No new policy bypass or automatic signature.
- Disconnected, wrong network, unapproved deployment, unavailable RPC, loading, zero raffles, multiple raffles, wrong seller and stale asynchronous requests must have clear accurate states. Do not invent data or silently show zero on failure.
- Keep supplied logo/artwork/fonts, black/white chrome, dot/noise background, solid pillow buttons and no purple menu selection. Use existing components/dependencies. Responsive dashboard hierarchy, restrained motion, reduced-motion behavior and keyboard/touch access.

## Verification and release boundary

Required: fee arithmetic/refund/claim-order regressions and fuzz; contract aggregate suite; typed ABI/terms/service quote consistency; independent role/access and financial tests; web tests/typecheck/build; browser QA of seller states at desktop/mobile and wallet switching using local fixtures clearly confined to tests. Independent Astra High final review against exact integrated revision. No tests fabricated or aggregated across revisions.

Website deployment can only claim the portal actually available at the verified URL. Live seller transactions require approved new contract activation and a completed Sepolia lifecycle rehearsal; the new source does not modify deployed v2. Final report must separate source, preview/production availability and on-chain activation. Do not skip a mandatory gate to call this complete.

## Work ownership

Independent Astra High preflight PASS is recorded in seller-portal-fees-preflight-20261007.md. Its exact accounting, interface, terms and ownership contract supersedes the provisional details above. The existing canonical Studio is /seller; preserve that route and add seller-specific detail routes. Critical owner works in ../labx-percentage-fees; portal Sol High owner works in ../labx-seller-dashboard. Root owns this integration worktree, shared lockfiles and publication. Independent agents own only verification evidence/tests and review reports. Preserve concurrent work; no reset or force push.

The user also explicitly requested emilkowalski/skills. Installed all14 project-local Codex skills using observed latest skills CLI1.7.1, verified all22 skill/resource files byte-for-byte against inspected upstream commit e8a175de22ae1e49370fc144c1f3bb9aeedf988d. Preserve MIT license. Portal implementation applies emil-design-eng, animate and mobile-native; final motion review applies review-animations. No unrelated global skills/catalog were overwritten. The parent runtime subsequently reports Astra Ultra; final High review remains separately routed.

## Evidence

Initial baseline: git fetch origin exit0; main=b5b8a53; no open PRs; CI37579058062 and37578742190 success; Vercel production dpl_2kT4zfvbzSWWgSgPGrpPHTTC7v7L READY. Token/cost telemetry unavailable.
