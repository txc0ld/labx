# Draw runner and one-click seller finish steps, 2026-10-10

## Decision

On 2026-10-10 the user chose that LABx runs the draw steps after sales close. A seller then only confirms the draw and claims. The user also chose one-click seller finish steps. They did not choose one-click Buy, signing the agreement less often, or plain-language signed messages. The buyer flow keeps its current steps.

Risk tier: R3 for the runner, which signs from a server wallet, and R2 for the finish steps, which group wallet requests behind one click. Both need explicit invariants, independent behavioral verification and a fresh review. Production enablement needs the user to create and fund the runner wallet and set its key through their secure flow. No agent generates, reads or stores that key.

## Draw runner

A scheduled route, `GET /api/cron/draw`, runs every five minutes. It sends only these permissionless calls on the registered v3 deployment:

| Raffle state (re-read each run) | Call |
| --- | --- |
| Open, at or after `salesEnd`, at least one lot, before `salesEnd + DRAW_START_GRACE` | `close(id)` |
| Closed, not snapshotted, before the draw-start deadline | `snapshot(id, 100)`, repeated while time allows |
| Closed, snapshotted, `snapshotTotal > 0`, before the draw-start deadline | `requestRandomness(id)` |
| Drawn, and revealed or at or after `drawnAt + REVEAL_GRACE` | `settle(id)` |

The runner does not act on empty raffles, cancellations, claims, reveals, refunds, fee collection or anything owner-only.

### Invariants

1. **Authority.** The runner calls only `close`, `snapshot`, `requestRandomness` and `settle`. It decides with the same `availableActions` logic the website uses, builds calldata with the existing action builder, and simulates against a pinned block before every send. Each send has zero ETH value.
2. **Key isolation.** The key comes only from the server-only `LABX_KEEPER_PRIVATE_KEY`. It never appears in a `NEXT_PUBLIC_*` variable, a response, a log or the store. The route refuses to run if the derived address is the contract owner, the pinned treasury, or an owner of the Safe. A missing or malformed key returns 503 and sends nothing, which also serves as the kill switch.
3. **Authorization.** The same `Authorization: Bearer <CRON_SECRET>` check as the notification cron, with a constant-time comparison.
4. **Deployment trust.** It runs only against the attested registered deployment from `serverWorkflow()`, never an arbitrary address.
5. **Bounded work.** There is a 56-second internal deadline, at most 6 sends per run, a fixed maximum fee per gas, and a minimum runner balance below which it reports `low-funds` and sends nothing. Raffle scanning is bounded and resumable.
6. **No overlap.** An atomic store lease (`setIfAbsent` on a time-bucket key) prevents two runs from sending at once. Nonces come from the pending nonce. A failed or reverted send is reported and never blindly retried within the same run.
7. **Idempotent.** Every run re-reads chain state. A step that another caller already performed fails simulation and is skipped, and nothing is sent.
8. **Honest report.** The JSON response and the log line list each raffle, action, transaction hash and outcome, with no secret material.

### User-visible effect

When `NEXT_PUBLIC_LABX_DRAW_RUNNER=1` is set (a non-secret flag the user sets together with the key), the seller page shows "LABx closes sales and starts the draw automatically. This usually takes a few minutes." It does not ask the seller to close, count entries, start the draw or finish the raffle. The manual buttons stay available in a closed "Run it yourself" disclosure in case the runner is down. Without the flag, the page behaves as before.

## One-click seller finish steps

- **Confirm the draw.** One click asks the wallet for the draw-setup signature, then prepares the `reveal` call and sends it straight to the wallet, with no extra website screen. A rejected or failed step stops and leaves the step available to retry.
- **Cancel and get NFT back.** For an expired raffle with no memberships, one click sends `cancel`. It waits for canonical confirmation, then prepares `reclaimPrize` freshly and sends it. If the second request is rejected, the page shows Reclaim NFT as the next step, based on chain state.

### Invariants

1. Every request still goes through `service.prepare`, `service.submit` and `service.confirm`, so the journal, Web Locks, exact-intent checks and recovery are unchanged.
2. The second request is prepared only after the first is canonically confirmed. A rejection, revert or ambiguity stops the sequence.
3. A reload never continues a sequence automatically. The page shows the state-based next step, which the seller presses again.
4. Each request remains a separate wallet confirmation. Nothing is batched into one signature.
