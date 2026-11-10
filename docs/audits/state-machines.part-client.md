# Client state machines (10 Nov 2026, main 54f317e)

This part covers everything that runs in the browser: the modules under `web/lib/chain` that a page calls and the
components under `web/components`. The contracts and the server are in the other parts.

It builds on the audit of 7 Nov 2026 (`docs/build/implicit-state-machines-20261107.md`, defect IDs A1 to A5, B1 to B7
and C1 to C6), on commit 972f46c, which fixed the verified ones, and on `docs/audits/frontend-consistency.md`, whose
fixed bugs are not repeated here. Section "Status of A1 to A5, B1 to B7 and C1 to C6" says what is fixed, open or
accepted.

## How to read this

A lead counts as a confirmed bug only when a test drove the real module or the rendered page through the sequence and
observed the invalid state. Each confirmed bug has a regression test that failed before its fix and passes after it.
Claims marked "by reading" were not executed.

The environment these machines run in:

- State lives in three places. React state and refs die with the component or the tab. Module singletons (the outcome
  owner, the check registries, the AppKit runtime, the wallet session) live until the page reloads and survive
  client-side navigation. `localStorage` is shared by every tab of the origin and survives reloads; every key that
  holds transaction or recovery data includes the chain, the contract, its runtime code hash and the account.
- Web Locks serialize tabs. A lock is released when its tab closes, so a lock is never left held by a dead tab.
- The wallet is outside LABx's control. It can answer a request with a hash, a rejection, an error that says nothing,
  nothing at all, or a hash it later replaces. It can also send through its own RPC, which LABx's RPC may see late.
- The read RPC is load balanced. A read of "latest" can come from a node behind a transaction the page has just
  confirmed, and a pending-nonce read can miss a transaction another node holds.
- A receipt counts once it is two blocks deep (`RECEIPT_CONFIRMATIONS`, `web/lib/chain/service.ts:35`). That is
  progress, not finality.

Events considered for every deep machine: reload and tab close at each step, two tabs of the same account, an account
or chain switch mid-flow, a wallet rejection, a wallet that returns no hash, a wallet error with a bare -32603 or
-32000 code, an RPC that lags or fails, a dropped or replaced transaction, a reorg, `localStorage` unavailable or full,
and Web Locks unavailable.

Line numbers refer to the tree at 9032cdd, the last code change on this branch.

## Summary of confirmed findings

| # | Severity | Finding | Fixed in |
|---|---|---|---|
| 1 | high (narrow trigger, costs gas and leaves a second draft) | After a wallet error that only a -32603 or -32000 code marked as unsent, Create forgot the draft step's nonce. When the wallet had in fact sent the draft, a later Create sent `createRaffle` again | 3bc0972 |
| 2a | medium | A send that outlasted its first one-minute watch and was then replaced or dropped by the wallet left its control on "Still confirming" for good, and the page kept showing the state from before a replacement that had landed | 8bf7034, 9032cdd |
| 2b | low | The same control stayed on "Still confirming" when another tab of the same wallet confirmed the transaction first | 8bf7034 |

Severity scale, as in the earlier audit: high means a duplicate or unrequested transaction, or money at risk; medium
means a user is stuck until support or a reload; low means extra clicks or cosmetic.

No reachable invalid state was found in the pending journal itself, the outcome owner, the buyer's approve-then-buy
handoff, the owner Safe flow or the wallet connection machines. The leads that were not reproduced are under
"Suspicions not reproduced".

## 1. Pending-send journal and settlement

Code: `web/lib/chain/pending-journal.ts`, `web/lib/chain/service.ts:128-297, 379-483`,
`web/lib/chain/wallet-session.ts:121-136`, `web/lib/chain/wallet-errors.ts`, `web/lib/chain/network-fee.ts`.

### States

One machine per account and deployment. It is encoded by:

| Part | Encoding | Ref |
|---|---|---|
| Record R | `localStorage` `labx:pending:v1:{chain}:{contract}:{codehash}:{account}` holding `{ id, intentHash, nonce, startedBlock, hash }`, `hash` null until the wallet returns one | pending-journal.ts:5, 58-59, 66-68 |
| Marker M | `labx:pending-cleared:v1:{chain}:{contract}:{codehash}:{account}` holding `{ nonce, startedBlock }`: the last record cleared without proof that nothing was sent. An unreadable marker reads as nonce -1 | pending-journal.ts:7, 25-32, 60, 69-74 |
| Journal lock X | Web Lock named by the record key | pending-journal.ts:75 |
| Request lock Q | Web Lock `{record key}:request`, held while a wallet request for the account is open in any tab | pending-journal.ts:76-87 |
| In-tab guards | `submitting` set by account, and the `used` flag of the reviewed action | service.ts:45-46, 144-145, 233 |
| Chain verdict for the record's nonce N | From the latest nonce L, the pending nonce P and the head: unsent (L = N, P = N), expired (unsent for 25 blocks from `startedBlock`), spent (L > N, P = L, and the nonce at the block below the head equals L), otherwise waiting | service.ts:243-254 |

| State | Encoding |
|---|---|
| J0 idle | no R, no M |
| J0m idle, marker | no R, M present |
| J1 requesting | R with `hash` null and Q held: a wallet prompt is open in some tab |
| J2 hashless | R with `hash` null and Q free: the wallet answered without a usable hash, or the tab reloaded or closed |
| J3 hashed | R with a hash the chain knows, pending or mined less than two deep |
| J4 orphaned | R with a hash the chain no longer knows: the wallet replaced or dropped it |

### Invariants

- J-I1. At most one record per account and deployment. A send does not start while a record exists
  (service.ts:144, 173) or while any tab holds Q (service.ts:147, pending-journal.ts:78-79).
- J-I2. The record is written under X before the provider is called, after the session was checked again
  (wallet-session.ts:126-134, service.ts:171-177). If the write fails, nothing is dispatched.
- J-I3. A record is removed only by: its own request when the wallet refused or was never asked (service.ts:190-199);
  a wallet failure that is pre-broadcast evidence with nothing at N (service.ts:203-227); a canonical receipt at its
  nonce or for the hash the wallet returned (service.ts:403-416); or `settlePending`, when N is spent, or nothing is at
  N and the person chose Continue (hashless only) or 25 blocks passed (service.ts:260-285).
- J-I4. Every removal without proof that nothing was sent (Continue, the 25-block clear, the code-only retirement)
  writes M first (service.ts:222, 281). M goes only when a mined nonce has passed it (service.ts:163-166), a receipt
  landed at its nonce (service.ts:415) or `settleCheckpoint` saw that nonce spent (service.ts:294).
- J-I5. With M present and P above M's nonce, no wallet request opens (service.ts:162-168).
- J-I6. No tab settles a record from the chain while a wallet request for that account is open in any tab
  (service.ts:266, 271, 291).
- J-I7. Every send carries the pending nonce read just before it (service.ts:158, 170). Two sends LABx makes for one
  intent around a cleared record therefore share a nonce while that nonce is unused, and a wallet that honors the
  nonce mines one of them. This does not hold once the first send's nonce is used and its result is not found: the
  Create recovery then sends at the next nonce (open issue 3).
- J-I8. The service tells a caller that its send was not dispatched, so the caller may drop its own checkpoint, only
  when the wallet refused, was never asked, or its own message says it sent nothing (service.ts:196, 223). Before
  3bc0972 it also did so after a code-only failure. Finding 1.

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| J0, J0m | submit | review unused, session current, account has no contract code, no R | continues below | service.ts:133-147 |
| J0, J0m | submit | another tab holds Q | unchanged, "Your wallet already has a request from LABx open"; the review is spent | pending-journal.ts:78-79 |
| J0, J0m | submit | gas × 1.5 × max fee + value above the balance, or the estimate fails | unchanged, `NotSentError`, wallet not opened | service.ts:157, network-fee.ts:33-43 |
| J0m | submit | P above M's nonce and L above it | J0, `EarlierSendError`, wallet not opened | service.ts:162-167 |
| J0m | submit | P above M's nonce, L not above it | J0m, `EarlierSendError` | service.ts:162-167 |
| J0m | submit | P not above M's nonce | J1 at nonce P | service.ts:162, 170 |
| J0, J0m | wallet request | record written, session still current | J1 | service.ts:171-178 |
| J1 | account or chain changes before the provider call | | J0 or J0m, not dispatched | wallet-session.ts:127-129, service.ts:191-199 |
| J1 | wallet returns a hash | | J3 | service.ts:179-188 |
| J1 | wallet rejects (4001 or 5000) | no hash was returned | J0 or J0m | service.ts:190-199 |
| J1 | wallet error whose message names a pre-broadcast cause | nothing at N | J0 or J0m, `NotSentError` | service.ts:203-229 |
| J1 | wallet error with only a -32603 or -32000 code | nothing at N on three reads over four seconds | J0m, `NotSentError`; the caller keeps its checkpoint | service.ts:210-225 |
| J1 | same | something at N on any read, or a read fails | J2, "The wallet response is uncertain" | service.ts:211, 217, 227, 230 |
| J1 | wallet returns no valid hash, or any other error | | J2 | wallet-session.ts:135, service.ts:230 |
| J1 | reload or tab close | | J2, the browser releases Q | |
| J1 | wallet never answers | | J1 until that tab reloads or closes | service.ts:266-271 |
| J2 | settlePending | Q held anywhere | J2, waiting | service.ts:271 |
| J2 | settlePending | waiting, or unsent without Continue | J2 | service.ts:277 |
| J2 | settlePending with Continue | unsent | J0m, dropped | service.ts:277-283 |
| J2 | settlePending | expired | J0m, dropped | service.ts:277-283 |
| J2 | settlePending | spent | J0 or J0m (M untouched), spent | service.ts:281-283 |
| J2 | a hash is entered (resume) | the transaction is from this account, at N, mined not before `startedBlock` | J3 | service.ts:425-449 |
| J3 | confirm | receipt two deep at N, or for the returned hash | J0; M removed when it is at that nonce | service.ts:401-416 |
| J3 | confirm | the returned hash sits at another nonce | J3 with the record moved to that nonce | service.ts:392-396 |
| J3 | confirm times out | | J3 | service.ts:421 |
| J3 | replaced while the page watches | viem returns the replacement's receipt | J0, outcome confirmed (same call) or replaced | service.ts:401-419 |
| J3 | replaced or dropped while nothing watches | | J4 | service.ts:256-259 |
| J4 | settlePending | spent | J0 or J0m (M untouched) | service.ts:274-283 |
| J4 | settlePending | expired | J0m | service.ts:277-283 |
| J4 | settlePending | unsent, with or without Continue | J4 | service.ts:277 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload or close before the provider call | The record may exist with no request. The page shows "Your wallet didn't send your last transaction" with Continue, or clears it after 25 blocks | safe |
| Reload or close with the wallet prompt open | J2. If the person then approves the old prompt, the nonce shows it and the record waits, then clears as spent. If they choose Continue first, M makes the next send stop once the old one is visible, and a send before that reuses N | safe for a wallet that honors the nonce; see the accepted limit under A3 |
| Reload or close while confirming | J3 with an outcome checkpoint. The saved-hash check settles it by receipt | safe |
| Two tabs | One record, written under X. The second tab's send is refused by the record or by Q. Neither tab settles while Q is held | safe. Tests: "allows only one provider request across two service instances sharing one journal" (`web/test/independent-pending-journal.test.ts:63`), "waits while another tab has a wallet request open" (`web/test/pending-send.test.ts:219`) |
| Account or chain switch | The session check before the provider call fails and the record is removed. After the call, the record stays under the old account's key | safe. Test: "does not invoke the provider if %s changes while journal acquisition waits" (`web/test/wallet-session.test.ts:31`) |
| Wallet returns no hash | J2. Settled from the nonces without a pasted hash | safe |
| Bare -32603 or -32000 | Three quiet nonce reads over four seconds, then J0m | safe for buys by J-I5 and J-I7. For Create see finding 1 |
| RPC lags on the pending nonce | The record can clear as unsent while the wallet's send is in flight. M and the shared nonce cover it | safe for a wallet that honors the nonce |
| RPC fails | Reads throw. A nonce read that fails keeps the record (service.ts:227). The page reports "Can't reach the network" after two failures | safe |
| Dropped transaction | J4, cleared after 25 blocks with nothing at N, with M | safe |
| Replaced transaction | J4, cleared once N is spent two deep | safe for the journal. For the page see finding 2 |
| Reorg | A receipt needs its block hash to match and two confirmations (service.ts:312-325). A reorg deeper than that after a clear returns the transaction to the pool at the same nonce | safe by reading |
| `localStorage` or Web Locks unavailable | Every journal call throws "Safe transaction recovery requires browser storage and Web Locks" (pending-journal.ts:61-64). Nothing can be sent | safe. Test: "fails closed when Web Locks or durable storage are unavailable" (`web/test/pending-journal.test.ts:31`) |
| `localStorage` full | The record write throws or reads back differently (pending-journal.ts:67). Not dispatched | safe. Test: "fails closed on storage failure before the provider request and permits a fresh reviewed retry" (`web/test/independent-pending-journal.test.ts:89`) |

