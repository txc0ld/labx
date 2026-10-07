# LABx security

This describes the local version 2 source. It is not a claim about the historical Sepolia deployment, a formal audit or a zero-risk guarantee. See `LAUNCH.md` for release prerequisites and `docs/build/full-workflow-20261006.md` for candidate-specific evidence.

## Assets and authority

The contract holds one escrowed ERC-721 prize per raffle and the USDC membership principal plus a 5 USDC lab fee per pack. Chainlink holds the VRF subscription balance. Server records include private commitments, signed agreements and receipt requests.

| Role | Authority |
| --- | --- |
| Owner | Pause new sales; update defaults for future openings; propose a coordinator with a one-day delay; manage the immutable optional ETH path's enabled state; reveal alongside the seller. |
| Seller | Create and edit a Draft, escrow, open, reveal, claim proceeds and reclaim a cancelled prize. NFT identity cannot change while escrowed. |
| Buyer | Purchase memberships, claim their own refund after cancellation, and claim the NFT if they are the settled winner. |
| Public caller | Close at the published deadline, build the snapshot in bounded batches, start the single draw after its completed nonempty snapshot, settle after reveal or seven days, invoke eligible timed recovery, and transfer the fee only to the pinned treasury. |

A deployed Safe is intended for ownership and treasury. The deploy script checks code presence, but code does not prove Safe implementation, owners, threshold or intended authority. Ownership acceptance and those properties require separate verification. The contract itself does not enforce that every future owner is a Safe.

## Draw integrity and recovery

- Opening fixes the NFT, pack economics, sales deadline, terms, treasury and VRF configuration for that raffle. The website uses `openWithPolicy` to reject an opening if the reviewed policy changed. Later admin default changes cannot rewrite an open raffle's policy.
- Closing cannot happen early. Once entries exist, discretionary cancellation is unavailable. A completed empty snapshot and the fixed timeout paths remain recoverable.
- Snapshot batches contain at most 300 lots and omit expired entries. The website uses 100-lot batches. Anyone may request the single draw after a completed nonempty snapshot in Closed. The request must start strictly before `salesEnd + 7 days`. At or after that deadline, anyone can cancel an Open or Closed raffle, including one with an incomplete snapshot.
- The pinned coordinator's result must arrive strictly before `vrfRequestedAt + 7 days`. Late results are ignored even if nobody has aborted yet. At or after the cutoff, anyone can abort and enable refunds. A retry cannot reroll or extend the deadline; the retained selector always reverts.
- Coordinator/request identity is namespaced and used request IDs cannot be reused. A timely result selects from the frozen cumulative entry weights.
- Anyone can settle after a valid reveal, or after the seven-day reveal grace without one. Prize, principal and fees are separate claims to the winner, seller and pinned treasury. Cancellation leaves buyers to claim their own principal and lab fee, and the seller to reclaim the NFT.
- Pausing cannot block closing, snapshotting, drawing, settlement, claims or timed recovery for existing raffles.

The commitment binds chain, contract, nonce, token identity, public/private hashes and salt. Revealing proves these hashes; it does not enforce a numeric seller reserve. Private plaintext is never submitted on-chain.

## Trusted dependencies and limits

The pinned coordinator, USDC, prize token, RPC, optional router/oracle and server remain dependencies. A malicious coordinator is not made trustworthy by pinning its address. An ERC-721 that refuses transfers can trap its own prize, although the independent USDC claims remain available. An operator or network failure can prevent an award and require refunds. Fixed expiry rejects even valid late randomness. Transaction inclusion, gas costs, censorship, private-key compromise and software defects prevent any honest zero-risk claim.

The ETH route is off unless router, WETH and the feed are wired at deployment. Their addresses and pool fee are immutable. It checks oracle freshness, slippage and a short transaction deadline, swaps into USDC and refunds change. Refunds after cancellation are denominated in USDC, including for purchases funded with ETH. Keep this route disabled until its actual liquidity and dependencies are verified.

Mainnet is rejected by the contract constructor. The deployment script accepts Sepolia only. No approved production deployment manifest is currently supplied. Local Anvil overrides require development mode and loopback configuration.

## Website and server

- A configured address alone does not authorize writes. The approved manifest must match chain, address, runtime hash, contract version, deployment block and USDC. Two UI confirmations do not establish finality; receipt issuance requires a finalized purchase.
- User review precedes every wallet transaction. Exact USDC approval is separate from purchase. Accounts, chain, state and amounts are revalidated. A deployment/account-scoped browser journal retains opaque transaction intent and public hash/nonce metadata for explicit recovery after reload. It does not store private commitment payloads or signatures. Storage/lock failure prevents a new send. Clearing browser data, using another device or submitting outside this website remains outside that guard.
- Commitment creation/recovery, agreements, receipts and private records require fresh scoped wallet signatures. Authorization binds origin, chain, deployment and relevant identity. Never place private plaintext, salt, recovered commitment payloads or signatures in browser storage, logs or analytics.
- Agreement text and version determine `PUBLISHED_TERMS_HASH`. A mismatched raffle cannot silently substitute different terms. A wallet signature proves an assertion, not age, personhood or legal enforceability. Contract-wallet signature verification is not implemented.
- Receipts verify the finalized purchase log, buyer and amounts. The recipient and email payload are immutable after reservation. Idempotent mail retries are bounded; expired or uncertain jobs require reconciliation. This does not prove ownership of an email address.
- Vercel requires both Upstash settings. Durable write failures fail closed. The local file store serializes one process and is not a multiprocess database. Receipt delivery additionally requires Resend configuration.
- AMOE and CAPTCHA entry routes are disabled. The legacy contract entry selector reverts. Historical check-in points confer no entries or privilege; its server token is never public.
- Metadata reads are bounded browser requests without credentials, referrers or redirects. The server does not fetch arbitrary metadata URLs. Unknown or failed metadata is not replaced with a fabricated listing.

Prior Slither results were triaged under documented trust assumptions; they are not a clean-scan claim or a comprehensive audit of the final application. See the exact revision's independent review and test artifacts.

## Checks

```sh
forge test --root contracts
RUN_CHAIN_INTEGRATION=1 npm --prefix web test
npm --prefix web run build
```

Contract regressions, fuzzing, isolated Anvil flows, browser journeys and independent source review have distinct scopes. Passing one does not prove the others or live readiness.
