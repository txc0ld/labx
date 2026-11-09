# Frontend state consistency audit

Audited 10 November 2026 against `main` at `2078b82`. Fixes and tests are on branch `audit/frontend-consistency-20261110`. Code references use the tree after the fix commits `0999ecc` and `2c2f0d3`.

## Scope and method

The app has no accounts or sessions. The connected wallet address is the account, "logout" is a wallet disconnect, and "account switching" is a different connected address or chain. A deployment is one chain plus one raffle contract, so cached data can also cross a chain or contract boundary.

The audit covered every client component, hook and module under `web/app`, `web/components`, `web/hooks` and `web/lib` that holds user-visible data, plus the two server caches that feed them. The steps were:

1. Inventory every `localStorage` and `sessionStorage` use, every `fetch`, every module-level cache and every effect that reads the chain or an API route. The app has no SWR or react-query cache and no optimistic updates. A write is shown as done only after a receipt with two confirmations.
2. For each async read, check for a request identity or cancellation guard, a failure path that ends the loading state, and a key or reset that separates accounts, chains and contracts.
3. Treat a lead as a confirmed bug only when a deterministic test drove the real code through the sequence and failed. Leads that were not reproduced are under "Unverified suspicions". Behavior that may be intended is under "Ambiguities".
4. For each confirmed bug: write the test, record the failure, make the smallest fix, record the pass.

Component sequences run in a rendered browser on a local chain (`web/test/frontend-consistency.browser.test.ts`), because the repo has no DOM test environment for the default suite. The test holds, rewrites or aborts the page's JSON-RPC requests to produce late, out-of-order and failed reads. It is an opt-in lane, like the repo's other browser tests.

## Source of truth map

Abbreviations: "deployment scope" means the key contains chain ID, contract address and runtime code hash. "Wallet revision" is the counter on the wallet snapshot, which changes on every connect, disconnect, account change and chain change.

### Wallet and deployment

| Datum | Owner | Key or cache | Invalidation | Reconciliation | Code |
| --- | --- | --- | --- | --- | --- |
| Connected address, chain, revision | `WalletSession` instance in the browser service | In memory, one per page load | `accountsChanged`, `chainChanged`, `disconnect`, `session_delete`, Disconnect button; each first publishes a disconnected snapshot | `refresh()` reads `eth_chainId` and `eth_accounts`; a result is dropped if provider, epoch or revision changed while it was read | `web/lib/chain/wallet-session.ts:37`, `:69`, `:81` |
| Remembered wallet (auto-reconnect) | `BrowserWalletSession` | `localStorage` `labx:wallet-consent:v1:{origin}:{projectId}:{version:chain:contract:codehash}`, plus a per-tab `:revoked` marker in `sessionStorage` | Disconnect, a new Connect, a failed connect | `restore()` uses read-only calls and requires the saved account and chain to match the provider | `web/lib/chain/wallet-consent.ts:5`, `web/lib/chain/wallet-connectors.ts:167`, `:221` |
| Deployment (chain, contract, service) | Module singleton | `configured` variable, one per page load | Full reload only | Chosen from the reviewed registry by env; every read pins a block and checks the contract code hash | `web/lib/chain/browser.ts:24` |
| Wallet shown in the header and profile | `BenchProvider` | React state copied from the wallet snapshot | Wallet subscription | Same as the wallet snapshot | `web/lib/bench.tsx:136` |

### Raffles

