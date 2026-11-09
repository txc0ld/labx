# Server state machines (10 Nov 2026, main 2078b82)

This part covers everything that runs on the server: the draw runner, admin notifications, receipt mail, commitment
reservation, agreement records, the store, the wallet NFT proxy and the routes under `web/app/api`. The contracts and
the browser client are in the other parts.

It builds on the audit of 7 Nov 2026 (`docs/build/implicit-state-machines-20261107.md`, defect IDs D1 to D7) and on
commit 972f46c, which fixed the verified ones. Section "Status of D1 to D7" says what is fixed, open or accepted.

## How to read this

A lead counts as a confirmed bug only when a vitest test drove the real module through the sequence and observed the
invalid state. Each confirmed bug has a regression test that failed before the fix and passes after it. Claims marked
"by reading" were not executed.

The environment these machines run in:

- The store (`web/lib/points.ts:4`) has `get`, `set` and an atomic `setIfAbsent`. It has no delete, no TTL and no
  compare-and-set, so every first-wins record is permanent. Production is Neon (`web/lib/store.ts:145`). A write can
  land and still be reported as failed: the request is aborted after 5 s (`web/lib/store.ts:7`), and Neon maps every
  error except its own primary key conflict to "Store request failed" (`web/lib/store.ts:195`).
- Both crons fire every 5 minutes. A function can be killed between any two awaits, invoked twice at once, or retried.
- The runner signs real transactions with a hot key.
- Mail sends carry an idempotency key that the provider keeps for 24 hours (`web/lib/receipt-delivery.ts:103`).

Events considered for every machine: a kill between two store writes, two overlapping invocations interleaved at each
await, a retry after an uncertain provider or RPC answer, a chain reorg, an RPC that lags, a store write that fails
after the external side effect succeeded, and clock skew wherever a value is compared with `Date.now()`.

Phase numbers used below are the contract's: 0 Draft, 1 Open, 2 Closed, 3 Drawing, 4 Drawn, 5 Settled, 6 Cancelled.

## Summary of confirmed findings

| # | Severity | Finding | Fixed in |
|---|---|---|---|
| 1a | high (small amount) | The runner sent a step twice when the read after its own confirmed send came from a node one block behind | 5d05063 |
| 1b | high (small amount, narrow) | The runner sent a step again at the next nonce when its pending transaction was mined between the gas estimate and the nonce read | 5d05063 |
| 2 | medium | A replacement whose broadcast got no answer erased the record of the stuck transaction, so it was never replaced | 5d05063 |
| 3 | medium for alerts, low for receipts | A reservation dated ahead of the reader's clock was treated as an expired retry window | 3196610 |

Severity scale, as in the earlier audit: high means a possible duplicate send or money at risk, medium means a user or
the operator is stuck until support acts, low means extra clicks, cosmetic or operator inconvenience.

## 1. Runner per-raffle decision and step loop

Code: `web/lib/draw-runner/decide.ts:15-35`, `web/lib/draw-runner/run.ts:143-248`.

### States

The per-raffle state is not stored. It is derived on every loop turn from one pinned chain read
(`web/lib/draw-runner/run.ts:156`) by `nextRunnerAction` (`web/lib/draw-runner/decide.ts:15`).

| State | Encoding | Ref |
|---|---|---|
| Idle | No rule below matches: phase 0, 3, 5 or 6; phase 1 before sales end, with no lots, or past sales end plus the draw start grace; phase 2 past that deadline and not counted; phase 4 neither revealed nor past the reveal grace | decide.ts:25 |
| Needs close | phase 1, `close` enabled for any caller, `lotCount > 0`, block time before sales end plus draw start grace | decide.ts:21 |
| Needs count | phase 2, `snapshot` enabled (not yet `snapshotted`), before the same deadline | decide.ts:22 |
| Needs draw request | phase 2, `requestRandomness` enabled (count complete) | decide.ts:23 |
| Needs settle | phase 4, `settle` enabled | decide.ts:24 |

Inside one run each chosen step passes through: chosen, prepared and simulated at a pinned block
(run.ts:166), allowlisted (run.ts:176), nonce read (run.ts:184), quoted with a fresh estimate (run.ts:187), affordable
(run.ts:202), sent (run.ts:214) and confirmed (run.ts:235). The run-local variables are `batch` (run.ts:150, the count
batch size that fits the gas cap) and `confirmed` (run.ts:152, the step last seen confirmed and the count position it
was sent from). Each step ends as one report item: succeeded, reverted, unknown, failed, skipped, low-funds or gas-cap
(run.ts:73).

### Invariants

- I1. The runner signs only `close`, `snapshot`, `requestRandomness` or `settle`, with zero value, on the raffle
  contract, for the raffle and batch it chose (`assertRunnerCall`, decide.ts:94).
- I2. A step is sent only after a simulation at a pinned block and a fresh gas estimate both accept it.
- I3. A step the runner saw confirmed is not sent again from the same raffle state in the same run.
- I4. No send starts with less than 25 s of the run left (run.ts:155, run.ts:213), and at most six sends leave per run
  (run.ts:163).
- I5. One raffle cannot stall the queue: a step that fails for a reason local to the raffle ends that raffle's loop and
  the run goes on.

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| any | loop turn | less than 25 s left | run stops `deadline`, cursor at this raffle | run.ts:155 |
| any | read | no step applies | Idle, next raffle | run.ts:158 |
| any | read fails or times out | | run stops `interrupted`, cursor after this raffle | run.ts:246 |
| step chosen | read shows the confirmed step again at the same count position (lagging node) | `confirmed` matches kind and `lotCursor` | item skipped, next raffle | run.ts:162 |
| step chosen | six sends already left | | run stops `send-cap`, cursor at this raffle | run.ts:163 |
| step chosen | simulation reverts | a fresh read no longer calls for it | item skipped, next raffle | run.ts:171-172 |
| step chosen | simulation reverts | a fresh read still calls for it | item failed, report not ok, next raffle | run.ts:171-172 |
| prepared | call is not the chosen step | | item failed `Refused`, nothing sent | run.ts:176-180 |
| prepared | estimate reverts (another caller took the step) | | item skipped, next raffle | run.ts:191 |
| prepared | estimate fails for funds | | item low-funds, next raffle | run.ts:192 |
| prepared | estimate fails otherwise | | item failed, run stops `interrupted` | run.ts:193-194 |
| quoted | max fee above 50 gwei | | run stops `fee-cap` | run.ts:196 |
| quoted | gas above the cap | count step and batch above 1 | batch halved, loop turn | run.ts:198 |
| quoted | gas above the cap | otherwise | item gas-cap, next raffle | run.ts:199 |
| quoted | balance below the limit at max fee plus a tenth | | item low-funds, next raffle | run.ts:202 |
| affordable | nonce shows a pending transaction | see section 2 | replace, or run stops `pending-transaction` | run.ts:203-212 |
| affordable | send refused by the node | funds | item low-funds, next raffle | run.ts:216 |
| affordable | send refused by the node | other | item failed, run stops `send-failed` | run.ts:217-218 |
| sent | broadcast outcome unknown | | item unknown, run stops `pending-transaction` | run.ts:229-232 |
| sent | no receipt in time | | item unknown, run stops `pending-transaction` | run.ts:236-239 |
| sent | receipt reverted | | item reverted, next raffle | run.ts:241 |
| sent | receipt succeeded | | `confirmed` set, loop turn | run.ts:242 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill between any two awaits before the send | Nothing was sent. The next run reads the chain again | safe |
| Kill after the send | The transaction is in the pool or mined. The next run sees the new phase or a pending nonce (section 2) | safe, with the limit in section 2 |
| Two overlapping runs | The lease lets one run through (section 3) | safe |
| Read lags the runner's own confirmed send | Before 5d05063 the step was sent again. Finding 1a | fixed |
| Read lags another caller's step | The pinned simulation passes on the stale block. The fresh estimate is the guard (run.ts:191). If the estimate is stale too, the runner sends a step that reverts | accepted, see suspicions |
| Reorg drops the block with the runner's step | The transaction returns to the pool and is mined again in nonce order. A later run reads the chain as it is | safe by reading |
| Clock skew | The loop compares only run-local time. The draw deadline uses the block timestamp (decide.ts:17) | not affected |

