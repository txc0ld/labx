# Bounded read cost and dependency failure handling

Candidate base: a8832a6. User requested support for high user counts, accurate seller accounting, and defensive fixes. This is an R2 read/persistence change; no contract, fee, transaction payload, deployment approval or authority changes are included.

## Required invariants

- A returned snapshot/page must match its pinned block hash before and after all dependent reads. Reorg or network mismatch fails closed. No cache may suppress these checks.
- Cache only the six public deployment-wide values used by raffle snapshots, and only within one `listRaffles` invocation at its exact pinned block. Do not add a persistent cross-request cache or change deployment attestation.
- Catalog page size remains at most 24. Share the page's public global reads rather than repeating them for every raffle. The public `readRaffle` API remains unchanged and performs its own complete checks.
- Artwork needs the recorded NFT/token/title, not pack, accounting and policy reads. `readArtwork` may read that raffle tuple at a checked block, verify existence, fetch tokenURI at the same block, and revalidate before accepting metadata. Existing URL, byte, timeout and fallback behavior remains.
- Seller discovery may first read only each candidate raffle tuple and fetch complete snapshots only for matching sellers. Preserve contiguous global-ID cursor semantics, 24-ID maximum pages, pinned block checks, definitive empty only after all pages, and full exact totals. Do not introduce an indexer or trust an unverified event-derived balance.
- Seller activity RPC should filter the requested indexed raffle ID and the four allowed financial-event signatures before transport. Keep strict decoding and the 2,000-block / 5,000-log bounds, hash revalidation and exact cursor. Do not replace the provider's error with a complete/empty result.
- Give Redis GET, SET and MSETNX a finite five-second deadline including response parsing. Abort/error must never claim a successful write. Preserve immutable records and atomic retry behavior; a timeout may mean the remote write committed, so retries use existing idempotent keys.
- The legacy bot request must use the existing 65,536-byte streamed parser with string field validation. Preserve token/signature authorization. This closes a body-limit inconsistency; no production denial-of-service exploit has been established.

## Evidence required

Deterministic tests count global calls for multi-raffle pages, ensure another seller's raffle does not trigger pack/accounting reads, and prove no cache crosses invocations/blocks. Reorg and failure tests must still pass. A local activity test includes unrelated raffle events and verifies topic scope. Store tests simulate delayed headers and delayed bodies, cancellation, rejected writes and safe retry after ambiguous timeout. Bot tests use a 65,537-byte stream and malformed field types, with no real secrets or external calls. Compare bounded local RPC call counts before/after; do not turn them into a production concurrent-user capacity claim.

Independent verification and fresh Astra review are required. Production capacity still depends on RPC/Redis/Vercel quotas and measured staging load. Keep that operational limitation explicit.