| Datum | Owner | Key or cache | Invalidation | Reconciliation | Code |
| --- | --- | --- | --- | --- | --- |
| Explore catalog | `BenchProvider` | React state, one list per page load | Create confirmed in the seller studio, the Try again button, a new browser service | `generation` counter drops a superseded read; every page of one list is pinned to one block | `web/lib/bench.tsx:114`, `:123`, `:141` |
| Raffle detail (phase, packs, sold counts, deadlines) | `RaffleWorkspace` | React state scoped to service, wallet object and raffle ID | Route ID or service change, Refresh, a confirmed transaction, background re-read every 15 s while the page can change by itself | `request` counter drops a superseded refresh. After a confirmed transaction the read repeats until its block is at or after the confirmation (new). A background re-read applies only from a block at or after the shown one (new) | `web/components/workflow/RaffleWorkspace.tsx:101`, `:132`, `:166`, `:287` |
| This wallet's raffle account (memberships paid, USDC balance and allowance) | `LoadedRaffle` | React state | Any new raffle snapshot or wallet snapshot | Read at the snapshot's block; shown only when its raffle ID, block hash and account match the page | `web/components/workflow/RaffleWorkspace.tsx:232`, `:252` |
| Price quote | `BuyerActions` | React state | Pack, quantity, wallet revision or raffle snapshot change | `quoteRequest` counter. The quote repeats until its block is at or after the raffle shown (new) | `web/components/workflow/RaffleWorkspace.tsx:574`, `:584` |
| Agreement tick | `BuyerActions` | React state tagged with the account that ticked | Another account connects | Cleared with a notice when the account differs | `web/components/workflow/RaffleWorkspace.tsx:532` |
| Approval-to-purchase handoff | `BuyerActions` | React state `{order, revision, block}`, never stored | Fresh reads at or after the approval block, a failed read, a quote error, a wallet change, a changed order | The purchase opens once, only if the allowance read at or after the approval block covers the same order | `web/components/workflow/RaffleWorkspace.tsx:536`, `:636`, `:640` |
| Artwork, action trust check, reveal time, entry records | `RaffleArtwork`, `useActionTrust`, `useRevealTime`, `DrawProgress` | React state | Raffle snapshot change | Version counter or `active` flag per effect | `web/components/workflow/RaffleArtwork.tsx:18`, `web/components/workflow/useActionTrust.ts:12`, `web/components/workflow/useRevealTime.ts:21`, `web/components/workflow/DrawProgress.tsx:18` |
| Seller portfolio and revenue | `SellerDashboard` | React state | Wallet kind, account, chain or revision change; Create confirmed; Reload | `request` counter passed to the scan as `isCurrent`; one pinned block for all pages | `web/components/workflow/SellerDashboard.tsx:42`, `:59` |
| Sales and payouts list | `SellerActivity` | React state | Raffle ID, service or snapshot block change | `request` counter; a failed later page keeps its cursor and pinned block | `web/components/workflow/SellerActivity.tsx:20`, `:37` |
| Owner review queue and detail | `OwnerReviewQueue`, `OwnerReviewDetail` | React state | Wallet, service, route ID | `request` counters; detail waits for the newest approval block it has confirmed | `web/components/review/OwnerReview.tsx:68`, `:217`, `:302` |

### Transactions and recovery

| Datum | Owner | Key or cache | Invalidation | Reconciliation | Code |
| --- | --- | --- | --- | --- | --- |
| Pending transaction journal | `browserPendingJournal` | `localStorage` `labx:pending:v1:{chain}:{contract}:{codehash}:{account}`; cleared-send marker `labx:pending-cleared:v1:...`; Web Locks with the same names | Receipt confirmed, nonce proven spent or unsent, Continue | The chain decides: receipt for the saved hash, or the account's latest and pending nonces | `web/lib/chain/pending-journal.ts:58`, `:60` |
| Transaction outcomes (submitting, pending, confirmed, rejected) | `createTransactionOutcomes`, one per service | In memory `Map` by account; checkpoints in `localStorage` `labx:outcome:v1:{chain}:{contract}:{codehash}:{account}:{id}` | Acknowledge (Buy again, Dismiss), page reload rebuilds from checkpoints | A stored hash is only a hint; every outcome is rebuilt from a receipt | `web/lib/chain/transaction-outcomes.ts:40`, `:454` |
| Automatic check of a saved hash or hashless record | Module registries | `WeakMap` by outcome owner, entry key `{account}:{revision}:{hash}` or `{account}:{revision}:{id}:{nonce}` | Last component using the entry unmounts (the check stops; the last status stays in the entry) | Journal read before every step | `web/components/workflow/useTransactionOutcomes.ts:131`, `:145`, `:239`, `:259` |
| Transaction control state (review, confirming, receipt) | `TransactionFlow` | React state tagged with a scope number | Service, wallet object, wallet revision, action or resume hash change | `isCurrent` checked after every await | `web/components/workflow/TransactionFlow.tsx:208` |
| Resume panel (hash field, pending record, error) | `ResumeTransaction` | React state | Service, wallet object or wallet snapshot change | `generation` counter | `web/components/workflow/ResumeTransaction.tsx:57` |
| Create, Approve, List progress | `SellerDraftForm`, `CompleteCreate`, `create-flow` | `localStorage` `labx:create:v1:{chain}:{contract}:{codehash}:{seller}`, with `:raffle:{id}` and `:completed:{id}` records | Completed creation, Start over, a proven unsent or stale record | Storage generation captured at the click and asserted before every step; the chain decides what was sent | `web/lib/chain/create-flow.ts:14`, `web/components/workflow/SellerDraftForm.tsx:161`, `web/components/workflow/CompleteCreate.tsx:18` |
| Owner execution intent | `OwnerExecutionFlow` | `localStorage` `labx:owner-review:v1:{chain}:{contract}:{codehash}:{owner}:{id}` with `:manual-exposure`, `:handoff` and `:history:` records; Web Locks | Canonical discovery, cancel, a newer review | Component remounts on wallet, deployment or review identity change | `web/components/review/OwnerReview.tsx:419` |