### Illegal combinations checked

| Combination | Result |
|---|---|
| Same step sent twice for one raffle in one run | Reachable before 5d05063 through a lagging read. Test: "does not send %s again when the read after its confirmed send comes from a node one block behind" (`web/test/draw-runner.test.ts:985`). Unreachable now for a read at the same count position |
| A signed call other than the chosen step | Unreachable: `assertRunnerCall` runs on every prepared call before the quote. Test: "reports a prepared call %s as failed and refused, sends nothing for it and goes on" |
| A send with less than 25 s left | Unreachable: checked at the loop head and again just before the send. Test: "starts a send with exactly 25 seconds left and not with less" |
| A reverted step retried in the same run | Unreachable: run.ts:241 ends the raffle. Test: "reports a reverted send and does not retry it in the same run" |
| Report ok with an item that failed, reverted or is unknown | Unreachable: run.ts:253-254 |

## 2. Runner transaction in flight and nonce handling

Code: `web/lib/draw-runner/run.ts:95-117, 184, 203-232`, `web/lib/draw-runner/chain.ts:118-159`.

### States

Encoded by the node's two nonce reads (`latest`, `pending`, chain.ts:118) and one store key, `draw-runner:last-send`
(run.ts:37), holding `{ runner, nonce, hash, maxFeePerGas, maxPriorityFeePerGas }`.