### Illegal combinations checked

| Combination | Result |
|---|---|
| Two records for one account | Unreachable: one key, written only under X after reading it empty (service.ts:173) |
| A wallet request open with no record | Unreachable: J-I2. Test: "sends nothing when durable coordinator storage fails before submission" (`web/test/independent-three-action-create-flow.test.ts:379`) |
| A record removed while its request is open | Unreachable: J-I6 |
| A record cleared while the chain still knows its hash | Unreachable: `settlePending` returns waiting first (service.ts:273). Test: "leaves a hash the chain still knows to its receipt check" (`web/test/pending-send.test.ts:243`) |
| A record cleared by Continue although it holds a hash | Unreachable: service.ts:277. Test: "clears a dropped send only after 25 blocks with nothing at its nonce, never on Continue" (`web/test/pending-send.test.ts:271`) |
| A second wallet request at a later nonce for an intent whose first request may still land | Unreachable for a buy while M stands (J-I5). Reachable for Create before 3bc0972: finding 1 |
| A record that waits forever | Reachable by design when an earlier nonce of the account was dropped from the pool (L below N for good). Pinned by "keeps the record and waits when %s, even on Continue and after 25 blocks" (`web/test/pending-send.test.ts:105`). See ambiguities |
| A marker that outlives what it protects | Reachable, low: a record at M's nonce that later clears as spent through `settlePending` leaves M, so the next send stops once with the earlier-request line. By reading. See ambiguities |

## 2. Transaction outcome ownership

Code: `web/lib/chain/transaction-outcomes.ts`. One owner per service (`transactionOutcomes`, lines 454-459), so one per
page load.

### States

Rows live in memory, per account (`records`, line 42). Each row has an operation id and one kind:

| Row kind | Meaning | Ref |
|---|---|---|
| submitting | This tab's wallet request is open; id `request-N` | 339-340 |
| rejected | The wallet refused; history only | 356 |
| error, `submitted` null | The wallet's answer was uncertain, or storage failed (id `storage-error`) | 189, 357 |
| checking | This tab is watching the hash | 319, 345 |
| pending | The first watch ended without a receipt | 325 |
| error, with `submitted` | The watch itself failed | 328 |
| recovery | A saved checkpoint not yet inspected | 170-171 |
| unverified | An inspected hash without a canonical receipt yet | 218, 229, 246 |
| terminal | A canonical receipt: confirmed, reverted or replaced | 192-199 |
| overflow | More than 100 saved checkpoints | 180 |

Around the rows: `localStorage` checkpoints `labx:outcome:v1:{chain}:{contract}:{codehash}:{account}:{id}` holding a
hash (lines 40, 57, 105-113); `acknowledged` ids (44); `redirects` from superseded ids (46); `verified` hashes with
their nonce and observed transaction (48); journal `lineages` (49); in-flight maps `checking`, `inspections` and
`recoveries` (45, 47); the per-account `submitting` set (43).

### Invariants

- O-I1. One row per operation id. A terminal row is never replaced (line 99) and an acknowledged id never returns
  (line 98).
- O-I2. A row is terminal only from a receipt the service validated: block hash, two confirmations, sender, nonce
  (service.ts:312-325).
- O-I3. One wallet request per account at a time in a tab (line 337), one watch per hash (303-304), one inspection per
  hash (201-202), one recovery job per account (255-256).
- O-I4. A saved hash is only a hint. After a reload every row starts as recovery and is rebuilt from the chain
  (173-191, 254-270).
- O-I5. A terminal outcome belongs to a submission only when both hashes were verified at the same nonce and resolve
  to the same operation (391-401). Only then does a control report its own action as done.
- O-I6. A checkpoint is removed only by acknowledging its exact terminal row (402-425) or, with its unfinished rows,
  under the journal lock when the journal record with that hash is cleared from the nonces (432-448).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| none | submit | no submit in flight for the account | submitting | 337-340 |
| submitting | wallet returns a hash | | checking, with a checkpoint once the transaction is seen on chain | 343-347, 316-319 |
| submitting | wallet rejects | | rejected | 355-356 |
| submitting | nothing was sent | `NotSentError` | row removed; `earlierSends` counted for an `EarlierSendError` | 349-354 |
| submitting | any other failure | | error without a hash | 357 |
| checking | receipt | | terminal | 324-326 |
| checking | watch times out | | pending | 325 |
| checking | watch fails | | error with the submission | 328 |
| pending, error, unverified | resume or automatic check | journal record present | checking, then as above | 360-390 |
| pending, unverified, recovery | resume or recovery | no journal record | terminal, or unverified | 200-253, 371 |
| none | reload, storage event or focus | a saved checkpoint | recovery, then inspected | 173-191, 271-290 |
| any row with hash H, not terminal | `settlePending` clears the record holding H | the row's verified nonce is the record's | removed with its checkpoints | 432-448 |
| terminal | acknowledge (Buy again, Dismiss) | wallet session unchanged, no journal record at or below its nonce | removed, id acknowledged | 402-425, service.ts:469-477 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload | Rows are rebuilt from checkpoints as recovery and inspected two at a time | safe |
| Tab close during a watch | The checkpoint and the journal record stay. The next page settles them | safe |
| Two tabs | Each tab has its own rows over shared checkpoints. A storage event or window focus rescans. Either tab may confirm; the other finds the journal empty and retains the same receipt | safe. Tests: "synchronizes another tab's canonical replacement and ignores the old watcher's late result" (`web/test/transaction-outcomes.test.ts:385`), "retains local terminal receipts after remote acknowledgment until an explicit local acknowledgment" (`:406`). For the control that sent it see finding 2b |
| Account switch | Rows are per account. A resume started under one session is refused after the switch (`assertScope`, 365-369) | safe. Test: "does not resume after the pending read changes wallet session" (`:328`) |
| Wallet rejection | rejected row, no hash invented | safe. Test: "preserves a direct numeric %s rejection without inventing a submitted hash" (`:204`) |
| No hash, uncertain error | error row without a hash; hidden behind the journal panel until the journal is clear | safe |
| RPC fails during a watch | error row with the submission. The saved-hash check hands it to the person ("Your transaction needs a check") | safe, one click |
| Replaced transaction | While watched: terminal confirmed or replaced, the old hash redirected to it. Unwatched: the journal settles from the nonces and the rows of the old hash are removed | safe |
| Reorg | A receipt whose block changed fails validation and the row stays unverified until a later check | safe by reading |
| Storage unavailable, malformed or above 10,000 keys | A `storage-error` row blocks new actions until storage reads clean again (173-191) | safe. Tests: "rejects malformed or oversized checkpoint storage without treating any record as success" (`:171`), "removes its storage-error row once storage reads clean again" (`:470`) |
| Storage full | The checkpoint write throws before the journal is touched | safe. Test: "leaves the service journal untouched when checkpoint storage fails" (`:146`) |

### Illegal combinations checked

| Combination | Result |
|---|---|
| Two rows for one hash | Unreachable: `operationId` reuses the owning row (87-93) and `retain` merges rows of the same nonce (124-146). Test: "links distinct same-nonce hashes, keeps one canonical hint and automatically recovers cancellation after reload" (`web/test/transaction-outcomes.test.ts:221`) |
| A terminal row replaced by a late pending or error result | Unreachable: line 99 and `finish` (308-314). Test: "does not resurrect an acknowledged operation when an old attempt returns %s" (`:250`) |
| A purchase shown as done from a hash alone | Unreachable: O-I2, O-I4. Test: "hydrates only unverified hashes, survives owner recreation and requires service revalidation" (`:154`) |
| A control claiming another transaction's receipt as its own | Unreachable: O-I5. Test: "does not authorize a same-intent historical receipt from another nonce or a forged pointer as its own submission" (`:573`) |
| A row left for a hash whose record another tab cleared from the nonces | Reachable by reading: the other tab removes the shared checkpoints, and this tab's unverified row stays and keeps new actions paused until a reload. The existing test "keeps deleted unknown saved activity blocking and never persists unowned unknown input" (`:430`) pins that a removed checkpoint does not release a row. See ambiguities |

## 3. TransactionFlow

Code: `web/components/workflow/TransactionFlow.tsx`. One instance per action control.

### States

`TransactionState` (lines 15-30), tagged with a scope number (150-151). The scope is a generation that changes when
the service, the wallet object, the wallet revision, the action or the resume hash changes (145-149); state from
another scope reads as idle.

| State | Encoding | Shown |
|---|---|---|
| idle | `{ kind: "idle" }` | the action button |
| preparing | operation claimed (`operation` ref, 164, 195-200) | "Preparing…" |
| review | prepared action | review with Confirm and Back |
| submitting | prepared action, wallet request open | "Waiting for wallet…" |
| confirming | own submission (`ownSubmission` ref, 169) | "Confirming…" |
| pending | own submission after the first watch ended | "Still confirming…" with Check again; "Your transaction needs a check" when the saved-hash check asks for attention |
| recovery | the journal record read at mount or after a failure: `{ hash, nonce, saved, id }` | the chain check for a hashless record, or "Finishing your last step…" for a saved hash |
| rejected, error | message; `plain` for a sentence the person can act on | "Cancelled in your wallet" or the message, with Try again |
| receipt | a terminal outcome that is not this control's own action | "Earlier transaction found" |
| reverted, replaced, confirmed | this control's own terminal outcome | result |

Refs and latches around it: `attemptedScope` (167) for the one automatic prepare; `clearJournalScope` (168), set when
the journal was read empty for the scope; `autoSubmit` and `autoSubmitSpent` (171-172) for the one automatic send;
`mounted` and `mountRevision` (166, 177-183).

### Invariants

- T-I1. One operation per scope at a time (`begin`, 195-200). A second click during an operation does nothing.
- T-I2. An async result is applied only if the component is mounted and the scope is the one that started it
  (`isCurrent`, 185-189).
- T-I3. The wallet opens only from a click on this control (prepare with `fromClick`, or Confirm), or once from
  `submitOnMount` (T-I4). A click-to-wallet send also refuses inside the service if the control is no longer current
  (line 314).
- T-I4. The automatic send is read once at mount and spent on the first decision: it fires only from idle, with the
  journal read empty for the scope, the control enabled and no unfinished outcome; a record, an error, a disabled
  control or an unfinished outcome ends it without sending (331-343).