### Account data from the API and from history

| Datum | Owner | Key or cache | Invalidation | Reconciliation | Code |
| --- | --- | --- | --- | --- | --- |
| Points balance | `ProfilePage` | React state tagged with the wallet it was read for; `GET /api/points?address=` | Wallet address change, Retry | Request counter plus `AbortController`; shown only when the tag equals the connected wallet | `web/app/profile/page.tsx:54`, `:92` |
| Account history | `AccountHistory` | React state | Service or wallet snapshot change | `request` counter; all pages of one load pinned to one block | `web/components/workflow/AccountHistory.tsx:32`, `:52` |
| "Your raffles" on the profile | `BuyerRaffles` | React state | Service or wallet snapshot change (state is dropped in the same render, new) | `request` counter | `web/components/workflow/BuyerRaffles.tsx:22`, `:27` |
| Purchases, receipts and agreements | `PrivateRecordsPanel` | React state; `POST /api/records` and `POST /api/email/receipt`, each signed by the wallet, `cache: "no-store"` | Service or wallet snapshot change | `request` counter, per-operation tokens, wallet session compared after every await | `web/components/workflow/PrivateRecordsPanel.tsx:62`, `:97`, `:120`, `web/lib/chain/api.ts:24` |
| Receipt email preference | `BenchProvider` | `localStorage` `labx-preferences-v1`, not scoped to a wallet | Save email | Read once at load, with migration from `labx-bench-v1` | `web/lib/bench.tsx:11`, `:146`, `:165` |
| Wallet NFT gallery | `SellerDraftForm`; server handler | Client React state; server in-memory cache `{chain}:{owner}:{cursor}` for 60 s | Wallet account, chain or revision change; Refresh; picker close | Generation counter plus `AbortController`; ownership is read on-chain again when an NFT is chosen | `web/components/workflow/SellerDraftForm.tsx:243`, `:299`, `:359`, `web/lib/wallet-nfts-server.ts:204` |

### Public feed and presentation

| Datum | Owner | Key or cache | Invalidation | Reconciliation | Code |
| --- | --- | --- | --- | --- | --- |
| Notification feed | `NotificationFeed`; server cache | React state; server `Map` `{cursor}:{limit}` for 60 s per process; HTTP `max-age=30` | Refresh, Load older | `generation` and `moreToken`; a refresh aborts a load of older items | `web/components/NotificationFeed.tsx:34`, `web/lib/notifications/public-feed.ts:100`, `web/lib/notifications/http.ts:32` |
| Unread dot and read watermark | `NotificationsBell` | `localStorage` `labx:notifications:read:{chain}:{contract}` | Bell click, Mark read, a 60 s poll | One request in flight; activity ordered by block and log index, so an older response cannot replace a newer read | `web/components/NotificationsBell.tsx:24`, `:118`, `:208` |
| Intro shown | `BrandSplash` | `sessionStorage` `labx:brand-intro:shown` and a module flag | Tab close | None needed | `web/components/BrandSplash.tsx:7`, `:19` |
| Banner on Explore and Profile | `BenchProvider` | React state | The next Load more (new); never for storage messages | None | `web/lib/bench.tsx:27`, `:127` |

Every storage key that holds transaction or recovery data includes the account and the deployment scope. The wallet consent and the notification watermark are scoped to the deployment only, which fits what they hold: one remembered wallet per deployment, and a public feed. The email preference and the intro flag have no scope.

## Scenarios exercised

"Browser" means a sequence in `web/test/frontend-consistency.browser.test.ts` or another named browser lane, run for this audit. "Unit" means the default suite.