| State | Encoding |
|---|---|
| T0 idle | `pending == latest` |
| T1 own send pending, recorded | `pending == latest + 1`, record has this runner and `nonce == latest`, and the node holds `hash` unmined at that nonce (chain.ts:134) |
| T2 own send pending, record missing or stale | `pending == latest + 1`, record absent, unreadable, or for another nonce or runner |
| T3 another transaction at that nonce | `pending == latest + 1`, record matches, node does not hold `hash` (for example an operator's cancellation) |
| T4 several pending | `pending > latest + 1` |
| T5 mined | `latest` moved past the recorded nonce |

### Invariants

- I6. At most one runner transaction is mined per nonce. The chain enforces this; the runner never signs for a nonce
  above `latest`.
- I7. With a transaction pending, the runner sends only a replacement at that same nonce, never a new nonce
  (run.ts:203-212).
- I8. Only the runner's own recorded send, alone in the pool, is replaced, with max fee and tip each at least a tenth
  higher (run.ts:96, 116) and under the 50 gwei cap (run.ts:209).
- I9. A stuck transaction of the runner's own is eventually replaced once suggested fees pass its own. This holds only
  while the record names the transaction the node holds. See finding 2 and the accepted limit below.
- I10. A step carried by a pending runner transaction does not land a second time at the next nonce.

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| T0 | send accepted | | T1, record written | run.ts:214, 223 |
| T0 | send outcome unknown | | T1 if it reached the pool, else T0. Record written either way | run.ts:223, 229 |
| T0 | send accepted, then kill or store failure before the record write | | T2 | run.ts:221-227 |
| T1 | next run, suggested max fee not above the recorded one | | wait, run stops `pending-transaction` | run.ts:115, 208 |
| T1 | next run, fees risen | bumped fee within cap and affordable | replacement sent at the same nonce | run.ts:207-214 |
| T1 | replacement accepted | | T1 with the new hash and fees recorded | run.ts:223 |
| T1 | replacement outcome unknown | | record kept, so the next run can still replace the original | run.ts:223 |
| T1 | replacement meets "nonce too low" | original was mined first | T5, run stops `pending-transaction` | chain.ts:153, run.ts:229 |
| T1 | original mined between the nonce read and the estimate | | estimate reverts, item skipped | run.ts:184-191 |
| T1 | original mined after the estimate | | wait if fees have not risen or the node no longer holds the hash, else the replacement fails on its nonce | run.ts:208, 229 |
| T2, T3, T4 | next run | | wait, run stops `pending-transaction` | run.ts:104, 208 |
| any | mined | | T5, then T0 | |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill between the broadcast and the record write | T2. The runner waits for the transaction and never replaces it | accepted limit, pinned by "waits for a pending transaction whose record was never written" (`web/test/draw-runner.test.ts:1437`) |
| Record write fails after the broadcast | Same as the kill | accepted limit |
| Uncertain broadcast answer on a first send | Record written. If nothing reached the pool the next run finds T0 and sends normally | safe |
| Uncertain broadcast answer on a replacement | Before 5d05063 the record was overwritten with a hash the node may not hold. Finding 2 | fixed |
| Node lags on the nonce | A stale low nonce makes the send fail with "nonce too low", reported unknown. No second transaction can be mined at a used nonce | safe |
| Pool view lags (pending read from a node without the transaction) | The runner sends at the same nonce. The pool keeps one of the two | safe |
| Reorg returns a mined transaction to the pool | `latest` drops back. The record may name a later nonce, so the runner waits (T2) until it is mined again | safe by reading |
| Two overlapping runs | Excluded by the lease. If both ran, both would sign the same nonce and one would be dropped | safe |
| Clock skew | No clock is compared here | not affected |

### Illegal combinations checked

| Combination | Result |
|---|---|
| A step sent at nonce N+1 while the runner's transaction for that step at nonce N is being mined | Reachable before 5d05063: the nonce was read after the estimate. Test: "does not send the step again at the next nonce when its pending transaction is mined right after the estimate and fees %s" (`web/test/draw-runner.test.ts:1478`). Finding 1b |
| Record names a hash the node does not hold while the node holds the runner's earlier send | Reachable before 5d05063 through a replacement lost in transit. Test: "still replaces its stuck transaction after a replacement's broadcast never reached the node" (`web/test/draw-runner.test.ts:1491`). Finding 2 |
| A replacement of someone else's transaction | Unreachable: `pendingAt` must confirm hash, nonce and sender. Test: "waits instead of replacing a transaction that took its recorded send's place" |
| A replacement above the fee cap | Unreachable. Test: "stops at the 50 gwei fee cap instead of replacing above it" |
| A new nonce used behind a pending transaction | Unreachable: every send uses `nonce.latest` (run.ts:214). Test: "waits for an earlier runner transaction instead of sending behind it" |

## 3. Runner lease, scan cursor and low-water mark

Code: `web/lib/draw-runner/run.ts:80-88, 119-142, 249-251`, `web/lib/draw-runner/decide.ts:43-91`.

### States

| Machine | Encoding | States |
|---|---|---|
| Lease | One permanent row per five-minute bucket, `draw-runner:lease:5m:<bucket>` (run.ts:87), written with one atomic `setIfAbsent` for every bucket the run's `[start, deadline]` touches (run.ts:123) | free, held. A held bucket is never released; the next bucket is a new key |
| Scan cursor | `draw-runner:cursor` (run.ts:33), a raffle id | any id; out of range falls back to the low-water mark (decide.ts:46) |
| Low-water mark | `draw-runner:low-water` (run.ts:35), `<contract>:<id>` | every raffle below `id` was settled or cancelled when a scan read it; another contract's mark is ignored (run.ts:132) |

### Invariants

- I11. Two runs whose `[start, deadline]` intervals share an instant on the same clock cannot both pass the lease.
- I12. A lease holder that died is replaced no later than the next free bucket.
- I13. The low-water mark never moves past a raffle that a scan did not read as final, or did not read
  (decide.ts:82-87).
- I14. The cursor is a hint. Any value is safe: the scan window always starts inside `[lowWater, nextId)` and wraps
  (decide.ts:43-50).
- I15. One unreadable raffle cannot stall the scan: the cursor resumes after it (decide.ts:89, run.ts:246).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| bucket free | run starts | all its buckets free | held, run proceeds | run.ts:123 |
| bucket held | run starts | any of its buckets held | report `busy`, ok, nothing read | run.ts:125 |
| held | run ends, is killed or times out | | stays held until the bucket passes | |
| cursor c | scan completes | | first id not read, wrapping | decide.ts:88 |
| cursor c | scan read fails | | id after the failed read | decide.ts:89 |
| cursor c | scan runs out of time | | first id not read | decide.ts:90 |
| cursor c | run stops at raffle id | | id, or id + 1 after a failed read, estimate or refused send | run.ts:142 |
| mark m | scan counted raffles m..k as final | k + 1 not final or not counted | k + 1 | decide.ts:86-87 |
| mark m | saved mark above the raffle count or for another contract | | scan restarts from 1 | decide.ts:69, run.ts:132 |
| cursor, mark | end of run | both writes within 2 s | saved | run.ts:250 |
| cursor, mark | cursor write fails or times out | | report `interrupted`; old values stay and the next run rescans | run.ts:251 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill before the cursor write | Old cursor and mark stay. The next run reads the same raffles again | safe |
| Kill between the two writes | They are independent `set` calls. Either alone is safe (I14, and the mark only ever rises over final raffles) | safe |
| Lease write lands but is reported failed | The run aborts with 503 and the bucket is spent with no work done | low, self-heals in the next bucket |
| Two overlapping invocations | One reports `busy`. Tests: "lets only one of two overlapping runs send", "lets only one of two runs straddling a boundary send" | safe |
| Run starts more than 4 min 4 s into its bucket | It also takes the next bucket, so the next scheduled run reports `busy` | low, one skipped run |
| Clock skew between two overlapping invocations | Buckets come from each server's own clock. Skew of minutes could give two overlapping runs disjoint buckets. Even then the nonce limits them to one transaction per nonce | accepted, see suspicions |
| Lagging node at scan time | A stale block shows fewer final raffles and a lower raffle count, so the mark can only stay or restart from 1 | safe |
| Reorg after a scan read a raffle as final | The mark has passed that raffle and never returns | see suspicions |

### Illegal combinations checked

| Combination | Result |
|---|---|
| Mark above a raffle that is not final | Unreachable without a reorg: the mark advances only over counted reads that pass `finalPhase`, and final phases have no exits in the contract. Test: "never moves past a raffle whose read failed or did not finish" |
| Cursor outside the raffles | Harmless: falls back to the mark. Test: "restarts at the first raffle when the saved cursor is out of range" |
| Two runs sending in the same instant | Unreachable on one clock (I11). Test: "gives every pair of overlapping runs around a bucket boundary a shared key" |
| A run that never ends holds the runner forever | Unreachable: the lease is per bucket, and all work ends 4 s before the run deadline (run.ts:120) |

## 4. Notification ingestion cursors and activation boundary

Code: `web/lib/notifications/processor.ts:119-258` (run), `260-329` (pages), `625-645` (hints).

### States

All keys share the prefix `raffle-notifications:v1:<chainId>:<contract>`.

| Record | Key | Kind | Meaning |
|---|---|---|---|
| Activation | `:activation` | first-wins, hash may be rewritten once | Block number and hash the deployment started watching from (processor.ts:127, 147) |
| Verified boundary | `:activation-verified` | first-wins | The activation block is final and its hash is the stored one (processor.ts:149) |
| Page | `:page:<start>` with `:ingestion-proof:<next>` | first-wins, written atomically together | The verified events of blocks `start..actualEnd` (processor.ts:321-324) |
| Ingestion hint | `:ingestion-hint` | overwritten | Next block to ingest. Trusted only if `:ingestion-proof:<hint>` names a stored page that ends just before it (processor.ts:625-645) |
| Last page | `:last-ingested-page` | overwritten | Start of the newest ingested page, so it is retried next run |

Activation states: not activated (no `:activation`), activated and unverified (`:activation` only), verified (both, same
hash), and invalid (both, different hash; every run throws at processor.ts:151).

Ingestion states: caught up (hint above the finalized block), behind (hint at or below it), replaying (hint missing or
unproven, so the run walks stored pages again from the first event block, two pages a run), and blocked (a source read
failed; an incident is recorded and the report is degraded, processor.ts:212-227).

### Invariants

- I16. The activation block number never changes. The first event block is always that number plus one.
- I17. Nothing is ingested or mailed before the activation block is final and verified (processor.ts:136-152).
- I18. A page is immutable and covers only finalized blocks whose logs matched their canonical block hash
  (`web/lib/notifications/events.ts:140, 162, 174-180`).
- I19. Pages are contiguous: a page starts where the previous one ended, and the chain of pages from the first event
  block is unique, because each start has one first-wins record.
- I20. The ingestion cursor never skips a block. It is set only to the `nextBlock` of a stored page (processor.ts:202),
  and an unproven hint is treated as "start over", not as progress (processor.ts:638).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| not activated | first run | | activated, report `activated`, nothing else done | processor.ts:127-134 |
| unverified | run | finalized block below activation | unchanged, report `idle` | processor.ts:141 |
| unverified | run | activation block final, same hash | verified | processor.ts:149 |
| unverified | run | activation block final, different hash (reorg) | activation hash rewritten, then verified | processor.ts:145-149 |
| verified | run | stored hashes agree | proceed | processor.ts:151 |
| behind | run | page not stored | read events, halve the range while it is too dense, store page and proof, set hint | processor.ts:269-324, 202 |
| behind | run | page already stored (another run, or a replay) | load it, set hint | processor.ts:325-328, 202 |
| behind | source read fails or times out | | blocked for this run, incident recorded, hint unchanged | processor.ts:212-227 |
| any | hint missing, malformed or without a proof | | replaying from the first event block | processor.ts:632-638 |
| any | proof names no stored page, or a page that ends elsewhere | | run throws; ingestion stops until repaired | processor.ts:639-643 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill between the page write and the hint write | The next run starts at the old hint, finds the stored page and moves on | safe |
| Kill between the activation rewrite and the verified write | The next run reads the block again, finds the hashes equal and writes the verified record | safe |
| Two overlapping runs ingest the same start | One page write wins. The other run reads the stored page. Hint writes are last-writer-wins and can move the hint back, which only causes a re-read | safe |
| Two overlapping runs at an unverified, reorged activation | Both rewrite the same hash. A run that parsed the old activation and then reads the other's verified record throws once (processor.ts:151) and succeeds next time | safe by reading, one failed run |
| Store write lands but is reported failed | Page: the next run loads it. Hint: stays behind, re-read | safe |
| Reorg | Only finalized blocks are read. The activation block is re-anchored once before anything is ingested | safe. Test: "re-anchors a reorged activation block to the finalized block" |
| Lagging node | Finalized height below activation gives `idle` or a blocked run. A log read that silently returns fewer logs for a finalized range would be stored for good | see suspicions |
| Clock skew | Only deadlines within one process use the clock | not affected |

### Illegal combinations checked

| Combination | Result |
|---|---|
| Verified record whose hash differs from the activation | Unreachable unless the node gives two different hashes for the same finalized block to two overlapping runs. See suspicions |
| Hint beyond a block with no stored page | Unreachable: the hint is written only after the page and its proof exist. Tests: "treats unproved future progress hints as replay hints", "fails closed when an immutable progress proof is malformed" |
| Two pages with the same start and different events | Unreachable: one first-wins key per start |
| An event from a block that is not final | Unreachable: events.ts:140 refuses the range, and the finalized head is pinned and rechecked (events.ts:172-180) |

## 5. Notification delivery reservation

Code: `web/lib/notifications/delivery.ts:91-178`, `web/lib/notifications/processor.ts:344-550`.

### States

Per event, with `K = raffle-notification:<keccak(deployment, block hash, transaction hash, log index, event name)>`
(delivery.ts:48-49):

| State | Encoding |
|---|---|
| Unreserved | `K` absent |
| Reserved, retryable | `K` holds a valid reservation (immutable payload, `createdAt`, provider identity); no `K:accepted`, no `K:reconciliation`; same provider identity; the reader's clock is before `createdAt + 23 h` and not more than 1 h behind `createdAt` |
| Accepted | `K:accepted == "accepted"`. Terminal |
| Reconciliation required | `K:reconciliation` holds a reason, no `K:accepted`. Terminal; no mail is sent again |
| Accepted and reconciliation both present | Reads as accepted, because acceptance is checked first (delivery.ts:129-130) |

Per page, with `P = <prefix>:page:<start>`:

| Record | Kind | Meaning |
|---|---|---|
| `P:terminal:<i>` | first-wins | Event i reached accepted or reconciliation (processor.ts:503-507) |
| `P:terminal-prefix` with `P:terminal-proof:<n>` | hint with first-wins proof | The first n events are terminal (processor.ts:509-550) |
| `P:resume` | overwritten | Index to continue from, so a failed event yields to later ones (processor.ts:364-365, 428) |
| `<prefix>:retry-hint` with `:retry-proof:<next>` | hint with first-wins proof | Every page before the hint is all terminal (processor.ts:436-441) |
| `<prefix>:retry-scan-hint` | overwritten | Where the search for later non-terminal pages resumes (processor.ts:466-491) |

### Invariants

- I21. An event is mailed at most once. Every send for an event carries the same key `K` and the same stored payload,
  and no send starts 23 h or more after the reservation, which is inside the provider's 24 h retention.
- I22. A terminal marker implies `K:accepted` or `K:reconciliation` was read back from the store
  (processor.ts:394-400, delivery.ts:162, 175).
- I23. The retry cursor never moves past an event without a terminal marker (processor.ts:434-441).
- I24. A page behind a page that stays pending is still retried inside its window (processor.ts:455-493).
- I25. At most three sends start per run, and no reservation is made when no send can start (processor.ts:371,
  delivery.ts:105).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| Unreserved | run reaches the event | a send can start | Reserved (first-wins) | delivery.ts:103-118 |
| Unreserved | run reaches the event | no send can start | unchanged, run stops this pass | delivery.ts:105 |
| Reserved | stored record fails validation | | Reconciliation `invalid-record` | delivery.ts:125 |
| Reserved | payload built now differs from the stored one | | Reconciliation `payload-configuration-changed` | delivery.ts:139-141 |
| Reserved | provider key changed | | Reconciliation `provider-identity-changed` | delivery.ts:265 |
| Reserved | 23 h passed, or reservation dated more than 1 h ahead | | Reconciliation `retry-window-ended` | delivery.ts:266 |
| Reserved | send acknowledged | no reconciliation written meanwhile | Accepted | delivery.ts:152-163 |
| Reserved | send acknowledged | reconciliation written meanwhile | Reconciliation (mail was sent) | delivery.ts:157-160 |
| Reserved | send refused, thrown or timed out | | Reserved, counted pending | delivery.ts:153-156 |
| Accepted or Reconciliation | run reaches the event | | terminal marker written | processor.ts:394-400 |
| page | all events terminal and page is at the retry cursor | | retry cursor moves to the next page | processor.ts:436-441 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill after the provider accepted, before `K:accepted` | The next run sends again with the same key and payload inside the window; the provider deduplicates. Test: "retries an uncertain provider attempt with the immutable original reservation and key" | safe |
| Same, but no run reaches the event for 23 h | Reconciliation `retry-window-ended`. The mail went once and the operator is told | by design |
| Kill between `K:accepted` and the terminal marker | The next run reads accepted and writes the marker | safe |
| Two overlapping runs on one event | Both send with the same key; one message. Both write acceptance | safe |
| Overlapping run records reconciliation between the answer and the acceptance write | Both markers exist; reads as accepted. Test: "lets acceptance win when an overlapping run records reconciliation between the provider's answer and the acceptance write" (`web/test/notification-delivery.test.ts:116`) | benign |
| Clock skew between overlapping runs | Before 3196610 a reader whose clock was behind the reservation recorded `retry-window-ended`. Finding 3 | fixed |
| Store write lands but is reported failed | Reservation, acceptance and markers are all re-read on the next run | safe |
| Reorg | The key includes the block hash, and only finalized events are stored | safe |

### Illegal combinations checked

| Combination | Result |
|---|---|
| `K:reconciliation` with reason `retry-window-ended` less than 23 h after the reservation | Reachable before 3196610 with a clock difference of any size. Tests: "retries a reservation written a moment ago by a server whose clock runs ahead" (`web/test/notification-delivery.test.ts:94`), "delivers once and records acceptance when two overlapping runs' clocks disagree by a fraction of a second" (`web/test/notification-processor.test.ts:197`) |
| Mail sent, reconciliation marker, no acceptance | Reachable when an overlapping run records reconciliation while the send is in flight (delivery.ts:157-160). Conservative: the operator is asked to check a delivered alert. Before 3196610 clock skew produced this |
| `K:accepted` and `K:reconciliation` together | Reachable, benign (see events) |
| Terminal marker with neither `K:accepted` nor `K:reconciliation` | Unreachable: both results are returned only after the marker's source record was read back |
| `K:accepted` without `K` | Unreachable: acceptance is written only after the reservation was parsed |
| Two mails for one event | Unreachable inside the provider's retention; no send starts later than 23 h after the reservation |
| Retry cursor past a pending event | Unreachable (I23). Tests: "retries a later page's failed event inside its window while an earlier page stays pending", "stops a slow terminal-prefix scan at its phase deadline without advancing retry progress" |

## 6. Receipt delivery slots

Code: `web/lib/receipt-delivery.ts:25-63` (send), `75-88` (status).

### States

Per purchase, with `S0 = receipt:v2:<keccak(chain, contract, transaction hash, log index)>`, `S1 = S0:1`, `S2 = S0:2`
(receipt-delivery.ts:90-97). A slot is reserved for one address, compared without letter case.

| Slot state | Encoding | Status shown |
|---|---|---|
| Empty | key absent | not listed |
| Reserved, retryable | record present, no `:sent`, same provider key, reader's clock before `createdAt + 23 h` and not more than 1 h behind `createdAt` | pending |
| Reserved, not retryable | record present, no `:sent`, provider key changed or window ended | unconfirmed |
| Delivered | `<slot>:sent == "delivered"` | delivered |

Slots fill in order. Full means all three are used (receipt-delivery.ts:87).

### Invariants

- I26. Only the buyer of a finalized purchase can reserve a slot: the request is signed over the address, and the
  purchase is verified before the first write (receipt-delivery.ts:28, 39).
- I27. One address holds at most one slot of a purchase, and a purchase reaches at most three addresses.
- I28. `:sent` implies its reservation (receipt-delivery.ts:53-61).
- I29. No address is sent the same receipt twice: every send for a slot carries that slot's key and stored payload,
  inside the 23 h window.

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| Empty | request for a new address | signature valid, purchase verified | Reserved (first-wins) | receipt-delivery.ts:34-44 |
| any | request for an address already in a slot | | that slot is used | receipt-delivery.ts:50 |
| all three used | request for a fourth address | | refused | receipt-delivery.ts:52 |
| Reserved | send acknowledged | | Delivered | receipt-delivery.ts:59-61 |
| Reserved | send not acknowledged | | Reserved; the caller is told to retry | receipt-delivery.ts:60 |
| Reserved | provider key changed | | request refused; slot stays unconfirmed | receipt-delivery.ts:56 |
| Reserved | 23 h passed, or reservation dated more than 1 h ahead | | request refused; slot stays unconfirmed | receipt-delivery.ts:57 |
| Delivered | request again | | answered as a repeat, nothing sent | receipt-delivery.ts:54 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Kill or store failure after the provider accepted, before `:sent` | A retry inside 23 h sends again with the same key; the provider deduplicates. Test: "does not send if reservation fails and safely retries an uncertain delivered-marker write" | safe |
| Same, with no retry for 23 h | The slot stays unconfirmed for good. The buyer can use another address | by design, see ambiguities |
| Two overlapping requests, same address | One reservation wins, both send with the same key. Test: "reserves each purchase for one recipient across concurrent requests and recovers a lost response" | safe |
| Two overlapping requests, the later-started one reserves first | Before 3196610 the earlier request was refused as expired. Finding 3 | fixed |
| Two overlapping requests, different addresses | Each takes its own slot in order | safe |
| Reorg | The purchase must be in a finalized block before any slot is written | safe |

### Illegal combinations checked

| Combination | Result |
|---|---|
| A slot refused as expired less than 23 h after its reservation | Reachable before 3196610 without any clock skew. Test: "serves a request that started just before the overlapping request that reserved the receipt" (`web/test/receipt-agreement.test.ts:191`) |
| `:sent` without a reservation | Unreachable: the marker key is derived from a slot that was just read |
| The same address in two slots | Unreachable: a request walks the slots in order and stops at the first that holds its address, and each slot is first-wins |
| A slot reserved by a wallet that is not the buyer | Unreachable: an existing slot must carry the requester's address (receipt-delivery.ts:49), and a new one needs the verified purchase |
| A fourth address | Unreachable. Test: "lets the buyer correct the address, sending once to each address and to at most three" |

## 7. Commitment reservation

Code: `web/lib/reserve.ts:33-96, 124-144`, `web/lib/workflow-records.ts:19-49`, `web/app/api/reserve/route.ts`.

### States

| State | Encoding |
|---|---|
| None | `reserve-request:v3:<identity>` absent. The identity is the hash of chain, contract, seller and the commitment input, without the signature deadline (workflow-records.ts:24) |
| Saved | `reserve-request:v3:<identity>` holds the commit hash and `reserve:<commit>` holds the record. Both are written in one atomic `setIfAbsent` (reserve.ts:87) |
| Saved, unbound (legacy callers only) | `reserve:<commit>` written with `set` and no request key (reserve.ts:93). No route uses this path |

### Invariants

- I30. One signed request identity maps to one commitment for good. Retries and overlapping requests get the same
  nonce, salt and commit.
- I31. A request key always points to a record that passes its integrity check (reserve.ts:142).
- I32. A record is returned only to the seller who signed it, on the same chain and contract (workflow-records.ts:26,
  32, 47).
- I33. Nothing is saved before the signature is verified and the seller is shown to own the NFT
  (workflow-records.ts:21-22).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| None | signed request | signature valid, seller owns the NFT | Saved | reserve.ts:87 |
| None | two overlapping signed requests | | Saved once; the loser reads the winner's record | reserve.ts:88-92 |
| Saved | signed retry, any deadline | | same record returned | reserve.ts:48-49 |
| None | preparation recovery | | 404, the seller starts over | workflow-records.ts:45 |
| Saved | preparation recovery | seller, deployment and NFT match | public part returned | workflow-records.ts:46-48 |
| any | NFT does not exist or has no code | | 404, nothing saved | `web/app/api/reserve/route.ts:12-25` |
| any | ownership read or store fails | | 503, retry | `web/lib/workflow-failure.ts:14-18` |

Environment events: a write that lands but is reported failed is recovered by the retry, which finds the request key
(test "recovers the original immutable commitment after an ambiguous atomic-write timeout"). A kill before the write
leaves None. A lagging node can refuse a seller who just received the NFT, which a retry fixes. No clock is compared
except the signature deadline (see small machines).

### Illegal combinations checked

| Combination | Result |
|---|---|
| Request key without a record, or pointing to a record that fails integrity | Unreachable: one atomic write. Test: "never acknowledges failed writes or corrupt commitment records" |
| Two commitments for one request identity | Unreachable. Test: "atomically recovers one commitment across concurrent requests and signed retries" |
| A record returned to another wallet | Unreachable. Test: "keeps recovered secrets wallet-bound even with a valid attacker signature" |

## 8. Agreement record

Code: `web/lib/agreement-record.ts:17-42`, read side `web/lib/private-records.ts:24-50`.

### States

One key per wallet, raffle and terms version: `agree:v2:<keccak(identity)>` (agreement-record.ts:28).

| State | Encoding |
|---|---|
| Absent | key absent |
| Recorded, valid | record present and its stored signature still verifies at its stored time |
| Recorded, unverifiable | record present, but the signing contract wallet no longer validates the signature (for example after its owners changed) |

### Invariants

- I34. The first signed agreement for a wallet, raffle and terms version wins and is never replaced
  (agreement-record.ts:34).
- I35. A stored agreement is reported as recorded only while its signature verifies. A node that gave no verdict fails
  the request so it can be retried (private-records.ts:37-45).
- I36. One unverifiable agreement does not hide the wallet's other records.

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| Absent | signed agreement | terms published, signature valid and fresh | Recorded | agreement-record.ts:34 |
| Recorded, valid | another signed agreement, any deadline | | unchanged; the stored one is re-verified and its key returned | agreement-record.ts:35-41 |
| Recorded, valid | signing wallet stops validating the signature | | Recorded, unverifiable | |
| Recorded, unverifiable | records read | | shown as not recorded, other records returned | private-records.ts:43-45 |
| Recorded, unverifiable | another signed agreement | | refused: the stored record fails its re-check | agreement-record.ts:40 |

Two overlapping writes are safe: one wins and the other validates the winner. There is no external side effect, and
the only clock comparison is the signature deadline.

### Illegal combinations checked

| Combination | Result |
|---|---|
| A record for terms that were not published | Unreachable: checked before the write (agreement-record.ts:19) |
| An unverifiable agreement reported as recorded | Unreachable. Test: "leaves out a stored agreement its contract signer no longer validates and returns the other records" |
| A wallet that can never record again for a raffle | Reachable by reading: Recorded, unverifiable has no exit, because the key is first-wins and the stored record must pass (agreement-record.ts:40). Accepted in the earlier audit: no UI writes agreements since easy buy |

## 9. Small machines

| Machine | Location | States and encoding | Invariant | Checked |
|---|---|---|---|---|
| Runner run status and ok verdict | `web/lib/draw-runner/run.ts:76-78, 142, 253-254` | Status: complete, busy, send-cap, deadline (healthy) and low-funds, fee-cap, pending-transaction, send-failed, interrupted. One mutable `report.status` | An unhealthy status is never overwritten by a later stop (run.ts:142). Ok needs a healthy status, progress on a deadline stop, and every item succeeded or skipped | A failed scan read stays reported when the run later stops at the send cap. Test: "still reports a failed scan read when the run later stops at the send cap" |
| Notification run status | `web/lib/notifications/processor.ts:239-242`, `web/lib/notifications/http.ts:70` | activated, idle, ok, degraded, reconciliation-required, from counters | Degraded wins over reconciliation; both make the cron answer not ok | Pending sends alone leave the status ok. See ambiguities |
| Admin connection test | `web/lib/notifications/delivery.ts:64-89` | Same reservation machine as section 5, keyed by the mail configuration | One test mail per sender and provider key | A test that stays unacknowledged for 23 h is reconciliation-required for good for that configuration. See ambiguities |
| Cron gates | `web/lib/draw-runner/http.ts:22-38`, `web/lib/notifications/http.ts:124-144` | not configured (503), unauthorized (401), key missing or privileged (503), run | No chain or key read before the bearer check; the runner key must not be the owner, a Safe signer or the treasury | Tests in `web/test/cron-bearer.test.ts` and "requires the cron secret before reading the key or the chain" |
| Workflow route stage | `web/lib/workflow-failure.ts:14-21` and the routes | A mutable `stage` variable: request, deployment, records | Refusal is 401 and missing is 404 at any stage; otherwise 400 at the request stage and 503 after it | `/api/agreements` and `/api/email/receipt` do not use it and answer 400 for outages. See ambiguities |
| Signature freshness | `web/lib/chain/server.ts:85-86`, `web/lib/request-auth.ts:24-25` | A deadline accepted while it is between now and now + 600 s on the server clock | A signature is single-purpose and short-lived | The client signs now + 300 s, so a client clock more than 5 minutes off in either direction is always refused with a "retry" message. Low, by reading |
| Wallet NFT rate limits | `web/lib/wallet-nfts-server.ts:150-159, 202-209` | Three maps of `{ window, count }` per minute: client address, owner, global upstream | 30 a minute per client and per owner, 120 a minute upstream; maps hold at most 1,024 keys | Eviction lets many distinct keys push out old entries; the per-client limit still bounds one client. Test: "enforces per-owner request limits before a cached response" |
| Wallet NFT concurrency slots | `web/lib/wallet-nfts-server.ts:146-148, 207-215` | `active` counter (0 to 4) and an in-flight map per cache key | A slot is released on every exit; identical misses share one upstream call | Unreachable leak: the counter is raised just before a `try` whose `finally` lowers it. Tests: "times out without retrying and releases the concurrency slot", "coalesces identical misses" |
| Public feed cache and cursor | `web/lib/notifications/public-feed.ts:24, 100-113, 115-131` | Map of promise entries with a 60 s expiry; cursor is an event position or a block bound | A failed read is not cached; a cursor that no longer matches finalized history is refused (public-feed.ts:81) | By reading |
| Points check-in | `web/lib/points.ts:36-55` (not edited here) | `{ balance, lastDay }` per address, read then `set` | One award per UTC day | Two overlapping check-ins both write the same value, so the balance rises once. By reading |
| Store providers | `web/lib/store.ts:113-134` | neon, upstash, memory, file by `LABX_STORE` | Vercel refuses a non-persistent provider | Tests in `web/test/store.test.ts` |

## Findings

### Issue 1. The draw runner can send the same step twice (high, small amount)

Two sequences, one outcome: a second transaction for a step that already landed. A second `close`, draw request or
settle reverts on chain and costs its gas at up to the 50 gwei fee cap (a successful `close` used 34,698 gas on
Sepolia, and a reverting one uses less), and the run reports not ok. A second count batch continues from the real
position, or reverts when the count had already finished.

**1a. Read behind the runner's own confirmed send.**

1. The runner reads raffle 1 as Open and sends `close` at nonce 0. The receipt says succeeded.
2. The loop reads raffle 1 again (`web/lib/draw-runner/run.ts:156`). The answer comes from a node one block behind, as
   a load-balanced RPC can give, and still shows Open.
3. The pinned simulation and the estimate run against that same stale state and pass. The nonce read is fresh.
4. The runner sends `close` again at nonce 1.

- Test: "does not send %s again when the read after its confirmed send comes from a node one block behind"
  (`web/test/draw-runner.test.ts:985`), for `close` and for `snapshot`.
- Before, observed: sends were `1:close:0, 1:close:1, 1:snapshot:2, 1:requestRandomness:3, 2:settle:4`; for the count
  step `1:snapshot:0, 1:snapshot:1, 1:snapshot:2, 1:requestRandomness:3, 2:settle:4`.
- Fix: the loop keeps the step it saw confirmed and the count position (`lotCursor`) it was sent from
  (run.ts:152, 242). A read that calls for the same step from the same position ends that raffle for this run with a
  skipped item (run.ts:162). A confirmed step always changes the phase or moves the count on, so a real second batch
  never matches.
- After, observed: sends are `1:close:0, 2:settle:1`, items `1:close:succeeded, 1:close:skipped, 2:settle:succeeded`,
  report ok, and the next run sends the count and the draw request.

**1b. Pending transaction mined between the estimate and the nonce read.**

1. A previous run sent `close` at nonce 0 and it is still pending.
2. This run reads Open, simulates and estimates `close`. Both pass, because the pending one is not mined yet.
3. The pending `close` is mined.
4. The runner reads the nonces: latest 1, pending 1. Nothing looks pending, so it sends `close` at nonce 1.

- Test: "does not send the step again at the next nonce when its pending transaction is mined right after the estimate
  and fees %s" (`web/test/draw-runner.test.ts:1478`), with fees unchanged and risen.
- Before, observed: the run reported `sends: 1`, a `close` at nonce 1.
- Fix: the nonce is read before the estimate (run.ts:184). A transaction mined before both fails the estimate; one
  mined between them leaves the runner holding the old nonce, so it waits or its send fails on the nonce.
- After, observed: `sends: 0`, status `pending-transaction`, and the next run sends `snapshot:1,
  requestRandomness:2`.

### Issue 2. An unconfirmed replacement erases the record of the stuck transaction (medium)

1. The runner's `close` at nonce 0 is stuck: fees rose past its own. The record names its hash and fees.
2. The next run sends a replacement at nonce 0 with bumped fees. The request times out or the provider answers with an
   HTTP error, so the outcome is unknown and the node never saw it.
3. The runner overwrote `draw-runner:last-send` with the replacement's hash and fees.
4. Every later run asks the node whether it holds the recorded hash. It does not, so the runner waits. The transaction
   the node does hold is never replaced, and the runner sends nothing until fees fall or the operator steps in with
   the hot key. Draws can still be triggered by anyone on chain.

- Code: `web/lib/draw-runner/run.ts:221-227`.
- Test: "still replaces its stuck transaction after a replacement's broadcast never reached the node"
  (`web/test/draw-runner.test.ts:1491`).
- Before, observed: the third run returned `{ ok: false, status: "pending-transaction", sends: 0 }` while the node
  still held the first send.
- Fix: the record is written only when the node confirmed the send, or when the send was not a replacement
  (run.ts:223).
- After, observed: the third run replaces the original at 25 gwei with the tip bumped to 1.1 gwei and completes with
  three sends.

Accepted limit in the same machine, not fixed: a kill or store failure between the broadcast and the record write
leaves no record, so that transaction is waited for and never replaced. The window is one store write. Closing it
needs the hash before the broadcast, which means splitting `DrawChain.send` into sign and broadcast. Pinned by "waits
for a pending transaction whose record was never written" (`web/test/draw-runner.test.ts:1437`).

### Issue 3. A reservation dated ahead of the reader's clock is treated as expired (medium for alerts, low for receipts)

Both mail paths stamp a reservation with a clock reading and refused any reader whose own reading was earlier.

**Admin alerts** (`web/lib/notifications/delivery.ts:266`). The refusal writes a permanent reconciliation marker.

1. Two cron invocations overlap. Run A's server clock is 250 ms ahead of run B's.
2. A reserves the event with `createdAt` 5,250 and starts the provider request.
3. B reads the reservation at its own time 5,000, sees `now < createdAt`, and records `retry-window-ended`.
4. If A's request succeeds, A finds the marker and reports reconciliation too. The alert was mailed, but there is no
   acceptance record and the cron answers not ok. If A's request is not acknowledged, the alert is never sent.

- Tests: "retries a reservation written a moment ago by a server whose clock runs ahead"
  (`web/test/notification-delivery.test.ts:94`) and "delivers once and records acceptance when two overlapping runs'
  clocks disagree by a fraction of a second" (`web/test/notification-processor.test.ts:197`).
- Before, observed: `{ status: "reconciliation-required" }`, and in the processor test the stored marker
  `{"version":1,"reason":"retry-window-ended","recordedAt":5000}`.
- After, observed: both runs report accepted, one message key reached the provider, `K:accepted` is set and no
  reconciliation marker exists.

**Receipts** (`web/lib/receipt-delivery.ts:57, 84`). Here `now` is the time the request started, so no clock skew is
needed.

1. Request 1 starts at t. Request 2 for the same receipt and address starts at t + 40 ms and reserves first.
2. Request 1 reads a reservation dated t + 40 ms, later than its own t, and is refused with "Receipt delivery needs
   reconciliation; the safe retry window has ended." Private records show the address as unconfirmed for a reader with
   the earlier time.

- Test: "serves a request that started just before the overlapping request that reserved the receipt"
  (`web/test/receipt-agreement.test.ts:191`).
- Before, observed: status `unconfirmed`, and the request rejected with the reconciliation message.
- After, observed: status `pending`, then `{ delivered: true, repeated: false }` with one send.

Fix for both: a reservation dated up to one hour ahead is accepted (`CLOCK_SKEW_MS`, delivery.ts:12; `CLOCK_SKEW`,
receipt-delivery.ts:14). One hour is the margin the 23 h window already leaves inside the provider's 24 h retention, so
the design already assumes clocks agree that closely. The 23 h cutoff is unchanged, and a reservation dated further
ahead still needs reconciliation (tests "records reconciliation for a reservation dated more than an hour ahead of this
server's clock" and the second half of the receipt test).

## Status of D1 to D7

| ID | Earlier finding | Status at 2078b82 plus this branch | Proof |
|---|---|---|---|
| D1 | A notification on a page behind a pending page missed its retry window | Fixed in 972f46c and 450dee4: later non-terminal pages are searched each run | "retries a later page's failed event inside its window while an earlier page stays pending" and "reaches a later failed event %s pages past a page that stays pending, inside its window" (`web/test/notification-processor.test.ts:105, 151`) |
| D2 | A receipt sent to a mistyped address was bound for good | Fixed: three address slots per purchase | "lets the buyer correct the address, sending once to each address and to at most three" (`web/test/receipt-agreement.test.ts:107`) |
| D3 | An agreement signed by a Safe became invalid after an owner change and `/api/records` answered 503 | Read side fixed: shown as not recorded. Write side open and accepted: that wallet cannot record again for that raffle (section 8) | "leaves out a stored agreement its contract signer no longer validates and returns the other records" (`web/test/workflow-records.test.ts:83`) |
| D4 | A reserve request that never reached the server left Create asking for a recovery signature and getting 503 | Fixed: recovery answers 404 and the seller starts over | "reserve/preparation answers 404, so the seller starts over, when the server never saved that setup" (`web/test/workflow-route-failures.test.ts:195`) |
| D5 | An `ownerOf` revert answered 503 | Fixed: a revert or missing code answers 404; a node failure still answers 503 | "reserve answers 404 with a plain message, and saves nothing, when the NFT read %s" and "reserve answers 503, not a missing NFT, when the node fails the ownership read (%s)" (`web/test/workflow-route-failures.test.ts:185, 179`) |
| D6 | A shallow reorg of the activation block left the deployment reconciliation-required for good | Fixed: the boundary is re-anchored to the finalized block before anything is ingested | "reads and mails nothing before finality, then re-anchors a reorged activation block to the finalized block" and "recovers a deployment that an earlier build marked for activation reconciliation" (`web/test/notification-processor.test.ts:64, 89`) |
| D7 | The runner stalled on a stuck transaction | Mostly fixed in f767de7 by replacement. This branch fixes the hole in it (issue 2). One limit is accepted: a transaction whose record was never written is waited for | "replaces its own stuck transaction at the same nonce with bumped fees once suggested fees rise", "still replaces its stuck transaction after a replacement's broadcast never reached the node", "waits for a pending transaction whose record was never written" (`web/test/draw-runner.test.ts:1378, 1491, 1437`) |

## Suspicions not reproduced

These follow from reading the code. None was driven to an invalid state by a test, either because the trigger is an
RPC fault the fakes would only assume, or because it needs two independent faults.

1. Low-water mark and reorgs. The scan reads at the latest block (`web/lib/draw-runner/chain.ts:99`). If a block that
   settled or cancelled a raffle is dropped and that transaction never returns, the mark has already passed the raffle
   and the runner never reads it again. The transaction normally returns to the pool and is mined again.
2. Replacement that landed although unconfirmed. After issue 2's fix the record keeps naming the replaced transaction.
   If the replacement did reach the pool, the runner waits for it. It carries fees from that run, so it should be
   mined; it stalls only if fees more than double again.
3. Stale reads the estimate does not catch. If a node serves a stale state to the read, the simulation and the
   estimate while serving a fresh nonce, the runner sends a step another caller already took. Issue 1a covers only the
   runner's own confirmed step.
4. Lease split by clock skew. Two overlapping invocations on servers whose clocks differ by minutes can hold disjoint
   buckets. The nonce still allows one transaction per nonce.
5. Incomplete logs for a finalized range. Log reads are checked against canonical block hashes, not for completeness.
   A node that returns fewer logs without an error produces a permanent page without the event, and that alert is
   never sent.
6. Activation and verified hashes that disagree. If a node gives two overlapping runs different hashes for the same
   finalized block, the last activation write and the first verified write can differ, and every later run throws at
   `web/lib/notifications/processor.ts:151`.
7. Alert throughput after a long outage. Each run starts at most three sends. Events reserved during a provider outage
   share one 23 h window, so with more than about 36 pending events per remaining hour the last ones reach
   reconciliation unsent. Raffle creation and opening are far rarer than that today.
8. Receipt slots spent without mail. A slot is reserved before the send. Three failed attempts to three addresses
   leave the purchase full with nothing delivered.

## Ambiguities of intended behavior

1. Should a notification run whose sends were all unacknowledged answer ok? Today pending sends do not change the
   status (`web/lib/notifications/processor.ts:239-242`), so a provider outage is invisible in the cron answer for up
   to 23 h, after which the events become reconciliation-required.
2. Should an unacknowledged receipt or alert be retried after 23 h? Today it never is. A buyer whose first attempt
   failed and who comes back the next day cannot get the receipt at that address, only at another one. The cost of
   retrying would be a possible duplicate mail.
3. Should a changed sender address or site origin cancel pending alerts? Today the stored payload is not sent and the
   event becomes `payload-configuration-changed` for good (`web/lib/notifications/delivery.ts:139-141`), although the
   stored payload could still be sent under the same key.
4. Should the admin connection test be repeatable? Today one configuration sends one test mail ever, and a test left
   unacknowledged for 23 h can never be completed without changing the sender or the provider key.
5. Should a lagging node make the runner's report not ok? The fix for issue 1a reports a skipped item and keeps ok
   true, like a step another caller took.
6. Should the runner act on a raffle stuck in Drawing when the randomness never arrives? Today it has no step for
   phase 3.
7. Should `/api/agreements` and `/api/email/receipt` answer 503 for outages like the other signed routes? Today they
   answer 400 with a fixed message.
8. Is it intended that the same seller, NFT and texts always get the same commitment, including for a second raffle of
   the same NFT? The identity leaves out the deadline on purpose so retries recover the record
   (`web/lib/workflow-records.ts:23-24`), and the record is permanent, so the nonce and salt repeat.

## Test results

All commands ran in the worktree. The full suite and the type check ran at 3196610, the last code change on this
branch; the commit that adds this file changes no code.

| Check | Command | Result |
|---|---|---|
| Baseline at 2078b82 | `npx vitest run` in `web` | PASS: 75 files passed, 51 skipped; 1,263 tests passed, 369 skipped |
| Regression tests before each fix | `npx vitest run test/draw-runner.test.ts`, `test/notification-delivery.test.ts`, `test/notification-processor.test.ts`, `test/receipt-agreement.test.ts` | FAIL as expected: 5 runner cases (2 for 1a, 2 for 1b, 1 for issue 2), 2 delivery cases, 1 processor case, 1 receipt case |
| Full suite after the fixes | `npm --prefix web test` | PASS: 75 files passed, 51 skipped; 1,274 tests passed, 369 skipped |
| Types | `npx --prefix web tsc --noEmit -p web/tsconfig.json` from the repository root | PASS, exit 0 |
| Types, exactly as requested | `npx tsc --noEmit -p web/tsconfig.json` from the repository root | NOT_RUN as written: the root has no `node_modules`, so `npx` fetched an unrelated `tsc` package that exits 1 without compiling. The row above is the same check with the project's TypeScript |
| Opt-in lanes (integration, browser, fork: the 51 skipped files, 369 tests) | | NOT_RUN |
| Independent review of the candidate | | NOT_RUN in this slice |

The 11 new tests: six in `web/test/draw-runner.test.ts`, three in `web/test/notification-delivery.test.ts`, one in
`web/test/notification-processor.test.ts` and one in `web/test/receipt-agreement.test.ts`. Nine are regression tests
for the three issues; two pin accepted behavior (the unrecorded pending transaction, and acceptance winning over a
reconciliation marker).