- T-I5. No prepare or send starts while the account has an unfinished outcome (`activeOutcome`, 139, 286, 380).
- T-I6. `onConfirmed` runs only for this control's own submission from this visit, matched by nonce and operation and
  by the same call (354-359).
- T-I7. A control in pending leaves it once its record is gone: by its own receipt, by the receipt another tab
  confirmed, or by returning to its button when the wallet replaced or dropped the transaction. Before 8bf7034 only
  the first held. Finding 2.

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| any | scope change (wallet revision, action, service) | | idle; journal read again | 206-226 |
| idle | journal read at mount | record present, no operation running | recovery | 212-219 |
| idle | click | enabled, no unfinished outcome, wallet on the right chain | preparing | 285-293 |
| idle | mount with `prepareOnMount` | journal empty, not yet attempted in this scope | preparing | 323-329 |
| idle | mount with `submitOnMount` | T-I4 | preparing, then submitting | 331-343 |
| preparing | journal has a record | | recovery | 295-300 |
| preparing | prepared | click on a direct-send control | submitting | 307-314 |
| preparing | prepared | otherwise | review | 315 |
| preparing | prepare fails | | error, or recovery if a record now exists; `onUnavailable` first for an automatic send | 301-305, 276-283 |
| review | Confirm | same wallet session as the review | submitting | 379-395 |
| review | Back | | idle | 497 |
| review | wallet changes | | review marked stale, Confirm disabled | 481, 487, 496 |
| submitting | wallet returns a hash | | confirming | 310-313, 391-394 |
| submitting | wallet rejects | | rejected | 363-364 |
| submitting | nothing sent | | error, plain | 365-366 |
| submitting | uncertain answer | record present | recovery | 276-283 |
| confirming | receipt, own action | | confirmed, reverted or replaced; `onConfirmed` for confirmed | 352-360 |
| confirming | first watch ends without a receipt | | pending | 361-362 |
| pending | a terminal outcome of this submission appears | enabled | runs Check again: confirmed, `onConfirmed` with "check" | 258-263 |
| pending | saved-hash check reports settled | enabled | runs Check again | 265-274 |
| pending | saved-hash check reports replaced | enabled | idle. The page's recovery panel shows "Your wallet replaced or dropped your last transaction. Check the page before trying again." and re-reads the chain | 265-274, ResumeTransaction.tsx:91-99, 200 |
| pending | saved-hash check asks for attention | | pending with "Your transaction needs a check" | 505-512 |
| pending | Check again | | the outcome of `owner.resume` | 403-411, 370-377 |
| recovery, hashless | chain check: spent or settled | journal read empty | idle | 228-254 |
| recovery, hashless | chain check: unsent, then Continue | | idle after the clear | 438-443 |
| recovery, saved hash | saved-hash check settled or replaced, or a terminal outcome at its nonce | journal read empty | idle | 228-254 |
| recovery | the journal now holds another record | | recovery for that record | 234-243 |
| rejected, error, reverted, replaced | Try again or Review again | | idle | 535, 545 |
| receipt | Review this action | no unfinished outcome | idle | 524 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload while preparing or in review | Nothing was stored. idle | safe |
| Reload with the wallet prompt open | recovery, hashless: the chain check, never an automatic send | safe |
| Reload while confirming or pending | recovery with the saved hash: "Finishing your last step…", then idle. The receipt shows through the outcome rows | safe |
| Two tabs | The second tab's control starts in recovery for the first tab's record and cannot send | safe. For pending see finding 2b |
| Account or chain switch | New scope: idle. Results of the old scope are dropped. The wallet gate above most controls also unmounts them while disconnected | safe. Tests: "drops a delayed prepare from an old wallet session and allows the fresh wallet action" (`web/test/buyer-ui-repairs.browser.test.ts:234`) |
| Wallet rejection | rejected, "Nothing was sent", Try again | safe |
| No hash or an uncertain error | recovery, hashless, settled from the nonces | safe. Test: "after a wallet error without a code, shows one plain panel and no reconcile wording, then buys after Continue" (`web/test/easy-buy.browser.test.ts:370`) |
| Bare -32603 or -32000 | "Waiting for wallet…" for about four seconds, then a plain sentence and Try again | safe |
| RPC lags or fails | prepare fails into error with Try again; a failed watch becomes "Your transaction needs a check" | safe, one click |
| Dropped or replaced transaction after the first watch | Before 8bf7034: "Still confirming" for good. After: the button returns, and the page says what happened and reads the chain | fixed, finding 2a |
| Reorg | Not seen by this component; the service's receipt rules apply | safe by reading |
| Storage or Web Locks unavailable | The journal read at mount fails: error with the reason. Nothing can be sent | safe |

### Illegal combinations checked

| Combination | Result |
|---|---|
| Two wallet requests from one click | Unreachable: T-I1, the owner's per-account guard and the service's `used` flag |
| An automatic send in a scope other than the one it mounted in | Unreachable in the current tree. The latch itself would still fire if the scope changed between mount and the first journal read, but every control with `submitOnMount` sits under a parent that unmounts it when the wallet revision or the account read changes (`RaffleWorkspace.tsx:734, 802`), and its action is constant. By reading |
| An automatic send after a record was found | Unreachable: line 334. Test: "never opens the wallet by itself once a saved transaction that held the confirmation is checked" (`web/test/seller-draw-runner.browser.test.ts:384`) |
| `onConfirmed` for a transaction this control did not send | Unreachable: T-I6. A foreign receipt shows as "Earlier transaction found" |
| pending with no journal record and no receipt on the way | Reachable before 8bf7034: finding 2 |
| recovery that never ends although the record is gone | Unreachable: every final status of both checks triggers a journal read (228-254) |

## 4. Saved-hash check, pending-send check and the page recovery panel

Code: `web/components/workflow/useTransactionOutcomes.ts`, `web/components/workflow/ResumeTransaction.tsx`.

### States

Two module registries, keyed per outcome owner (`WeakMap`, lines 132, 241) and then by wallet session:

| Machine | Key | States | Ref |
|---|---|---|---|
| Saved-hash check | `{account}:{revision}:{hash}` | checking; attention (two failed reads, a receipt that is not a plain success of the journal's intent, this tab's failed watch, or three minutes pending); settled (the journal no longer holds the hash); replaced (this check cleared the record from the nonces). replaced is final | 60-129, 142-172 |
| Pending-send check | `{account}:{revision}:{id}:{nonce}` | checking; waiting; unsent; unknown (two failed reads); spent and settled are final | 186-237, 256-306 |

Each entry counts its users and runs one check while it has any (162-168, 278-283). The check reads only while the
page is visible (77, 220) and never prepares, signs or sends. The pending-send entry also counts the visible panels
that show the record, so the page shows one (286-305).

`ResumeTransaction` holds the journal record it last read (`pending`, line 34), `clearJournal` (35), a `generation`
that changes with the wallet snapshot (36, 58-63), the manual hash field, and two lines it keeps until the next send or
another wallet: the earlier-send line (53) and the replaced line (56).

### Invariants

- C-I1. One check per record and wallet session, however many controls show it.
- C-I2. The journal is cleared only through `owner.resume` after a confirmed read of the exact hash and the journal's
  own intent, or through `owner.settlePending` (useTransactionOutcomes.ts:97-104, 93-95).
- C-I3. Continue is the only path that clears a record with nothing at its nonce before 25 blocks, and only a click
  reaches it (232-235).
- C-I4. The page re-reads the chain when something landed that no receipt on this page reported: a hashless record
  cleared as spent, a saved hash cleared from the nonces, or a send stopped by the marker
  (ResumeTransaction.tsx:92-99), and once per confirmed outcome (101-110).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| saved hash: checking | tick | this tab is watching the hash | checking | 83 |
| checking | tick | journal holds another hash or none | settled | 86 |
| checking | inspection: unmined or too shallow | under three minutes | checking | 89-91 |
| checking | same | three minutes or more | attention | 91 |
| checking | inspection: hash unknown | nonces clear the record (spent or dropped) | replaced | 92-95 |
| checking | inspection: hash unknown | nonces do not clear it, twice | attention | 96 |
| checking | inspection: confirmed, exact hash and intent | | journal cleared through `owner.resume`, then settled on the next tick | 97-104, 86 |
| checking | inspection: reverted, other intent or other hash | | attention | 105 |
| checking, attention | page hidden | | no reads until it is visible again | 77, 116-122 |
| attention | later ticks | | attention; the check keeps reading and still ends in settled or replaced | 74-114 |
| hashless: checking | `settlePending`: waiting or unsent | | waiting or unsent | 197-199 |
| waiting, unsent | `settlePending`: spent | | spent (final), page re-reads | 200-202 |
| unsent | Continue | still unsent | settled (final), record dropped with a marker | 232-235 |
| any | `settlePending`: changed | | settled (final) | 200-202 |
| any | two failed reads in a row | | unknown, manual form behind Details | 209-210 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload | Registries are empty. Each check starts from the journal | safe |
| Two tabs | Each tab runs its own check. `settlePending` re-reads the record under the journal lock, so only one clears it. Test: "lets only one of two tabs clear the record, each inside the journal lock, never overlapping" (`web/test/pending-send.test.ts:183`) | safe |
| Account or chain switch | The key includes the wallet revision, so the old entry loses its users and stops | safe |
| Hidden tab | No reads. On return the check runs at once | safe. Test: "reads nothing while the page is hidden and checks at once when it becomes visible" (`web/test/automatic-outcome-check.test.ts:182`) |
| RPC fails | attention or unknown after two failures; the manual form appears | safe, see suspicion 1 |
| Replaced or dropped transaction | replaced; the page re-reads | fixed, finding 2a |
| Storage or Web Locks unavailable | `service.pending` throws: the saved-hash check asks for attention, the panel shows the error | safe |

### Illegal combinations checked

| Combination | Result |
|---|---|
| A check that opens the wallet | Unreachable: the check has no path to prepare, submit, sign or connect. Test harness `expectReadsOnly` (`web/test/automatic-outcome-check.test.ts:59`) |
| The journal cleared on a receipt for another intent | Unreachable: lines 98-101. Test: "leaves a confirmed receipt with a different intent from the journal to the manual form" (`:118`) |
| Two Continue panels for one record | Unreachable: panel counting. Test: "shows exactly one Continue panel for an unsent record while Other actions opens and closes" (`web/test/independent-transaction-outcomes.browser.test.ts:892`) |
| A record cleared from the nonces with the page left on the old state | Reachable before 8bf7034 for a saved hash: finding 2a |

## 5. Create flow records

Code: `web/lib/chain/create-flow.ts`, `web/components/workflow/SellerDraftForm.tsx:146-163, 409-551`,
`web/components/workflow/CompleteCreate.tsx`, `web/lib/chain/api.ts:53-69, 118-128`.

### States

| Part | Encoding | Ref |
|---|---|---|
| Create record | `localStorage` `labx:create:v1:{chain}:{contract}:{codehash}:{seller}`: `preparing { data, requestIdentity }` or `draft { data, creationHash, id, pending, lastFailure? }`, where `pending` is `{ step, hash, checkpoint? }` and the checkpoint is the journal record's id, intent, nonce and starting block | create-flow.ts:8-17, 27-58 |
| Raffle page record | the same shape under `...:raffle:{id}`, used when Studio's record is not for this exact draft | create-flow.ts:116-128 |
| Generation | `...:generation`, a UUID advanced when a record is created or retired, so a click made against an older record is refused | create-flow.ts:59-70 |
| Archives | `...:retired:{uuid}` and `...:completed:{id}` | create-flow.ts:129-136, 149-159 |
| Create lock | Web Lock named by the record key | SellerDraftForm.tsx:428, CompleteCreate.tsx:31 |
| In memory | `createLifetime` (mounted, generation, busy, operation) and the `creation` view state | SellerDraftForm.tsx:146-158 |