| Scenario | How | Observed |
| --- | --- | --- |
| Re-read after a confirmed approval answered by a node behind the chain | Browser, `eth_getBlockByNumber("latest")` rewritten to the block before the approval | Before the fix: checkout stays on "Approved. Opening your purchase…" after the node catches up. After: the purchase opens, two wallet prompts in total |
| Only the price quote answered by a node behind the approval | Browser, "latest" rewritten only once the page shows the raffle at or after the approval | Before the fix: same waiting button with a current raffle. After: the purchase opens |
| Pack changed while the approval confirms, then a re-read from a node behind it | Browser | Before the fix: the page offers the approval again ("Your wallet asks twice"). After: the button is the purchase, two wallet prompts in total |
| Older background re-read finishes after a newer one | Browser, the older read's raffle call held through its 15 s timeout and retry | Before the fix: the page goes back from "Sales closed" to the open raffle. After: stays on "Sales closed" |
| Failed catalog page, then a successful retry | Browser, RPC aborted for one Load more | Before the fix: the error banner stays after the retry loads. After: cleared |
| Disconnect on the profile, then reload | Browser | Points and wallet clear at once, the wallet stays disconnected after reload. Before the fix: the raffles list shows the previous rows for one render next to "Connect your wallet" |
| History read for account A returns after switching to account B | Browser, A's `eth_getLogs` held | A's purchase never appears under B; switching back to A loads it. No defect |
| Wallet rejects a transaction | Browser, `buyer-ui-repairs` and the stale re-read sequence | "Cancelled in your wallet. Nothing was sent." and no success state. No defect |
| Delayed prepare from an old wallet session or an old route | Browser, `buyer-ui-repairs` | Dropped. No defect |
| Reload with a pending record, with and without a saved hash | Browser, `easy-buy`, `buyer-ui-repairs` | Settled from the chain; no pasted hash needed. No defect |
| Approval confirmed under a replaced wallet | Browser, `independent-buyer-state` | Not shown under the new wallet. No defect |
| Wallet restoration races, disconnect during restore, another tab revoking consent | Unit, `independent-appkit-restoration-race`, `wallet-restoration`, `independent-wallet-restoration-adversarial` | Pass |
| Silent account or chain drift without a wallet event | Unit, `wallet-session` | Caught on the next refresh. Pass |
| Notification read ordering across stale responses and tabs | Unit, `notification-unread` | Pass |
| Mainnet and Sepolia isolation of deployment data | Unit, `independent-mainnet-isolation`, `deployment-registry`; key review above | Pass |
| Chain switch in a rendered browser | Not exercised in a browser. Covered by `wallet-session` unit tests and by reading the gates | NOT_RUN in a browser |

## Confirmed bugs

Ordered by impact. Each was reproduced by a failing test before its fix. Bugs 1 and 2 share one cause: a load-balanced RPC can answer "latest" from a node behind the block that the page has just confirmed. The owner review page already guards against this (`readAdmissionFrom`, `web/components/review/OwnerReview.tsx:68`, added after it happened on Sepolia raffle 3). The raffle page did not.

### 1. Checkout waits forever after an approval when a read is behind the approval

Impact: a buyer who has approved USDC sees a disabled "Approved. Opening your purchase…" button that never changes. The second wallet prompt never opens. The only way out is the small Refresh link at the top of the page, which nothing points to. The same stale read after any other confirmed step showed the raffle from before the step, for example Buy again staying disabled or a seller seeing the step they had just completed.

Cause: the handoff waits for an account read and a quote at or after the approval block (`web/components/workflow/RaffleWorkspace.tsx:636`) and had no exit when every read had finished at an older block (`:640`). The raffle read and the quote are separate "latest" reads, so either can be behind. Background re-reads cannot help, because the waiting button marks the page busy.

Sequence, raffle read behind:
1. Open `/piece/{id}` for an open raffle with a wallet that has USDC and no allowance. Tick the agreement.
2. Press Buy. Approve in the wallet.
3. The approval gets its second confirmation while the RPC answers "latest" with the block before the approval.
4. The page shows "Approved. Opening your purchase…".
5. The node catches up. Nothing changes on the page.

Sequence, quote behind: steps 1 and 2 as above. The raffle re-read is current, and the quote that follows it is answered with the block before the approval. The page shows the raffle at the new block and the same waiting button, and stays there.

