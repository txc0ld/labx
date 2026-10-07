# Wallet and checkout review repairs

These changes address the final source and browser reviews of the version 3 candidate. They do not change contract policy or activate a deployed contract.

## Required behavior

- Refresh the same raffle in place. Preserve a valid selected pack, quantity and payment method after USDC approval. Pause transaction submission while an authoritative refresh is pending or has failed.
- Show the raffle, pack and quantity in the transaction review. Keep a confirmed purchase's hash and block visible after refreshing its state. A recovered transaction must also retain its confirmation.
- Bind asynchronous feedback to its wallet session, service, action and component lifetime. An obsolete response cannot publish feedback, overwrite saved owner intent or release a newer operation's lock.
- Treat only direct numeric wallet error codes `4001` and `5000` as definite user rejection. Clear only the matching unsent intent. Preserve recovery when a hash is known or the outcome is uncertain.
- Capture the wallet before fetching private workflow context. A wallet change must prevent the old request from prompting the replacement wallet to sign.
- Compare validated owner-execution hashes as bytes, regardless of hexadecimal letter case. Keep the matching event, owner, revision, policy, canonical block and two-confirmation checks.
- Limit NFT approval discovery without a stored intent to 20 pages of 24 raffle IDs. Filter by seller before assembling full snapshots. Existing journal recovery does not use this discovery limit.
- Retain an executed revocation's old intent only for receipt confirmation when the next revision and owner/policy identity match. Do not offer that old calldata for another execution.
- Describe retained owner receipts as historical observations. The current admission status remains authoritative after a draft changes.

## Fee disclosure

Each successful purchase call pays the greater of 2.50 USDC or 2% of its quantity-adjusted pack principal. The processing fee is nonrefundable. Cancellation refunds return pack principal only. The seller commission remains 2% of principal at settlement. Failed purchases retain no fee.

Checkout cards, transaction reviews, receipts and current deployment notices must reflect that policy. Archived version 2 terms remain unchanged.

## Verification

Use the repository's existing Vitest and Anvil fixtures. The repair tests cover rejection and uncertain-send handling, wallet changes during private signing, bounded recovery scans, owner review races, approval-to-purchase selection, and persistent confirmations. Browser tests are opt-in; a skipped test is not a passing browser check.

Release requires the integrated web and chain checks, TypeScript, a production build, rendered browser checks, independent verification, and source review by Astra and actual Claude. Evidence must identify its exact source revision. Deployed Safe/Chainlink execution, physical devices and production capacity require separate operational evidence.