| State | Encoding |
|---|---|
| R0 none | no record |
| R1 preparing, unsigned | `preparing`, `requestIdentity` null |
| R2 preparing, requested | `preparing` with a request identity |
| R3 draft, nothing sent | `draft`, `id` null, `creationHash` null, `pending` null |
| R4 step in the wallet | `pending { step, hash: null, checkpoint }` |
| R5 step sent | `pending { step, hash, checkpoint }` |
| R6 draft on chain | `id` and `creationHash` set, `pending` null; the chain decides whether approval and escrow are still needed |
| R7 done | record archived as completed |

### Invariants

- R-I1. One Create runs per seller at a time, across tabs (the Create lock), and only against the record the seller
  saw when they clicked (`assertCreateGeneration`, and the serialized comparison at SellerDraftForm.tsx:431-435).
- R-I2. The record names a step before the wallet is asked for it: the checkpoint is saved from the service's
  `beforeRequest`, under the journal lock (create-flow.ts:263-266).
- R-I3. `createRaffle` is sent only when the record has no `id`, no `creationHash` and no pending draft step that the
  chain can still settle (create-flow.ts:281-304).
- R-I4. A step whose journal record is gone is settled from the chain before anything is sent: nothing at its nonce
  drops the step, something pending waits, and a mined nonce looks for the draft's `RaffleCreated` event at that nonce
  from the step's starting block to the head (create-flow.ts:281-293, service.ts:286-310).
- R-I5. The create record and the journal record agree: a checkpoint with another intent, or a journal record with
  another id, stops Create (create-flow.ts:178-180).
- R-I6. A record is retired only when nothing of it can still land: no id, hash or pending step, and no journal record
  (create-flow.ts:72-86); or its draft changed on chain and no wallet transaction is unresolved (92-110).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| R0 | Create | no journal record | R1, then the signature request | SellerDraftForm.tsx:439-448 |
| R1 | signature requested | | R2 | SellerDraftForm.tsx:450-453, api.ts:59-60 |
| R1, R2 | wallet refuses, request never left, or the server answers 404 | | R0 | SellerDraftForm.tsx:456-461 |
| R2 | server saved the setup | | R3 | SellerDraftForm.tsx:455 |
| R2 | reload, then Create | recovery signature; server has the setup | R3 | SellerDraftForm.tsx:462-478 |
| R2 | same | server never saved it (404) | R0 with the form restored | SellerDraftForm.tsx:468-477 |
| R1 | reload, then Create | | stays R1: "Your raffle setup wasn't saved", Start over under Advanced | SellerDraftForm.tsx:463 |
| R3, R6 | Create | step needed | R4 for that step | create-flow.ts:258-266 |
| R4 | wallet returns a hash | | R5 | create-flow.ts:272 |
| R4 | wallet refuses, or its message says nothing was sent | | back to R3 or R6 | create-flow.ts:267-270, service.ts:196, 223 |
| R4 | bare -32603 or -32000, nonces quiet | | stays R4 with no journal record; the next Create settles it from the chain | service.ts:221-224, create-flow.ts:281-293 |
| R4 | uncertain answer | | stays R4 with a hashless journal record | create-flow.ts:187-188 |
| R4, R5 | Create, journal record gone | nothing at the nonce | R3 or R6, and the step is sent again at that nonce | create-flow.ts:286-291 |
| R4, R5 | same | nonce spent, draft step, event found | R5 with the found hash | create-flow.ts:287-291 |
| R4, R5 | same | nonce spent, no event (or another step) | R3 or R6; the chain decides what is still needed | create-flow.ts:291 |
| R4, R5 | same | something pending, or a gap | unchanged, "Wait for canonical confirmation" | create-flow.ts:285 |
| R4 | Create, journal record still hashless | | unchanged, "The wallet response is uncertain"; the page's chain check settles the record | create-flow.ts:187-188 |
| R5 | receipt, exact call, success | | R6, or the next step | create-flow.ts:198-212, 303, 311, 317, 325, 333 |
| R5 | receipt reverted, or another call at that nonce | | step cleared with `lastFailure`; Create retries the stage | create-flow.ts:206-210 |
| R5 | no receipt in two minutes | | unchanged, Create resumes | create-flow.ts:201 |
| R6 | escrow confirmed and custody read back | | R7 | SellerDraftForm.tsx:496-505, CompleteCreate.tsx:45-49 |
| R3 | Start over | no journal record | R0, archived | create-flow.ts:72-86 |
| R6 | Create, draft edited, cancelled, listed or expired on its own page | no pending step, no journal record | R0, archived | create-flow.ts:92-110 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload or close at any step | The record names the step. Create resumes from it and from the chain | safe |
| Two tabs | The lock runs one Create. The other tab's click fails the generation check | safe. Tests: "detects a null-to-null cross-tab ABA through the durable creation generation" (`web/test/independent-three-action-create-flow.test.ts:343`), `web/test/independent-complete-create-race.browser.test.ts` |
| Account or chain switch mid-flow | `assertIntent` fails at the next step; nothing more is sent. The record stays under the seller's key | safe |
| Wallet rejection | Step cleared, "Press Create to continue when you're ready" | safe |
| No hash | R4 with a hashless journal record. The dashboard's chain check clears it, then Create finds the draft | safe. Test: "finds the draft a wallet sent despite its error, after the mined nonce clears the record, and makes no second draft" (`web/test/three-action-flow.integration.test.ts:218`) |
| Bare -32603 or -32000 | Before 3bc0972 the step's checkpoint was dropped: finding 1 | fixed |
| RPC lags | A draft the log read cannot find yet is not searched again once the step was dropped. See suspicion 3 | open, by reading |
| RPC fails during the search | The step stays pending. Test: "keeps the lost draft step when a read fails part way through the search, then finds the draft" (`web/test/three-action-flow.integration.test.ts:250`) | safe |
| Dropped or replaced step | Settled from the nonce. Tests: "continues from the faster copy of a draft whose saved hash was replaced" (`:328`), "sends the draft again once when its saved hash never landed (%s)" (`:336`) | safe |
| Reorg | The created draft is re-read with its block hashes before the next step (service.ts:105-127) | safe by reading |
| Storage unavailable or full | The record write throws before the wallet request. Test: "sends nothing when durable coordinator storage fails before submission" (`web/test/independent-three-action-create-flow.test.ts:379`) | safe |
| Web Locks unavailable | "This browser isn't supported" before anything is read or sent | safe |

### Illegal combinations checked

| Combination | Result |
|---|---|
| Two `createRaffle` requests for one Create | Reachable before 3bc0972 after a code-only wallet failure: finding 1. Otherwise unreachable by R-I3 and R-I4 |
| A record with a pending step and no way to settle it | Unreachable for records with a checkpoint. A record from before checkpoints existed needs the pasted hash (create-flow.ts:186, 207) |
| The record points at one draft while the journal holds another transaction | Unreachable: R-I5. Test: "blocks an unrelated global journal before preparing or submitting" (`web/test/independent-three-action-create-flow.test.ts:280`) |
| A record retired while its transaction can still land | Unreachable: R-I6. Tests: "does not reset an on-chain or globally journaled creation stage" (`:326`), "retains the record when a global journal exists or the scope retires during its read" (`web/test/create-recovery.builder.test.ts:43`) |
| Studio's record used for another raffle's page | Unreachable unless the two drafts are byte-identical (create-flow.ts:121). The server gives the same seller, NFT and texts the same commitment, so a second raffle of the same NFT with the same title, deadline and packs would match. By reading; see the server part's ambiguity 8 |

## 6. Buyer checkout

Code: `web/components/workflow/RaffleWorkspace.tsx:527-757`.

### States

React state only; nothing is stored.

| Part | Encoding | Ref |
|---|---|---|
| Order | `packId`, `quantity`, `payment` | 541-543 |
| Consent | `{ account, checked }`, tied to the wallet that ticked it | 544, 605-616 |
| Quote | `quote`, `quoteState`, `quoteRequest` counter | 552-555, 585-602 |
| Handoff | `buyAfterApproval { order, revision, block }`: the order whose approval this page just confirmed | 548 |
| Own approvals | the approvals this page sent in this visit | 550 |
| Derived | `needsApproval`, `approvalFirst`, `buyReady`, `autoBuy` | 620-623, 648-650 |

| State | Encoding |
|---|---|
| B0 choosing | no handoff; shows the approve control (allowance short) or the buy control |
| B1 approving | the approve control is in a wallet or confirming state |
| B2 handoff | `buyAfterApproval` set, reads not yet at the approval's block: "Approved. Opening your purchase…" |
| B3 buying | the buy control mounted, with `submitOnMount` when the handoff matched |
| B4 bought | a confirmed purchase outcome for this raffle: receipt with Buy again or Dismiss |

### Invariants

- B-I1. At most two wallet prompts per purchase: the exact approval, then the purchase. With enough allowance, one.
- B-I2. The purchase opens by itself at most once per approval, and only when the first reads at or after the
  approval's block show the same order, the same wallet session, USDC payment and enough allowance (648-650). The
  handoff is cleared in the same commit that decides (651-653), and the control reads `submitOnMount` once
  (TransactionFlow T-I4).
- B-I3. A failed read, a quote error, another wallet or another order ends the handoff without sending (652).
- B-I4. The handoff is never stored, so a reload never opens a wallet.
- B-I5. The purchase call carries the pinned terms hash and is built only with the tick of the connected wallet
  (612, 631-637).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| B0 | Buy click, allowance short | agreed, writes enabled | B1 | 739 |
| B0 | Buy click, allowance enough | agreed | B3, one prompt | 740 |
| B1 | approval confirmed from this control (first watch or a later check) | | B2; page re-reads from the approval's block | 655-659 |
| B1 | pack, quantity or payment changes | | B0 for the new order; the approval's control unmounts and its confirmation re-reads the account once | 663-671 |
| B1 | wallet rejects | | B0 with "Cancelled in your wallet" | |
| B2 | reads at or after the approval's block, same order and session, allowance enough | | B3 with the automatic send | 648-650 |
| B2 | same reads, anything differs | | B0, a click is needed | 650-653 |
| B2 | read fails, quote fails, wallet changes | | B0 | 652 |
| B3 | purchase confirmed | | B4 | 563-565 |
| B3 | wallet rejects | | B0, Try again | |
| B4 | Buy again or Dismiss | reads at or after the purchase's block | B0 | 673-681 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload at any step | B0 from the chain. An approval already mined shows the buy control, one click | safe |
| Two tabs | The journal lets one request through. A purchase confirmed in the other tab shows here after its outcome is recovered or the page is re-read | safe; for a slow purchase see finding 2b |
| Account or chain switch | The handoff ends (652), the tick is cleared for another account (605-611), the quote restarts | safe. Test: "clears only stale recovery feedback after an account switch and leaves the original wallet journal intact" (`web/test/buyer-ui-repairs.browser.test.ts:199`) |
| No hash on the approval | No handoff. After the chain check clears the record the buy control shows; one click | safe, extra click |
| Bare -32603 or -32000 on the purchase | Plain sentence and Try again. If the purchase had landed, the next click stops at the marker and the page shows the membership | safe; see the accepted limit under A4 |
| RPC lags after the approval | Reads repeat until they reach the approval's block (frontend consistency bugs 1 and 2) | fixed earlier |
| Replaced or dropped purchase | See finding 2a | fixed |
| Reorg | Not seen by this component; the service's receipt rules apply | safe by reading |

### Illegal combinations checked

