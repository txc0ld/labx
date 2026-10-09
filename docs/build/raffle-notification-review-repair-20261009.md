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

The cron establishes one 56-second deadline before source initialization, leaving response margin within the 60-second route limit. Source initialization, activation verification, retry work, ingestion, and fresh-page work share that deadline. Retry processing reserves an 18-second ingestion window and a one-second response/diagnostic margin, and no provider send starts without the adapter's ten-second allowance. Every activation store call is request-bounded. Retry and fresh-delivery store calls, including acceptance and terminal bookkeeping, use their delivery phase deadline. Ingestion progress-proof reads and page writes count against its 18-second phase. The reserve includes source reads plus successful store latency; expiration can still leave a durable page/proof for the next invocation to resume. Source event reads receive the remaining absolute call deadline for their internal RPC budget. Store results are rechecked after resolution, so an uncancellable in-flight atomic write may finish but cannot trigger another expired operation. Terminal-prefix reads stop at the delivery deadline; unproved markers remain replayable and cannot advance retry progress.

After activation verification, retry and ingestion retain separate work allowances inside the shared deadline. Existing pages are retried before new RPC ingestion. Ingestion failures preserve the cursor, persist a sanitized blocked-range incident, and return `status: "degraded"`; they do not suppress existing delivery retries. Provider-pending results remain ordinary pending work. A caught delivery or storage processing failure increments `processingFailures`, persists a sanitized incident when time remains, and makes only that run degraded while later events continue. A healthy retry can report healthy again.

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

## Deadline escalation on 2026-10-09

The original ten-second reserve covered source calls but omitted successful hint/proof and completion-store latency. Retry now ends at the earlier of its 31-second allowance or request deadline minus 19 seconds. Ingestion gets up to 18 seconds, capped one second before the request deadline. Short test/request deadlines reserve at most ten percent for diagnostics. Retry discovery time also counts against the cumulative 31-second delivery allowance. The longer reserve can reduce the number of ten-second provider attempts in a run; the three-send maximum is unchanged.

A phase timeout after provider acceptance can leave an immutable reservation or an accepted marker whose write result was not observed. A timed-out acceptance write reports degraded without counting an unobserved acceptance or creating a terminal proof. Capacity exhaustion before a reservation does not count as a pending provider result. A later invocation uses the same reservation/key. It skips a repeated send when it observes durable acceptance and resumes page/cursor progress from durable proofs. The processor checks the send allowance again after a reservation read and before the first reservation write.

Regression evidence covers the original 12+6+6-second source/activation setup, a ten-second accepted send, and two-second post-send store calls. Ingestion persists its new page and proof, preserves the unadvanced cursor on timeout, and a normal-latency invocation resumes both cursors without resending accepted mail. A real asynchronous held store read times out and makes no later calls when released.
