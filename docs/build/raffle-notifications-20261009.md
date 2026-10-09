# Raffle notifications

Date: 2026-10-09

Risk: R2. This feature reads finalized events from the approved raffle deployment, publishes a public historical activity feed, and sends fixed operational email alerts.

## Behavior

- `RaffleCreated` appears as `Draft awaiting review` and links to `/review/[id]`.
- `Opened` appears as `Raffle live` and links to `/piece/[id]`.
- The public feed is read-only. It does not initialize email state or claim that a historical event describes current availability.
- The header bell polls the cached public endpoint at most once per minute while the document is visible. Its unread marker uses device-local storage scoped to the deployment. Fetching activity does not mark it read.
- The cron captures an immutable latest-block activation boundary on its first run and sends no mail during that run. Only later finalized events are eligible.
- `POST /api/cron/notifications` is a separate, `CRON_SECRET`-protected provider connection test. It accepts no request body, sends a fixed configuration-test message to `team@fantomlabs.io`, and does not create an event, activation record, page, or feed item.

## Integrity and recovery

The event reader checks the RPC chain, approved contract, finalized head, strict ABI decode, positive raffle ID, complete log metadata, requested range, canonical event blocks, and the pinned finalized block after the read. A newer finalized tag is allowed after that pinned block is reverified. Multi-block reads use 100 events as a page-sizing threshold. A single block retains every canonical matching event up to the refund-aware bound `floor(5 * gasLimit / (4 * 1125))`. RPC calls have typed request and time budgets; transient timeouts do not trigger recursive splitting.

Email activation stores the latest mined block number and hash with `setIfAbsent`. Once finalized, the processor verifies that boundary and stores the successful verification. A changed hash creates a terminal reconciliation marker.

Ingestion pages are immutable and keyed by deployment plus start block. Version 2 distinguishes bounded multi-block pages from gas-bounded complete single-block pages; version 1 remains readable. A page and its next-block proof are one atomic `setIfAbsent` write. Mutable ingestion and retry hints are advisory. The processor accepts a forward hint only when an immutable predecessor page proves it. Invalid or future hints replay from the activation boundary. Retry and ingestion have separate runtime budgets, and a blocked ingestion range is durable and does not stop retries of existing pages.

Each delivery reserves an immutable payload, provider identity, and first-attempt time only after send capacity is available. Retries use the same provider idempotency key. Provider exceptions and unacknowledged responses remain pending. Provider, sender, template/origin changes and attempts outside the 23-hour safe retry window create durable reconciliation markers and never count as accepted. Historical acceptance remains accepted across later configuration changes. The processor checks the clock immediately before the provider call and continues later events after a failed send. Per-event terminal markers let pages larger than the per-run scan budget finish over multiple runs without dropping events.

## Runtime configuration

Required server variables:

- `CRON_SECRET`
- `RESEND_API_KEY`
- `RESEND_FROM`
- `LABX_ADMIN_EMAIL=team@fantomlabs.io`
- an existing persistent `LABX_STORE` configuration

`web/vercel.json` schedules `GET /api/cron/notifications` every five minutes. Missing cron or mail configuration fails closed before RPC, storage, or provider setup where applicable.

## Verification

The focused suite covers canonical and malformed chain logs, reorg checks, immutable page ordering, activation changes, hostile progress hints, dense-page continuation, provider exceptions, lost acknowledgements, retry cutoff checks, same-block public pagination, bounded-empty range pagination, cron authorization, and connection-test isolation.

The builder evidence is under `../artifacts/raffle-notifications-20261009/builder/`. Production configuration, the one authorized connection-test invocation, aggregate tests, browser checks, independent review, and release remain release-owner gates.
