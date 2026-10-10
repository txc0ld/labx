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
2. **Key isolation.** The key comes only from the server-only `LABX_KEEPER_PRIVATE_KEY`. It never appears in a `NEXT_PUBLIC_*` variable, a response, a log or the store. A missing or malformed key returns 503 and sends nothing, which also serves as the kill switch.
3. **Privileged keys refused.** Before any work, the route builds a privileged set at one checked block and refuses with 503 if the runner address is in it. The set starts with the contract `owner`, `pendingOwner`, the manifest's expected owner, the on-chain `treasury` and the pinned treasury. For every member with code, it adds that Safe's `getOwners()` and `getModulesPaginated(0x...01, 50)`, then does the same once more for members of those lists that have code. Members found at that second level are listed but not expanded. If any read fails, a contract does not answer both Safe calls, or a module list does not end within one page, the route returns 503 and sends nothing. An EIP-7702 delegated account has code, so if one of these addresses is a delegated account that does not answer the Safe calls, the runner refuses to run until the delegation is removed.
4. **Authorization.** The same `Authorization: Bearer <CRON_SECRET>` check as the notification cron. It compares SHA-256 digests of the supplied and configured secrets with `timingSafeEqual`, so neither the content nor the length of the secret leaks through timing. A configured secret shorter than 16 characters counts as not configured, and both cron routes return 503.
5. **Deployment trust.** It runs only against the attested registered deployment from `serverWorkflow()`, never an arbitrary address.
6. **Bounded time.** The run deadline is 56 seconds after the request arrives. Setup, every chain read and every store read stop waiting 4 seconds before that deadline, so the cursor write (at most 2 seconds), the log line and the response always finish before 56 seconds. A send starts only with at least 25 seconds left. The broadcast waits at most 10 seconds, and the receipt wait ends at the same 4-second reserve.
7. **Bounded spending.** At most 6 broadcasts per run. A maximum fee of 50 gwei per gas stops the run. Each signed gas limit is the estimate plus a fifth, capped per call: 7,000,000 for `snapshot` and 400,000 for the others. A step above its cap is reported as `gas-cap` and nothing is sent. Before each send the runner requires a balance of at least gas limit times maximum fee, plus a tenth. A step it cannot afford is reported as `low-funds`, nothing is sent, and the run goes on to later raffles, which proceed only if they are affordable. Below 0.01 ETH the run reports `low-funds` and does nothing.
8. **No overlap.** An atomic store lease prevents two runs from sending at once (see "Lease rows" below). Nonces come from the pending nonce, and the runner waits behind any pending runner transaction. A failed or reverted send is reported and never retried within the same run.
9. **No stalls.** Every run re-reads chain state. A step that another caller took fails the pinned simulation, or later fails the gas estimate, and is reported as `skipped` with nothing sent; the run continues with the next raffle. When a step broadcasts nothing because of its gas cap or the balance, the run goes on to the next raffle. When a refused broadcast or a failed read or estimate stops the run, the saved cursor points past that raffle. Either way one stuck raffle cannot block the queue.
10. **Honest report.** The JSON response and the log line list each raffle, action, transaction hash, outcome and a fixed error label, with no secret material, error message or request body. Outcomes are `succeeded`, `reverted`, `unknown` (a hash exists but the result is uncertain: the node said "nonce too low" or "already known" or returned an error viem does not recognize, the broadcast or the receipt wait timed out, or the connection dropped; the run then stops behind it), `failed` (the node refused the broadcast for a recognized reason, or the estimate or a read failed, so nothing was broadcast), `skipped`, `low-funds` and `gas-cap`. `sends` counts only broadcasts that happened or may have happened. The error label is one of `InsufficientFunds`, `NonceTooLow`, `EstimateGasRevert`, `Timeout`, `Rpc` or `Other`, taken from the viem error classes in the cause chain, or null.

### Lease rows

The vercel.json schedule runs the route every five minutes on the clock. The lease key is the five-minute bucket of the run's start time, and a run also takes the next bucket's key when its 56-second deadline falls in that bucket. All keys go in one atomic `setIfAbsent`. Two runs that are active at the same instant both need that instant's bucket key, so only one of them can hold the lease. A unit test checks every pair of overlapping start times around a bucket boundary in 250 ms steps. A run that starts on schedule finishes inside its own bucket and writes one row. A run that starts in the last 56 seconds of a bucket writes two rows, and can block the next scheduled run if it starts within that window.

The store has no delete or expiry, so lease rows accumulate at about 288 a day, which is about 105,000 small rows a year (a key of about 30 bytes and an ISO timestamp). Follow-up: add a store delete or expiry, or a periodic maintenance job that removes `draw-runner:lease:` rows older than a day.

The file store lease is atomic only within one Node.js process, because it serializes writes with an in-process queue. Use it for local development only. Vercel requires a configured provider, and the Neon store's `setIfAbsent` is a single atomic insert.

### Checks

- `npm test` covers the decision table, the privileged set, the funding and gas rules, the time budget with fake timers, the error labels with a real viem HTTP transport, the lease boundaries and the bearer check.
- `RUN_DRAW_RUNNER_INTEGRATION=1 npm test -- test/draw-runner.integration.test.ts --maxWorkers=1` runs the route against a local anvil chain, including a runner that is the pending owner, a treasury Safe module, a treasury Safe signer or a module of a nested Safe, an estimate race and a low-balance run.
- `RUN_DRAW_RUNNER_FORK=1 npm test -- test/draw-runner.fork.test.ts --maxWorkers=1` starts a loopback anvil fork of Sepolia (upstream reads from `LABX_FORK_RPC_URL`, default the public Sepolia RPC) and checks that the runner sends nothing for the existing raffles and refuses the privileged cases. It sends nothing to Sepolia.

### Operations: turning the runner on and off

Measured gas per step on the local chain: `close` about 32,000, `snapshot(100)` about 4,900,000, `requestRandomness` about 160,000 and `settle` about 47,000. A full draw for a raffle with 100 entries costs about 5.1 million gas. Before each send the runner needs the full gas limit at the current maximum fee in its balance, which for one `snapshot` at 50 gwei is about 0.32 ETH.

To turn it on:

1. In your own wallet app, create a new account to use only as the LABx draw runner on Sepolia. Do not reuse an account that owns, signs for, or is a module of the LABx owner Safe or the treasury; the runner refuses to start with such a key.
2. Send it about 0.5 Sepolia ETH from a faucet or from another of your accounts.
3. In the wallet app, export the new account's private key. In Vercel, open the project, then Settings, then Environment Variables. Add `LABX_KEEPER_PRIVATE_KEY` with that key, for the Production environment only, and mark it Sensitive. Do not paste the key anywhere else.
4. In the same place, add `NEXT_PUBLIC_LABX_DRAW_RUNNER` with the value `1` for Production. Check that `CRON_SECRET` is set and at least 16 characters long.
5. Redeploy Production, because environment variable changes apply only to new deployments.
6. After the next five-minute mark, open the project's Logs in Vercel and filter by `/api/cron/draw`. The `draw-runner` log line shows the status, the number of sends and each item. `complete` with no items means there was nothing to do. A 503 response means the key is missing, invalid or privileged, or the deployment could not be checked.

Top up the wallet when a run reports `low-funds`.

To turn it off, delete `LABX_KEEPER_PRIVATE_KEY` from the Vercel Production environment and redeploy. The route then returns 503 and sends nothing. Also delete `NEXT_PUBLIC_LABX_DRAW_RUNNER` before that redeploy if sellers should see the manual buttons again.

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