Fix: `readFromBlock` (`RaffleWorkspace.tsx:101`) repeats a read until its block is at or after a given block, five reads two seconds apart, the same rule as the owner review. `refresh` takes the confirmed block and keeps the highest one for the life of the route (`:125`, `:135`, `:154`), so Refresh and Try again wait for it too. Every confirmed transaction on the page passes its confirmation through `reload` (`:260`). The quote repeats until it is at or after the raffle shown (`:584`). After five reads behind, the raffle read ends in the page's existing "Couldn't update the raffle" error with Try again and paused actions, and the quote ends in the existing quote error. Neither shows the older state. No wallet prompt was added.

Tests:
- `frontend-consistency.test.ts`, "read after a confirmed transaction", four cases. Before: 4 failed (the helper did not exist). After: 4 passed.
- `frontend-consistency.browser.test.ts`, "opens the purchase after its approval when the first re-read comes from a node behind the approval". Before: failed, the "You're in" receipt did not appear within 30 s. After: passed, wallet requests were exactly `approve` then `buyPack`.
- `frontend-consistency.browser.test.ts`, "opens the purchase after its approval when only the price quote comes from a node behind the approval". Before (with the raffle read already fixed): failed the same way. After: passed.

### 2. A third wallet prompt when the pack changes while the approval confirms

Impact: the buyer is asked to approve again for an allowance they already hold, which breaks the rule of at most two wallet prompts for a purchase.

Cause: when the pack, quantity or payment changes while an approval is in the wallet or confirming, its control unmounts, and the page re-reads the wallet's allowance once when the approval confirms. That re-read did not carry the approval's block. A read from a node behind the approval showed no allowance, and the once-only claim meant nothing read again.

Sequence:
1. Open `/piece/{id}`, tick the agreement, press Buy and approve in the wallet.
2. While it confirms, choose another pack with the same or a lower total.
3. The approval confirms while the RPC answers "latest" with the block before it.
4. The page shows the approval step again with "Your wallet asks twice", and keeps it after the node catches up.

Code: `web/components/workflow/RaffleWorkspace.tsx:651` to `:659`.

Fix: the re-read passes the approval's receipt (`:656`), so it waits for the approval's block like every other confirmed step.

Test: `frontend-consistency.browser.test.ts`, "needs no second approval when the pack changes while the approval confirms and the re-read comes from a node behind it". Before: failed, the "Your wallet asks twice" hint was still shown 20 s after the node caught up. After: passed, wallet requests were exactly `approve` then `buyPack` for the second pack.

### 3. A slow background re-read can put an older raffle back

Impact: the raffle page can go back to a state the chain has left, for example from "Sales closed" to an open raffle with a Close sales button, until the next background re-read 15 seconds later. Acting on it fails at the wallet step's own check, so no wrong transaction is sent, but the page shows wrong counts and steps in between.

Cause: `poll` never claims a request version. Two re-reads overlap when the 15 s timer restarts while one is in flight, which happens when a wallet request starts and ends without a refresh (a rejection). Each read pins its block first, so the one that started earlier and finished later returns the older block, and it was applied.

Sequence:
1. Open `/piece/{id}` for a raffle past its deadline with entries. The page re-reads every 15 s.
2. A re-read starts and stalls after pinning its block (the read transport allows 15 s plus one retry).
3. Start a step such as Close sales and reject it in the wallet. The re-read timer restarts.
4. Someone else closes sales. The next re-read shows "Sales closed".
5. The stalled re-read returns. The page shows the raffle as open again.

Code: `web/components/workflow/RaffleWorkspace.tsx:166`, applied at `:176`; timer at `:287`.

Fix: a background re-read is applied only when its block number is at or after the shown snapshot's (`:176`).

Test: `frontend-consistency.browser.test.ts`, "keeps the newer raffle state when an older background read finishes after it". Before: failed, the "Sales closed" heading was gone after the older read returned. After: passed.

### 4. The catalog's load-more error never clears

Impact: after one failed "Load more raffles", the red banner "More raffles could not be loaded. Refresh and retry." stays for the rest of the session, after a retry has loaded the raffles, and it also shows on the Profile page, which reads the same banner. A failed action that later succeeded still reads as failed.

Cause: the banner lives in `BenchProvider` state. `clearBanner` exists but nothing calls it.

Sequence:
1. Open Explore with more than 12 raffles.
2. Press "Load more raffles" while the RPC is unreachable. The banner appears.
3. Press it again once the RPC is back. The raffles load. The banner stays.