| Combination | Result |
|---|---|
| Three wallet prompts for one purchase | Unreachable without a rejection or an order change. Tests: "buys every membership the raffle offers with one click: two wallet transactions without an allowance and no signatures" (`web/test/easy-buy.browser.test.ts:98`), frontend consistency bug 2 |
| Two automatic purchases for one approval | Unreachable: B-I2 |
| An automatic purchase for another order or wallet than the approval's | Unreachable: 650, 652 |
| An automatic purchase after a reload | Unreachable: B-I4 |
| A purchase prompt with no tick | Unreachable: `purchaseAction` is null without it (631) and the button is disabled (738) |

## 7. Owner Safe approve and revoke flow

Code: `web/components/review/OwnerReview.tsx:419-988`, `web/lib/chain/service.ts:70-104`,
`web/lib/chain/owner-execution.ts`, `web/lib/chain/owner-execution-discovery.ts`.

### States

| Part | Encoding | Ref |
|---|---|---|
| Flow | `FlowState`: idle, preparing, requested or exported (same screen, by channel), recovery, confirming, pending, executed, error | OwnerReview.tsx:42-50 |
| Discovery | `DiscoveryState`: idle, range, error; a cursor ref with a block checkpoint | OwnerReview.tsx:52-55, 500 |
| Selection and attestations | `selection`, `attestations` bound to the review digest | OwnerReview.tsx:486-488, 509 |
| Operations | `lifetime` ref: mounted, generation, operation counter, the one exclusive operation, the digest | OwnerReview.tsx:499, 514-541 |
| Saved intent | `localStorage` `labx:owner-review:v1:{chain}:{contract}:{codehash}:{owner}:{id}`: the exact call, its review block, generations and revision | OwnerReview.tsx:419-421, owner-execution.ts:78-113 |
| Channel | `...:handoff`: `{ intent, channel }`, channel `wallet-request` or `file` | OwnerReview.tsx:786-799 |
| Exposure | `...:manual-exposure`: the intent whose call fields were shown, copied or downloaded | OwnerReview.tsx:803-817 |
| History | `...:history:{digest}:{block hash}`: an intent replaced by a fresh download | OwnerReview.tsx:910-912 |
| Lock | Web Lock named by the intent key | OwnerReview.tsx:711, 748, 811, 902 |

The component is remounted when the wallet session, the deployment, the raffle or the owner changes
(OwnerReview.tsx:464-475).

### Invariants

- S-I1. The Safe is asked once per saved intent. A wallet request is refused while an intent is saved
  (OwnerReview.tsx:713), and the reviewed action can be used once (service.ts:90-92).
- S-I2. The intent is saved under the lock before the provider is called (OwnerReview.tsx:706-719,
  service.ts:99-103).
- S-I3. The saved intent is removed only by a confirmed canonical execution (655, 853), by a rejection or a request
  that never left, and then only if the call fields were never exposed (743-757), or by Discard on a recorded
  revocation (871-881).
- S-I4. "Approval recorded" needs the executed transaction's own event with the same raffle, approver, digest and
  revision, two confirmations and matching block hashes (owner-execution.ts:43-74). A Safe proposal hash or a wallet's
  answer is never taken as execution.
- S-I5. One exclusive operation at a time; a result is applied only if it is still the latest operation for the same
  digest (514-541).
- S-I6. Attestations belong to one digest; a changed digest clears them (60-62, 589-617).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| idle | Approve | draft ready, trust check passed, no saved intent | preparing, then the Safe request | 690-730 |
| idle | Download revocation file | approved digest exists | preparing, then exported with the file | 731-741 |
| preparing | intent saved, request handed to the wallet | | requested; discovery starts | 706-727, 783 |
| preparing, requested | wallet rejects, or the request never left | call fields never exposed | error "The wallet request was cancelled", intent removed | 743-763 |
| same | same | call fields were exposed, or storage could not be read | requested, "Saved recovery is still being watched" | 764-766 |
| requested | wallet error after dispatch | | requested with "The wallet response is uncertain. Do not send another approval" | 767-774 |
| requested, exported, recovery, pending | discovery finds a candidate with two confirmations | | executed; intent removed; page re-reads from that block | 636-660 |
| same | candidate not yet two deep | | pending | 666-673 |
| same | nothing found | | unchanged; cursor advances; checked again every 15 s while visible | 620-634, 679-680 |
| same | discovery fails or times out | | unchanged, error line with Retry | 675-682 |
| requested, exported | Review and download call | same digest | exported, exposure recorded | 883-909, 921-924 |
| same | same | digest changed | old intent archived, fresh intent saved and downloaded | 910-919 |
| requested, exported, pending | hash entered and confirmed | | executed | 842-860 |
| any with intent | digest changes to the state right after this revocation | | recovery (the stored call is historical) | 423-433, 596-602 |
| any with intent | digest changes otherwise | | the handoff screen for the saved intent | 604-607 |
| recovery | Discard recorded review | | idle, intent removed | 871-881 |
| executed, error | Review current state, Return | | idle | 949, 952 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload or close after the intent is saved | The handoff screen returns from storage and discovery resumes | safe |
| Reload or close before it is saved | Nothing was sent. idle | safe |
| Two tabs | The lock and the saved intent let one request through. Both tabs discover the execution | safe. Test: `web/test/independent-owner-review-race.browser.test.ts` (NOT_RUN here) |
| Account or chain switch | The flow remounts. A request not yet dispatched is refused by `assertIntent` (service.ts:93-103) | safe |
| Wallet rejection | Intent removed unless its fields were exposed | safe |
| No hash, or a bare -32603 or -32000 | The wallet's answer is only a reference. The flow watches the chain | safe. Test: "warns that the wallet response is uncertain when the Safe request fails after discovery started" (`web/test/safe-approval-handoff.browser.test.ts:281`) |
| RPC lags or fails | Discovery reports an error and retries; a confirmed execution is re-read from its block (`readAdmissionFrom`, 68-76) | safe |
| Reorg | The cursor's checkpoint hash is compared on every page; a mismatch restarts the scan from the review block (owner-execution-discovery.ts:99-105). Confirmation re-checks every block hash at the end (owner-execution.ts:70-73) | safe. Tests in `web/test/owner-execution-discovery.test.ts` |
| Storage full | The intent is not saved and the request is not dispatched | safe by reading |
| Web Locks unavailable | "Safe recovery requires a browser with secure Web Locks" before the request | safe |

### Illegal combinations checked

| Combination | Result |
|---|---|
| Two Safe requests for one review | Unreachable: S-I1 |
| "Approval recorded" without the event | Unreachable: S-I4. Tests in `web/test/owner-execution-discovery.test.ts` and `web/test/chain.integration.test.ts` |
| A saved intent removed while the Safe could still execute it from exposed fields | Unreachable: S-I3 |
| A request that the Safe never proposed, with the page unable to ask again | Reachable by design: after an uncertain wallet answer the intent stays saved, so Approve is refused. The way on is Advanced recovery, which downloads a fresh call. See ambiguities |

## 8. Wallet connection machines

Code: `web/lib/chain/wallet-session.ts`, `web/lib/chain/wallet-connectors.ts`, `web/lib/chain/wallet-consent.ts`,
`web/lib/chain/appkit-provider.ts`. These have the densest existing tests (`wallet-session.test.ts`,
`wallet-connectors.test.ts`, `wallet-restoration.test.ts`, `independent-wallet-restoration-adversarial.test.ts` and
five `appkit-*` files), so this section records the encoding and the rules and reports what was checked by reading.

### States

| Machine | Encoding | States | Ref |
|---|---|---|---|
| Session base | `state` (snapshot with a revision), `provider`, `epoch`, `suspended`, `disposed` | no provider; disconnected and listening; connected (any chain; callers compare the chain); suspended after a local disconnect; disposed | wallet-session.ts:8-16 |
| Browser session | `connection` status (idle, pending, error), `attempt` counter, `abort`, `chooser`, `chooserLoad`, `cleanup` promise chain, `cleanupFailures`, `cleanupNotice`, `inFlight`, `activeOwner`, `restoring` | idle; restoring; connecting for an owner; connected; blocked on an unconfirmed cleanup | wallet-connectors.ts:53-69 |
| Consent | `localStorage` `labx:wallet-consent:v1:{origin}:{projectId}:{scope}`: `{ connectorId, account, chainId, id }`; `sessionStorage` `{key}:revoked` for this tab | none; saved; revoked globally; revoked for this tab only | wallet-consent.ts:4-47 |
| AppKit runtime | module values `runtime`, `runtimeScope`, `pendingAttempt`, `cleanupLease`, `cleanupFailed`; per runtime `active`, `adoption`, `startupPending`, `initializationFailed` | not loaded; starting; ready; startup timed out (cleared if readiness arrives later); cleanup failed (until reload) | appkit-provider.ts:405-446, 520-630 |
| Connection attempt | `Attempt`: `cancelled`, `pending` count, `awaitingStart`, `completed` connectors, controller claim | open; connector running; cancelled and cleaning up; settled | appkit-provider.ts:17-28, 47-133, 222-259 |
| WalletConnect cleanup | `WalletConnectCleanup`: provider, topic, `completed`, `deleting`, `failure`; `releasedWalletConnectProvider` | observed; deleting; completed; failed; released | appkit-provider.ts:30-38, 261-356 |

### Invariants

- W-I1. The revision rises on every published change, and every account or chain event first publishes a
  disconnected snapshot (wallet-session.ts:29-33, 69, 91). Every review, control scope and check key carries the
  revision, so nothing prepared under one session is used under another.
- W-I2. A transaction or signature request reaches the provider only after the session was re-read and compared,
  before and after the caller's own preparation (wallet-session.ts:121-134, 141-148).
- W-I3. A read started under one provider, epoch or revision is dropped if any of them changed (wallet-session.ts:85).
- W-I4. One connect or restore runs at a time. A connect from another owner while one is running is refused
  (wallet-connectors.ts:262-265). A superseded attempt cannot publish (`active`, 303-305, checked after every await).
- W-I5. Restoring never prompts: it reads accounts and chain, and requires the saved consent, the connector, the
  account and the chain to match before and after (wallet-connectors.ts:167-219, appkit-provider.ts:734-751).
- W-I6. An explicit Connect revokes the saved consent first, and a failed one removes it
  (wallet-connectors.ts:271-274, 352-354). Disconnect revokes it, in this tab at least (221-249).
- W-I7. A new chooser is not used until the previous chooser's cleanup finished, or failed within eight seconds, in
  which case connecting asks for a reload until that cleanup finishes after all (wallet-connectors.ts:122-157).
- W-I8. One attempt at a time in the AppKit runtime. A cancelled attempt disconnects every connector it completed
  before another attempt can start (appkit-provider.ts:47-65, 245-252, 758-763, 884-888).
- W-I9. The chooser hands over only the provider AppKit selected, after two matching reads of account and chain and
  after the connect call itself has settled (appkit-provider.ts:771-823).
- W-I10. A consent change in another tab, or cleared storage, disconnects this tab (wallet-connectors.ts:79-95).

### Transition table

