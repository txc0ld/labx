# Raffle notification review repair

Date: 2026-10-09

Candidate base: `842f00e907259b421361e5f8e6709256fab44456`

Risk: R2. This repair keeps the existing public-feed and fixed-recipient mail architecture while closing dense-block, retry isolation, delivery configuration, and operations visibility failures.

## Stored state

New immutable pages use version 2:

- `kind: "range"` holds at most 100 events across more than one block.
- `kind: "single-block"` holds the complete canonical event list plus block number, hash, and gas limit. Parsing recomputes the refund-aware maximum `floor(5 * gasLimit / (4 * 1125))` and verifies every event against the block.

Version 1 pages remain readable. Page and ingestion-proof writes stay atomic. Event terminal markers and proved contiguous terminal prefixes allow a page with more than 400 events to finish across bounded runs. Resume indices accept any canonical safe integer below the page length.

Delivery reservations keep their original payload, event binding, provider identity, and first-attempt time. The processor checks send capacity before creating a reservation. Current payload or provider drift creates a durable reconciliation marker; malformed reservation records get the separate `invalid-record` reason. An accepted message stays accepted and is not resent after configuration changes. Connection-test keys include the exact fixed payload and provider identity, so one corrected configuration can be explicitly tested once without replaying the same configuration.

## Runtime behavior

After activation verification, retry and ingestion run with separate bounded time budgets. Existing pages are retried before new RPC ingestion. Ingestion failures preserve the cursor, persist a sanitized blocked-range incident, and return `status: "degraded"`; they do not suppress existing delivery retries. Provider and per-event storage failures remain pending and later events continue when incident persistence succeeds.

The event reader makes bounded calls. It distinguishes request exhaustion and timeouts, never recursively splits a transient timeout, and lets callers halve actual dense/range-limited multi-block reads through a final singleton attempt. It pins the original finalized block by number and hash, rejects regression or a changed pinned hash, and accepts normal finalized-height advancement.

Cron responses and the sanitized `notification-cron` log include run-local counts, cursors, ingestion state, and the latest durable incident reference. Counts describe observations from that run; they are not backlog totals or proof of inbox delivery.

## Incident inspection

For deployment prefix `raffle-notifications:v1:<chainId>:<contract>`, inspect these keys:

- `:ingestion-status`
- `:latest-incident`
- `:incident:ingestion:<startBlock>`
- `:page:<startBlock>:event-incident:<index>`
- delivery `raffle-notification:<digest>:reconciliation` records

For the Neon store, operators can use a read-only query with the exact deployment prefix:

```sql
SELECT key, value
FROM public.labx_store
WHERE key LIKE 'raffle-notifications:v1:<chainId>:<contract>:%'
   OR key LIKE 'raffle-notification:%:reconciliation'
ORDER BY key;
```

Values contain sanitized status, public chain positions, reason codes, and timestamps. They do not contain provider responses or credentials. Root owns production inspection and configuration.

## Deferred capacity policy

The processor retains the existing limit of three provider sends per five-minute run. It does not drop or combine draft alerts. Prioritizing `Opened` ahead of draft backlog changes queue policy and remains a release-owner follow-up; this repair does not claim production capacity load testing.