Code: `web/lib/bench.tsx:123`, `:131`; shown at `web/components/workflow/LiveExplore.tsx:21` and `web/app/profile/page.tsx:114`.

Fix: starting a Load more clears that banner (`web/lib/bench.tsx:127`). Storage warnings in the same banner are left alone.

Test: `frontend-consistency.browser.test.ts`, "clears the load-more error once more raffles load". Before: failed, banner count 1. After: passed.

### 5. The previous account's raffles show for one render after a disconnect

Impact: on the Profile page, "Your raffles" shows the disconnected account's raffles next to "Connect your wallet to see your raffles." for one render. It is brief, but it is another account's data under a disconnected state, and the same render would show account A's rows under account B if the wallet reports a new account without a disconnect in between (`web/lib/chain/wallet-session.ts:91`).

Cause: the list is cleared in an effect, which runs after the render that already has the new wallet snapshot. The list has no wallet gate around it, unlike the history and receipts pages.

Sequence:
1. Open `/profile` with a wallet that holds a membership. Its raffle is listed.
2. Press Disconnect wallet.
3. The first render after the click contains both the raffle link and the connect message.

Code: `web/components/workflow/BuyerRaffles.tsx:48` (effect reset).

Fix: the list is dropped during the render in which the wallet snapshot changes (`BuyerRaffles.tsx:22`).

Test: `frontend-consistency.browser.test.ts`, "clears the account's data on disconnect and stays disconnected after a reload", which records any DOM state holding both. Before: failed, the state was recorded. After: passed.

## Unverified suspicions

Reasoned from the code and not reproduced by a test. None was changed.

1. One render of the previous account's data on a direct account change. `AccountHistory.tsx:52`, `PrivateRecordsPanel.tsx:85` and `SellerDashboard.tsx:60` clear in an effect, like bug 5. A wallet gate hides them while disconnected, so this needs the wallet to go from account A to account B in one snapshot (`wallet-session.ts:91`). The receipts page would show A's receipt recipients under B for that render.
2. A failed step on the receipts page discards receipts already signed for. A failed Load more or a rejected signature sets the error state (`PrivateRecordsPanel.tsx:75`, `:114`), and Retry starts from the newest purchases with nothing signed (`:157`).
3. The seller studio after Create on a lagging node. The portfolio scan reads "latest" (`SellerDashboard.tsx:42`) with no minimum block, so the new raffle could be missing until Reload. Account history and "Your raffles" read "latest" the same way after a purchase on another page.
4. A catalog refresh leaves the load-more banner. Fix 4 clears it on the next Load more only; `refreshCatalog` (`bench.tsx:114`) does not.
5. The bell's first fetch in development. React strict mode aborts the first request and the 60 s throttle then skips the second (`NotificationsBell.tsx:26`, `:29`). Production does not double-mount.
6. The "needs attention" status of an automatic hash check outlives its components. The registry entry keeps its last status after the last user unmounts (`useTransactionOutcomes.ts:160`), so a later page for the same wallet revision starts on the manual panel.
7. A quote that is retried after its inputs changed keeps reading. `readFromBlock` does not know its effect was superseded, so up to four more reads run before they are discarded (`RaffleWorkspace.tsx:584`). The result is dropped by the request counter; the cost is extra RPC reads while a node lags.

## Ambiguities

Behavior that may be intended. Each needs a product decision.

1. The receipt email is per browser, not per wallet (`bench.tsx:11`). After a wallet switch, receipts for the new wallet go to the email saved under the old one. The page says "Saved in this browser only", so this looks intended.
2. The Explore catalog is read once per page load (`bench.tsx:141`). Returning from a raffle after a purchase shows the old "left" counts and statuses until a reload.
3. After a failed Load more, account history, "Your raffles" and receipts replace the loaded list with an error (`AccountHistory.tsx:47`, `BuyerRaffles.tsx:43`, `PrivateRecordsPanel.tsx:75`). Sales and payouts keeps its list and cursor (`SellerActivity.tsx:37`).
4. A notification feed refresh replaces older pages already loaded with the first page (`NotificationFeed.tsx:69`).
5. One banner serves Explore and Profile, so a catalog error can show on the Profile page until the next Load more.
6. "Load more raffles" on Explore has no loading state (`LiveExplore.tsx:11`); a second click is ignored without feedback.
7. Points are read on wallet change and on Retry only, so a check-in elsewhere shows after a reload.

## Remaining gaps