| From | Event | Guard | To | Ref |
|---|---|---|---|---|
| disconnected | page load | consent saved for this chain | restoring | browser.ts:47, wallet-connectors.ts:167-179 |
| restoring | provider, account and chain match the consent | | connected | wallet-connectors.ts:192-205 |
| restoring | anything differs, or a read fails | | disconnected; chooser released | wallet-connectors.ts:194-214 |
| restoring | Connect click | | restore retired; connecting | wallet-connectors.ts:253-261 |
| disconnected | Connect click | chooser available | connecting (pending) | wallet-connectors.ts:266-289 |
| connecting | Connect from the same owner | | the same attempt | wallet-connectors.ts:263 |
| connecting | Connect from another owner | | refused, "A wallet request is still pending" | wallet-connectors.ts:264 |
| connecting | wallet approved, right chain | | connected; consent saved | wallet-connectors.ts:332-349 |
| connecting | cancelled, rejected, wrong chain, 20 s chooser load or 120 s approval timeout | | disconnected with an error line; consent removed; chooser disconnected | wallet-connectors.ts:350-367 |
| connecting | Cancel connection, or the gate unmounts | same owner, not yet connected | disconnected | wallet-connectors.ts:292-301 |
| connected | `accountsChanged` or `chainChanged` | | disconnected at once, then re-read up to three times over three seconds, then again on window focus | wallet-session.ts:20-34 |
| connected | provider `disconnect` or `session_delete` | | disconnected, suspended | wallet-session.ts:35, 111-116 |
| connected | account or chain differs on a passive read | | connected with the new values and a new revision | wallet-session.ts:91 |
| connected | Disconnect | | disconnected; consent revoked; chooser disconnected | wallet-connectors.ts:221-249 |
| connected | consent key changes in another tab | | disconnected; chooser released | wallet-connectors.ts:80-91 |
| any | chooser cleanup exceeds eight seconds | | connecting is refused with a reload message until that cleanup finishes | wallet-connectors.ts:132-157 |
| any | AppKit not ready in 20 s | no adopted connection | connecting is refused with a reload message until readiness arrives | appkit-provider.ts:613-628, 753 |

Environment events:

| Event | What happens | Verdict |
|---|---|---|
| Reload | Restore from consent without a prompt, or stay disconnected | safe |
| Two tabs | Each tab has its own session. Connect or Disconnect in one disconnects the other (W-I10) | safe; see ambiguities |
| Account or chain switch mid-flow | W-I1 and W-I2: the pending review is void and the provider is not called | safe. Tests: "does not invoke the provider if %s changes while journal acquisition waits" (`web/test/wallet-session.test.ts:31`), "rejects old actions when the selected provider changes during a journal wait" (`web/test/wallet-connectors.test.ts:312`) |
| Wallet rejects the connection | Error line, Connect again | safe |
| Session read fails after an event | Three tries, then on focus. Until then the wallet shows as disconnected | safe. Tests at `web/test/wallet-session.test.ts:55, 66` |
| Storage unavailable | Connect works for this tab with "this wallet will not be remembered" (wallet-connectors.ts:320-322, 346-348). Disconnect falls back to the tab marker or reports that LABx may reconnect (wallet-consent.ts:28-47) | safe |

### Illegal combinations checked

| Combination | Result |
|---|---|
| A connected snapshot whose provider is not the one the person chose | Unreachable: W-I9, and restore compares the provider (wallet-connectors.ts:192-201). Test: "adopts only the exact provider returned by AppKit" (`web/test/wallet-connectors.test.ts:78`) |
| Two attempts sharing a chooser | Unreachable: W-I4, W-I8. Tests: "deduplicates only the same owned attempt" (`:89`), "does not let an old owner cancel a newer attempt" (`:155`) |
| A late wallet approval connecting after Cancel | Unreachable: the attempt counter. Test: "cancels only the matching owned attempt and ignores late provider approval" (`:103`) |
| A wallet restored after Disconnect in this tab | Unreachable: the tab marker or the removed consent. Test: `web/test/independent-wallet-restoration-adversarial.test.ts` |
| A wallet request sent under a session that has since changed | Unreachable: W-I2 |

No reachable invalid state was found in these machines.

## 9. Small machines

| Machine | Location | States and encoding | Invariant | Checked |
|---|---|---|---|---|
| Raffle page read and background poll | `web/components/workflow/RaffleWorkspace.tsx:79-192, 283-306` | loading, unavailable, legacy, mismatch, missing, error, ready with refresh idle, loading or error; `request` counter; `confirmedBlock` and `polledBlock` refs | A read older than a confirmed transaction or than a newer background read is never shown; writes pause while a refresh runs or failed | Covered by the frontend consistency audit (bugs 1 and 3). The poll reads the DOM for a review or a busy control (line 298), so a control that stays busy holds the page still; none was found that stays busy without a wallet request or a handoff |
| Account read | `RaffleWorkspace.tsx:232-265` | idle, loading, ready, error; `accountRequest` counter | Shown only when its raffle, block hash and account match the page | By reading |
| Seller step chain | `RaffleWorkspace.tsx:777-886` | `reclaimAfter` (the cancellation this page just confirmed), reveal preflight idle, loading or error with a `preflightInFlight` ref, `recovered` draw setup | Reclaim NFT follows only a cancellation confirmed straight from its own click, once, for the same wallet session and a read at or after its block; the reveal goes to the wallet once after its signature | Tests in `web/test/seller-draw-runner.browser.test.ts`; the latch is TransactionFlow T-I4 |
| Listing policy | `RaffleWorkspace.tsx:888-927` | loading, ready, error per scope (snapshot, wallet revision, retry) | The policy hash sent with List is the one read for the current snapshot | By reading |
| Edit-draft review | `web/components/workflow/SellerDraftForm.tsx:35-41, 553-605` | editing, review, saving, committed, retained, error; `commitmentInFlight` ref | One signature request at a time; unsaved edits survive a page re-read (`draftEdits`, `RaffleWorkspace.tsx:240, 320-322`) | Test: "keeps unsaved draft edits open through the page Refresh" (`web/test/seller-portal.browser.test.ts:492`) |
| NFT gallery and selection | `SellerDraftForm.tsx:30-34, 186-407` | inventory idle, loading, ready or error; selection pending or chosen; generation counters and an `AbortController` | An answer for another wallet, chain or request is dropped; ownership is read on chain when an NFT is chosen | Covered by `web/test/independent-create-selection-race.browser.test.ts` |
| Seller dashboard | `web/components/workflow/SellerDashboard.tsx:35-83` | idle, loading, ready, error; `request` counter | A superseded scan is dropped | By reading |
| Private records | `web/components/workflow/PrivateRecordsPanel.tsx:26-140` | loading-history, ready-history, loading-records, ready, error; `request` counter; per-operation tokens; delivery map per receipt | A signature or result from another wallet session is dropped; signed records survive Load more | Test: "keeps signed receipts through Load more and asks to sign only for the older purchases it finds" (`web/test/private-record-feedback.browser.test.ts:333`). A failed step still discards them: suspicion 5 |
| Entry records | `web/components/workflow/DrawProgress.tsx:12-27` | list, cursor (null when done), loading, error; `generation` and `busy` refs | A new raffle read resets the list and frees the next click | Test: "loads entry records on the first click after a refresh replaced a load still in flight" (`web/test/buyer-ui-repairs.browser.test.ts:495`) |
| Action trust | `web/components/workflow/useActionTrust.ts:8-21` | checking, trusted (null), failed (reason), per snapshot | Presentation only; preparation checks again | By reading |
| Notification feed | `web/components/NotificationFeed.tsx:22-90` | loading, ready, error; `flowRef` generation, refreshing flag and more-token | A refresh cancels a load of older items; a stale page is dropped | By reading |
| Notifications bell | `web/components/NotificationsBell.tsx:18-232` | unread flag; read watermark in `localStorage` `labx:notifications:read:{chain}:{contract}`; one request in flight | The watermark only moves forward by block and log index | Tests in `web/test/notification-unread.test.ts` |
| Wallet controls | `web/components/workflow/WalletConnectionControls.tsx:11-74` | the session's connection status plus the attempt owner this control started | Unmounting cancels only its own attempt | Test: "does not let synchronous gate unmount cancel a newly established session" (`web/test/wallet-connectors.test.ts:123`) |
| Paging lists | `SellerActivity.tsx`, `AccountHistory.tsx`, `BuyerRaffles.tsx`, `RaffleCatalog.tsx` | loading, ready, error; `request` counters | A superseded page is dropped; all pages of one load are pinned to one block | Covered by the frontend consistency audit |
| Intro film | `web/components/BrandSplash.tsx:78-83` | checking, playing, done; `sessionStorage` flag | Shown once per tab | By reading |

## Findings

### Issue 1. Create sends a second draft after a wallet error that only a code marks as unsent (high, narrow trigger)

A wallet can answer `eth_sendTransaction` with a bare -32603 or -32000 after its own RPC already took the transaction.
The service treats those codes as weak evidence: it reads the account's nonces for about four seconds and, if they stay
quiet, removes the pending record and leaves a marker so that the next send checks that nonce first. It also called
the caller's `onNotDispatched`, and Create answered by dropping the step's checkpoint. With the checkpoint gone, Create
had no nonce to settle the step from.

Sequence:

1. The seller presses Create. The record holds `pending { step: "createDraft", hash: null, checkpoint }` at nonce N.
2. The wallet sends the transaction through its own RPC and answers with `{ code: -32603 }`.
3. LABx's RPC shows nothing at N for four seconds. The journal record is removed, the marker is written, and Create
   shows "Your wallet couldn't send this transaction. Nothing was sent." The create record now has `pending: null`.
4. The draft is mined. LABx's RPC now shows it.
5. The seller presses Create. The send stops at the marker with "Your wallet sent an earlier LABx request. Check the
   page before trying again." The marker's nonce is mined, so the marker is removed.
6. The seller presses Create again. Nothing remembers nonce N. The wallet is asked for `createRaffle` a second time.

The contract accepts the second draft (`contracts/src/LabxRaffle.sol:438-454` has no duplicate rule), so the seller
pays its gas, the NFT is locked into the second raffle, and the first stays as an orphan draft in their list. The
trigger needs a wallet that reports an error after broadcasting and an RPC that lags it by four seconds, which is the
case the marker was added for (A4).

- Code: `web/lib/chain/service.ts:221-224` (was the unconditional `onNotDispatched` call),
  `web/lib/chain/create-flow.ts:267-270, 281-293`.
- Tests:
  - "keeps the draft step's nonce after a bare -32603 error, so Create finds the draft the wallet sent and never asks
    for a second one" (`web/test/client-state-machines.test.ts:88`), default suite, the real service and create flow
    over a scripted chain.
  - "finds the draft a wallet sent behind a bare -32603 error that LABx's RPC saw only later, and makes no second
    draft" (`web/test/three-action-flow.integration.test.ts:361`), on Anvil with the real contract.
- Before, observed on Anvil: wallet requests were `createDraft, createDraft, approvePrize, escrow`; the first press
  after the draft landed stopped with the earlier-request message and the second sent the draft again; `nextId - 1`
  was 2; the record ended at `id: "2"`. In the default-suite test the record's `pending` was null right after step 3.
- Fix: the service reports a send as not dispatched only when the wallet refused it, was never asked, or its own
  message says it sent nothing. After a code-only failure the caller keeps its checkpoint, and Create settles the step
  from the chain as it already does after Continue and the 25-block clear: nothing at the nonce sends the draft again
  at that same nonce, something pending waits, and a mined nonce finds the draft. This is what
  `web/lib/chain/README.md` already described. What reaches a wallet is unchanged except that the second
  `createRaffle` is no longer sent when the first one landed.
- After, observed on Anvil: wallet requests were `createDraft, approvePrize, escrow`; one raffle; the record ended at
  `id: "1"`, `pending: null`. In the default-suite test three presses made no further wallet request and the record
  held the found creation hash.
- Also pinned: "sends the draft again at the same nonce when nothing landed there after a bare -32603 error" and
  "still retires the draft step at once when the wallet's own message says it sent nothing" (same file).

### Issue 2. A slow send's control keeps waiting after its record is settled elsewhere (medium)

A send that is not two blocks deep after one minute leaves its control on "Still confirming on the network" and the
automatic saved-hash check takes over. That check can end in ways the control did not handle. In each, the journal
record was gone, no receipt was on its way to this control, and the control kept waiting.

**2a. The wallet replaced or dropped the transaction (medium).**