- The default suite has no DOM environment. Bugs 2 to 5 are covered only by the opt-in browser lane. Bug 1 has unit coverage for its read rule.
- The browser fixture uses an injected local wallet. WalletConnect and AppKit sessions were covered by their existing unit tests, not driven in a browser here.
- Chain switching was not driven in a browser.
- `TransactionFlow`, the Create, Approve, List flow, the owner execution flow and wallet restoration were inventoried and their existing tests were run, but their state machines were not re-derived line by line. Their earlier fixes (PR #25) were checked by running the lanes listed below, not by new tests.
- The lag in bugs 1 and 2 was simulated by rewriting the "latest" block. No production RPC was called.

## Test results

Final code: `2c2f0d3`. Every opt-in lane was run alone with `--maxWorkers=1`, one dev server at a time.

### Default suite

| Command | Result |
| --- | --- |
| `npm --prefix web test` | PASS. 76 files passed, 52 skipped. 1267 tests passed, 376 skipped. Before the audit at `2078b82`: 75 files passed, 51 skipped, 1263 tests passed, 369 skipped |
| `cd web && npx tsc --noEmit -p tsconfig.json` | PASS, exit 0 |

The 52 skipped files are opt-in lanes that need an environment switch. Ten of them were run for this audit and are listed below. The other 42 are NOT_RUN, including the chain integration lanes (`RUN_CHAIN_INTEGRATION`), browser acceptance, the owner review and Safe lanes, and the Create race lanes.

### Opt-in browser lanes run

Each command is `RUN_...=1 npx vitest run test/<file> --maxWorkers=1` from `web`, with a local chain (anvil) and the contract artifacts built by `forge build`.

| Lane | Switch | Result on `2c2f0d3` |
| --- | --- | --- |
| `frontend-consistency.browser.test.ts` | `RUN_FRONTEND_CONSISTENCY_BROWSER` | PASS, 7 of 7 |
| `easy-buy.browser.test.ts` | `RUN_EASY_BUY_BROWSER` | PASS, 11 of 11 |
| `buyer-ui-repairs.browser.test.ts` | `RUN_BUYER_UI_REPAIRS_BROWSER` | PASS, 14 of 14 |
| `independent-buyer-state.browser.test.ts` | `RUN_INDEPENDENT_BUYER_STATE_BROWSER` | PASS, 2 of 2 |
| `seller-draw-runner.browser.test.ts` | `RUN_SELLER_DRAW_RUNNER_BROWSER` | PASS, 13 of 13, on the second run. On the first run all 13 tests passed and the suite failed in its `afterAll` hook, which timed out at 10 s while the machine was also running another project's tests |
| `private-record-feedback.browser.test.ts` | `RUN_PRIVATE_RECORDS_BROWSER` | PASS, 6 of 6, run twice |
| `seller-portal.browser.test.ts` | `RUN_SELLER_PORTAL_BROWSER` | PASS, 14 of 14 |
| `independent-transaction-outcomes.browser.test.ts` | `RUN_INDEPENDENT_TRANSACTION_OUTCOMES_BROWSER` | PASS, 11 of 11 |
| `wallet-restoration.browser.test.ts` | `RUN_WALLET_RESTORE_BROWSER` | PASS, 1 of 1 |
| `independent-wallet-restoration.browser.test.ts` | `RUN_INDEPENDENT_WALLET_RESTORE_BROWSER` | PASS, 1 of 1 |

The same nine existing lanes also passed on the first fix commit `0999ecc` (73 tests), before the second fix commit.

The `afterAll` timeout in the seller draw lane left its dev server and local chain running and its rewrite of `web/tsconfig.json` in place. Both processes were stopped, the file was restored from git, and the lane and the receipts lane that had overlapped the leftover server were run again. That hook's 10 s limit is in the existing test and was not changed.

### Failing runs recorded before each fix

| Run | Code | Result |
| --- | --- | --- |
| `frontend-consistency.browser.test.ts`, first five sequences | `2078b82` plus the tests | FAIL. 3 failed (lagging re-read, load-more banner, older background read), 2 passed |
| `frontend-consistency.test.ts` | `2078b82` plus the test | FAIL. 4 of 4 failed, the helper did not exist |
| Disconnect sequence with the render check | Fixes for bugs 1, 3 and 4 only | FAIL. 1 of 1 failed |
| Quote and pack-change sequences | `0999ecc` | FAIL. 2 of 2 failed |