1. The buyer presses Buy and confirms in the wallet. The transaction stays unmined for more than a minute. The
   checkout shows "Still confirming on the network".
2. The buyer speeds it up or cancels it in the wallet. The old hash leaves the pool.
3. The replacement is mined two deep. The saved-hash check finds the old hash unknown, reads the nonces, and clears
   the record as spent, with the old hash's outcome rows and checkpoints.
4. The checkout still shows "Still confirming on the network", with no end. By reading, Check again then answers
   "Action unavailable" with the RPC's not-found text. The page is not re-read: after a speed-up the membership is
   bought and the page still shows the checkout from before it, with an allowance that is already spent; after a
   cancel the Buy button never returns.

- Tests (`web/test/client-state-machines.browser.test.ts`): "stops waiting for a purchase the wallet cancelled after
  the first watch, and buys again on the next click" (line 98) and "shows the membership a faster copy of the purchase
  bought after the first watch" (line 121).
- Before, observed: 60 seconds after the cancel was two blocks deep, "Still confirming on the network" was still on
  the page (count 1, expected 0). After the speed-up, "Membership price paid" did not appear within 60 seconds.
- Fix: the saved-hash check reports a record it cleared from the nonces as replaced
  (`web/components/workflow/useTransactionOutcomes.ts:95, 158`). The page's recovery panel then re-reads the chain, as
  it already did for a record without a hash, and shows "Your wallet replaced or dropped your last transaction. Check
  the page before trying again." until the next send or another wallet
  (`web/components/workflow/ResumeTransaction.tsx:56, 91-99, 200`). The control returns to its button
  (`web/components/workflow/TransactionFlow.tsx:265-274`). The line also shows when the replaced transaction is found
  after a reload.
- After, observed: "Still confirming" was gone, the line was shown above the page, the Buy button was back and the
  next click bought, which removed the line (two wallet requests in total, both from clicks). After the speed-up the
  page showed "Membership price paid" and the line, with one wallet request in total.
- Correction after a rerun: the first version (8bf7034) showed the notice inside the control with a Try again button.
  The page re-read remounts the checkout control, so the notice was gone within a second, and a second run of the
  sequence failed when Try again detached before the click. 9032cdd moved the line to the recovery panel, where the
  earlier-request line already lives for the same reason.

**2b. Another tab of the same wallet confirmed it first (low).**

1. The buyer presses Buy in tab A and confirms in the wallet. The transaction is slow. They switch to tab B, also on
   LABx with the same wallet. Tab A is hidden and stops checking.
2. The transaction is mined. Tab B's check confirms it and clears the journal record. Tab B shows "You're in".
3. The buyer returns to tab A. Its check finds the record gone and reports settled. Tab A's own outcome row is still
   "pending", so nothing looks for the receipt: "Still confirming on the network" stays until the buyer presses Check
   again.

- Test: "shows the receipt of a slow purchase that another tab of the same wallet confirmed first" (line 141).
- Before, observed: "You're in" did not appear in tab A within 60 seconds of returning to it.
- Fix: when the check reports settled while the control is still pending, the control runs the same read-only check as
  its Check again link (`TransactionFlow.tsx:265-274`), which finds the receipt and reports the control's own action
  as confirmed.
- After, observed: tab A showed "You're in" and no "Still confirming", with one wallet request in total.

What this changes about wallet sends: nothing is sent by the fix itself. One existing automatic send can now follow
from it: an approval that tab A sent and tab B confirmed is now confirmed in tab A without a click, and a confirmed
approval of this page's own click opens its purchase, exactly as it already does after a slow confirmation in one tab
(`web/test/easy-buy.browser.test.ts:425`). The journal still allows one wallet request per account across tabs.

Not covered by the fix: the manual Check again in the page's recovery panel (`ResumeTransaction.tsx:121-126`) clears a
replaced record through the same nonce rule without reporting it as replaced, so in that path the control ends on
"Action unavailable" with the RPC's text, the line is not shown and the page is not re-read. By reading; see
suspicion 2.

### Open issue 3. Create sends a second draft when the creation log is not found (high, narrow, not fixed)

This predates the audit and is not changed by this branch. The independent review reproduced it on Anvil with an
injected lagging log read: two `createRaffle` requests and two raffles for one saved intent.

1. The seller's Create is broadcast and the wallet answers with a bare -32603. The checkpoint is kept (issue 1).
2. The draft is mined. The seller clicks Create. The nonce reads show the checkpoint's nonce as used.
3. `findCreation` reads the `RaffleCreated` logs up to the head and gets nothing, because the node that answers the
   log read is behind the node that answered the nonce read (`web/lib/chain/service.ts:298-310`).
4. The recovery treats the nonce as used by something else, drops the checkpoint (`web/lib/chain/create-flow.ts:291`)
   and sends `createRaffle` at the next nonce.

Cost: the gas of a second `createRaffle` and a spare draft the seller can cancel. No buyer money is involved.

Why it is not fixed here: a log range read cannot tell "no such log" from "this node has not seen those blocks yet",
and the two exact alternatives each have a cost that needs a decision. Finding the block in which the nonce was used
and reading that one block by hash is exact, but needs account state at past blocks, which pruning RPC providers do
not keep. Requiring two searches some blocks apart before giving up is provider-independent, but adds a field to the
saved create record and makes a seller whose wallet really did replace the draft wait and click again.

### Open issue 4. A tab keeps an unverified row after another tab settles the same send (medium, not fixed)

This predates the audit. The independent review observed it at module level: two tabs recover a pending purchase;
after the wallet cancels it, tab A settles it and removes the shared recovery data; tab B keeps its `unverified` row
(`web/lib/chain/transaction-outcomes.ts:179`), which pauses transactions in tab B until a reload. Whether a tab
should drop a row whose checkpoint has gone is ambiguity 3.

### Independent review of this branch

A Codex review of `54f317e..9032cdd` with eleven module probes and two browser probes found no defect in the three
changes. It confirmed that the kept record is the seller workflow's checkpoint and not the account-wide journal, that
a Create after a real no-send goes out at the same nonce, and that an approval confirmed in a second tab leads to
exactly one `buyPack` request across both tabs (the tab that sent the approval opens the purchase; the other does
not). It answered DO NOT MERGE because of open issues 3 and 4, which exist on `main` regardless of this branch. It
also noted that an RPC missing both a hash and its pending nonce can report a send as dropped while it is still
pending; the existing marker then holds the nonce, so a retry replaces that send and does not add one.

## Status of A1 to A5, B1 to B7 and C1 to C6

The earlier document gives one line per ID. Where the line covers two IDs (C5 and C6) the split below is inferred from
the commits of 972f46c. "Ran" says whether the proving test ran for this audit.

| ID | Earlier finding | Status at 54f317e plus this branch | Proof | Ran |
|---|---|---|---|---|
| A1 | Create stalls after an uncertain create step once the journal record is settled without it | Fixed in 972f46c: a step whose record is gone is settled from the chain | "sends the draft again after Continue clears its unsent record on another page, and makes one draft" and "finds the draft a wallet sent despite its error, after the mined nonce clears the record, and makes no second draft" (`web/test/three-action-flow.integration.test.ts:208, 218`) | yes |
| A2 | A wallet that overrides the nonce while the RPC lags leaves the journal waiting forever | Fixed for a returned hash: the record follows it to the wallet's nonce. Open and accepted when an earlier nonce of the account was dropped: the record waits until that gap is filled outside LABx (ambiguity 1) | "moves the record to the nonce a wallet chose for its returned hash, so it settles when that hash mines (watched: %s)" (`web/test/pending-send.integration.test.ts:495`); the accepted case is pinned by "keeps the record and waits when %s, even on Continue and after 25 blocks" (`web/test/pending-send.test.ts:105`) | yes |
| A3 | A hashless record cleared by Continue or expiry while the wallet still holds the prompt can be sent twice | Mitigated in 972f46c, residue accepted: the marker stops the next send once the old one is visible, and before that the next send reuses the nonce. A wallet that ignores the requested nonce can still send both; the exact allowance then makes the second purchase revert | "stops the next send before the wallet when a request cleared by Continue lands first, then sends on the next click" and "sends at the same nonce after Continue, and reports the old request as a replacement when it lands instead" (`web/test/pending-send.integration.test.ts:410, 434`); "after Continue, stops Buy once when the old approval lands meanwhile, shows it, then buys with one more wallet step" (`web/test/easy-buy.browser.test.ts:395`) | yes |
| A4 | A bare -32603 or -32000 clears the record after four seconds; a retry can duplicate a send the wallet's RPC took | Mitigated the same way for buys. For Create it was still open: finding 1, fixed in 3bc0972. The same wallet residue as A3 is accepted | "after a code-only failure is retired, a send the wallet's own RPC delivers later stops the retry before the wallet" (`web/test/pending-send.integration.test.ts:461`), and the tests of finding 1 | yes |
| A5 | A storage-error row stays after storage reads clean | Fixed in 972f46c | "removes its storage-error row once storage reads clean again, so new actions are no longer blocked" (`web/test/transaction-outcomes.test.ts:470`) | yes |
| B1 | The automatic purchase is lost to a trust-check race | Fixed in 972f46c | "still opens the purchase by itself when the action check finishes after the account and quote" (`web/test/easy-buy.browser.test.ts:454`) | yes |
| B2 | Background re-reads stay held after a rejected or failed action | Fixed in 972f46c | "keeps re-reading after a step is cancelled in the wallet, so the page moves on when someone else runs it" (`web/test/buyer-ui-repairs.browser.test.ts:468`) | yes |
| B3 | | Refuted in the earlier audit; nothing to check | | |
| B4 | Refresh discards draft edits | Fixed in 972f46c | "keeps unsaved draft edits open through the page Refresh" (`web/test/seller-portal.browser.test.ts:492`) | yes |
| B5 | Load more after signing drops the signed records | Fixed in 972f46c for a Load more that succeeds. A failed Load more or a rejected signature still discards them (suspicion 5) | "keeps signed receipts through Load more and asks to sign only for the older purchases it finds" (`web/test/private-record-feedback.browser.test.ts:333`) | yes |
| B6 | A late automatic send on reveal | Fixed in 972f46c: the automatic send is spent on the first decision | "never opens the wallet by itself once a saved transaction that held the confirmation is checked" (`web/test/seller-draw-runner.browser.test.ts:384`) | yes |
| B7 | A control inside a closed disclosure is not counted, so the recovery panel shows twice or not at all | Fixed in 972f46c | "shows exactly one Continue panel for an unsent record while Other actions opens and closes" (`web/test/independent-transaction-outcomes.browser.test.ts:892`) | yes |
| C1 | The owner flow's uncertain warning is lost once discovery has started | Fixed in 972f46c | "warns that the wallet response is uncertain when the Safe request fails after discovery started" (`web/test/safe-approval-handoff.browser.test.ts:281`) | yes |
| C2 | Entry records: a new read during a load leaves the button ignoring clicks | Fixed in 972f46c | "loads entry records on the first click after a refresh replaced a load still in flight" (`web/test/buyer-ui-repairs.browser.test.ts:495`) | yes |
| C3 | | Refuted in the earlier audit; nothing to check | | |
| C4 | AppKit taking more than 20 s to start disables the chooser until reload | Fixed in 972f46c: a late readiness clears the block. A startup that fails or never settles still needs the reload | "becomes usable without a reload when SDK readiness arrives after the startup timeout" and "keeps requiring a reload when SDK readiness %s after the startup timeout" (`web/test/appkit-provider.test.ts:256`) | yes |
| C5 | A wallet event whose session read fails leaves the wallet disconnected | Fixed in 972f46c: three reads, then again on focus | "retries the read after %s so a transient failure does not leave it disconnected" and "stops after three failed reads and reads again when the window regains focus" (`web/test/wallet-session.test.ts:55, 66`) | yes |
| C6 | A chooser cleanup that outlasts its bound blocks connecting until reload | Fixed in 972f46c when the cleanup finishes later. A cleanup that fails still needs the reload | "connects again without a reload when a cleanup that outlasted its bound later finishes", "clears the reload message a Connect click showed once that cleanup finishes after all" and "keeps requiring a reload when a cleanup that outlasted its bound later fails" (`web/test/wallet-connectors.test.ts:222, 247, 270`) | yes |

## Leads from the frontend consistency audit

Its eight unverified suspicions, as they stand after this audit:

| # | Suspicion | Result |
|---|---|---|
| 1 | One render of the previous account's data on a direct account change | Not examined: not a state machine of this slice |
| 2 | A failed step on the receipts page discards signed receipts | Still open, by reading. Suspicion 5 below |
| 3 | The seller studio after Create on a lagging node | Not examined |
| 4 | A catalog refresh leaves the load-more banner | Not examined |
| 5 | The bell's first fetch in development | Not examined |
| 6 | The "needs attention" status of a saved-hash check outlives its components | Confirmed by reading and wider than stated: the status never returns to checking, in the same mount either. Suspicion 1 below |
| 7 | A quote retried after its inputs changed keeps reading | Not examined |
| 8 | A confirmed draft edit and the recovery panel's refresh re-read without the confirmed block | Still open. This branch adds one more caller of that refresh (a replaced transaction), which also carries no block |

## Suspicions not reproduced

These follow from reading the code. None was driven to an invalid state by a test.

1. Attention is sticky. Once a saved-hash check has asked for a person (two failed reads, or three minutes pending),
   the entry keeps that status for the wallet session, also after the RPC recovers and on later pages
   (`web/components/workflow/useTransactionOutcomes.ts:74-114, 156-161`). The check keeps running and still ends in
   settled or replaced, so the cost is a manual panel shown while the automatic check is working. Low.
2. The recovery panel's manual check of a replaced hash. `ResumeTransaction.tsx:121-126` clears the record from the
   nonces without the replaced report, so a control in pending then runs its check, gets the RPC's not-found text
   under "Action unavailable", and the page is not re-read. It needs a person to press Check again in the panel in the
   seconds before the automatic check would have done the same. Low.
3. Confirmed by the independent review; see open issue 3 under findings.
4. Confirmed by the independent review; see open issue 4 under findings.
5. Signed receipts lost on a failed step. A failed Load more or a rejected signature sets the error state, and Retry
   starts again with nothing signed (`web/components/workflow/PrivateRecordsPanel.tsx:75, 114`). Low.
6. The automatic-send latch and a scope change. If a control with `submitOnMount` stayed mounted through a wallet
   revision change that happened before its first journal read, the send would fire in the new scope
   (`web/components/workflow/TransactionFlow.tsx:331-343`). Every current parent unmounts the control in that case,
   so this is a trap for a future caller, not a reachable state today.

## Ambiguities of intended behavior

1. Should a record that waits behind a dropped earlier nonce offer a way out? Today it waits until something fills the
   gap, and LABx itself cannot send to fill it, so the account needs a transaction from outside LABx. The page says
   "Waiting for your last transaction to confirm…" throughout. A create step kept without its journal record follows
   the same rule and answers "Wait for canonical confirmation"; since 3bc0972 that includes a step kept after a
   code-only wallet failure, which before would have been sent again at once.
2. Should a marker be removed when a later record at its nonce clears as spent? Today it stays, and the next send
   stops once with "Your wallet sent an earlier LABx request", which is not what happened.
3. Should a tab drop an unfinished outcome row when its checkpoint disappears from storage? Today it keeps it, pinned
   by "keeps deleted unknown saved activity blocking and never persists unowned unknown input"
   (`web/test/transaction-outcomes.test.ts:430`). That protects against deleted storage, and it is also what leaves
   suspicion 4.
4. Should the owner be able to ask the Safe again after an uncertain wallet answer? Today the saved intent blocks
   Approve for good, and the way on is Advanced recovery with a downloaded call. A Safe that never received the
   request therefore needs the manual path.
5. Should Connect in one tab disconnect the other tabs? Today any change of the saved consent does, including a
   Connect to the same account. A buyer between approval and purchase in the other tab loses the automatic purchase
   and needs one more click after reconnecting.
6. Should a replaced transaction get a receipt? After finding 2a the page says the wallet replaced or dropped the
   last transaction and shows the chain's state, but a purchase bought by a speed-up after the first watch has no "You're
   in" receipt, because LABx never learns the replacement's hash. While the first watch is still running, the same
   speed-up does get its receipt.
7. Is "Nothing was sent" the right wording after a code-only wallet failure? The service keeps a marker precisely
   because it cannot know, and after finding 1 the next Create first reads the chain.

## Test results

All commands ran in the worktree at the commit named. Opt-in lanes ran one at a time with `--maxWorkers=1`.

| Check | Command | Result |
|---|---|---|
| Baseline at 54f317e | `npm --prefix web test` | PASS: 78 files passed, 52 skipped; 1,293 tests passed, 376 skipped |
| Finding 1 before its fix, on Anvil | `RUN_CHAIN_INTEGRATION=1 npx vitest run test/three-action-flow.integration.test.ts --maxWorkers=1 -t "bare -32603"` in `web`, service at 54f317e | FAIL as expected: 1 failed. Requests `createDraft, createDraft, approvePrize, escrow`, two raffles |
| Finding 1 before its fix, default suite | `npx vitest run test/client-state-machines.test.ts` in `web`, service at 54f317e | FAIL as expected: 1 failed, 2 passed |
| Finding 1 after its fix | `RUN_CHAIN_INTEGRATION=1 npx vitest run test/three-action-flow.integration.test.ts test/pending-send.integration.test.ts --maxWorkers=1` | PASS: 2 files, 49 tests |
| Finding 2 before its fix, at 3bc0972 | `RUN_CLIENT_STATE_MACHINES_BROWSER=1 npx vitest run test/client-state-machines.browser.test.ts --maxWorkers=1` | FAIL as expected: 3 of 3. The cancel sequence was run again with its first assertion on the old screen: "Still confirming" still shown after 60 s |
| Finding 2, first version of the fix (8bf7034) | same | PASS 3 of 3 on the first run. FAIL on the second run: 1 failed (the cancel sequence, Try again detached before the click), 2 passed. See the correction under finding 2a |
| Finding 2, final fix (9032cdd) | same | PASS: 3 of 3, run twice (once before the commit, once at 9032cdd) |
| Full default suite at 9032cdd | `npm --prefix web test` | PASS: 79 files passed, 53 skipped; 1,296 tests passed, 380 skipped |
| Types at 9032cdd | `npx --prefix web tsc --noEmit -p web/tsconfig.json` from the repository root | PASS, exit 0 |
| Default suite plus every lane behind `RUN_CHAIN_INTEGRATION`, at 9032cdd | `RUN_CHAIN_INTEGRATION=1 npm --prefix web test` | PASS: 98 files passed, 34 skipped; 1,483 tests passed, 193 skipped |

Opt-in browser lanes at 9032cdd, each as `RUN_<SWITCH>=1 npx vitest run test/<file> --maxWorkers=1` from `web`, with a
local chain (anvil) and the contract artifacts built by `forge build --root contracts`:

| Lane | Switch | Result |
|---|---|---|
| `client-state-machines.browser.test.ts` (new) | `RUN_CLIENT_STATE_MACHINES_BROWSER` | PASS, 3 of 3 |
| `easy-buy.browser.test.ts` | `RUN_EASY_BUY_BROWSER` | PASS, 11 of 11 |
| `buyer-ui-repairs.browser.test.ts` | `RUN_BUYER_UI_REPAIRS_BROWSER` | PASS, 14 of 14 |
| `independent-transaction-outcomes.browser.test.ts` | `RUN_INDEPENDENT_TRANSACTION_OUTCOMES_BROWSER` | PASS, 11 of 11 |
| `independent-buyer-state.browser.test.ts` | `RUN_INDEPENDENT_BUYER_STATE_BROWSER` | PASS, 2 of 2 |
| `frontend-consistency.browser.test.ts` | `RUN_FRONTEND_CONSISTENCY_BROWSER` | PASS, 7 of 7 |
| `seller-draw-runner.browser.test.ts` | `RUN_SELLER_DRAW_RUNNER_BROWSER` | PASS, 13 of 13 |
| `seller-portal.browser.test.ts` | `RUN_SELLER_PORTAL_BROWSER` | PASS, 14 of 14 |
| `independent-transaction-lineage.browser.test.ts` | `RUN_INDEPENDENT_TRANSACTION_LINEAGE_BROWSER` | PASS, 1 of 1 |
| `private-record-feedback.browser.test.ts` | `RUN_PRIVATE_RECORDS_BROWSER` | PASS, 6 of 6 |
| `safe-approval-handoff.browser.test.ts` | `RUN_SAFE_APPROVAL_BROWSER` | PASS, 5 of 5 |
| `independent-empty-raffle-recovery.browser.test.ts` | `RUN_INDEPENDENT_EMPTY_RECOVERY_BROWSER` | PASS, 12 of 12 |
| `independent-seller-simplification.browser.test.ts` | `RUN_INDEPENDENT_SELLER_SIMPLIFICATION_BROWSER` | PASS, 5 of 5 |
| `activation-trust.browser.test.ts` | `RUN_BROWSER_ACCEPTANCE` | PASS, 5 of 5 |
| `independent-three-action-safe.browser.test.ts` | `RUN_INDEPENDENT_THREE_ACTION_BROWSER` | PASS, 3 of 3 |
| `independent-five-tier-form.browser.test.ts` | `RUN_FIVE_TIER_VERIFICATION` | PASS, 1 of 1 |
| `wallet-restoration.browser.test.ts` | `RUN_WALLET_RESTORE_BROWSER` | PASS, 1 of 1 |
| `independent-wallet-restoration.browser.test.ts` | `RUN_INDEPENDENT_WALLET_RESTORE_BROWSER` | PASS, 1 of 1 |
| `independent-complete-create-race.browser.test.ts` | `RUN_INDEPENDENT_COMPLETE_CREATE_RACE` | PASS, 1 of 1 |
| `independent-create-selection-race.browser.test.ts` | `RUN_INDEPENDENT_CREATE_SELECTION_RACE` | PASS, 4 of 4 |

That is twenty lanes and 120 tests. The first eight existing lanes also passed at 8bf7034 (73 tests) before the
correction. After every lane `git status --short` showed no change made by a lane to `web/tsconfig.json` or to any
other tracked file.
The seller simplification lane wrote screenshots under `artifacts/`, which were removed and not committed.

NOT_RUN: six browser lanes that do not render the changed components (`owner-review-race`,
`independent-owner-review-race`, `independent-owner-export-rejection-race`, `owner-recovery.builder`,
`wallet-nft-picker.verification`, `browser-chain-lifecycle`); the four integration files with their own switches
(`draw-runner.integration`, `independent-transaction-lineage.integration`,
`independent-wallet-review-repairs.integration`, `independent-claude-final-repairs.integration`); and
`draw-runner.fork`.

No independent review of these commits was run from this slice.

New tests on this branch: three in `web/test/client-state-machines.test.ts` (default suite), one in
`web/test/three-action-flow.integration.test.ts`, three in `web/test/client-state-machines.browser.test.ts`, and two
tightened assertions in `web/test/automatic-outcome-check.test.ts`.

Limits of the evidence: the browser lanes use an injected local wallet, so WalletConnect, AppKit and a real Safe were
covered only by their unit tests. Lag, replacement and wallet errors were simulated on a local chain or a scripted
client. No production RPC was called.
