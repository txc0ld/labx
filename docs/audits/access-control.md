# Access control audit

Date: 10 November 2026. Candidate: branch `audit/access-security-20261110` on top of `main` at `2078b82`. This is a source and test review by an AI agent, not a formal security audit. Nothing here was verified against a real wallet, real VRF or the production deployments.

## Scope and method

Every place that decides who may read, create, change, delete or export something: the 15 route files under `web/app/api` (13 live, 2 retired), the libraries they call, the two cron handlers, the draw runner, and the access checks in `contracts/src/LabxRaffle.sol`. There is no `middleware.ts`, no server action and no session. Intended rules come from `docs/handoff/CLAUDE_HANDOFF_2026-10-10.md` (H), `SECURITY.md` (SEC), `LAUNCH.md` and the existing tests. Leads were confirmed or dismissed by running tests against the real route handlers and library functions with an in-memory store and locally generated keys.

## Identity model

There are no accounts. A wallet address is the principal, and every private request carries a wallet signature over a message that binds the site origin, chain id, raffle contract, address, the exact input and a deadline at most 600 seconds ahead. Two message families exist: `LABx <operation> v2` (`web/lib/request-auth.ts:16`, used by agreements and receipts) and `LABx <operation> v3` (`web/lib/chain/messages.ts`, used by commitment, recovery and private records, also binding the terms hash and version). The origin, chain and contract come from server configuration (`web/lib/request-auth.ts:7`, `web/lib/chain/server.ts:61`), never from request headers. `signatureVerifier` (`web/lib/chain/server.ts:22`) recovers EOA signatures locally, asks the node for contract-wallet signatures, and answers 503 when the node gives no verdict.

Roles: seller (creator of a raffle and owner of the NFT), buyer (the `buyer` in a `PackPurchased` event), contract owner (the Safe), draw runner (cron key with no privileges), bot (holder of `BOT_CHECKIN_TOKEN`), cron (holder of `CRON_SECRET`).

## Intended rules and enforcement points

### Web API

| Route | Operation | Who may | Enforcement |
|---|---|---|---|
| `POST /api/reserve` | create a private commitment | a wallet that signs the exact input and owns the NFT | signature `web/lib/workflow-records.ts:21`; `ownerOf` equals signer `web/app/api/reserve/route.ts:24-26` |
| `POST /api/reserve/reveal` | read the commitment including salt | the seller who created it, on the same chain and contract | signature `workflow-records.ts:30`; record seller, contract and chain match `:32` |
| `POST /api/reserve/preparation` | read a saved preparation (no salt) | the same seller, same NFT and token | signature `workflow-records.ts:42`; record match `:47` |
| `POST /api/agreements` | record acceptance of terms | the signing wallet, for itself, for an existing raffle with published terms | `web/lib/agreement-record.ts:24`; key derives from the signer `:25-28`; first write wins |
| `POST /api/records` | read agreements and receipt status (recipient emails) | the signing wallet, for itself, at most 30 raffles and 30 purchases | signature `web/lib/private-records.ts:26`; agreement key derives from the signer `:29`; receipt slots are returned only while the stored address equals the signer `web/lib/receipt-delivery.ts:81` |
| `POST /api/email/receipt` | send a receipt, reserve a recipient slot | the buyer of that exact finalized purchase, at most three addresses | signature over the recipient `receipt-delivery.ts:26`; event buyer equals signer `web/lib/purchase-proof.ts:28`; a stored slot must carry the signer's address `receipt-delivery.ts:47` |
| `POST /api/bot/check-in` | add 10 points once per UTC day | the bot token holder, with the wallet's signature for today | constant-time token match `web/lib/points.ts:21-27,40`; signature `:44-50` |
| `GET /api/points` | read a balance | anyone, any address (H:508 "Public GET") | none by design |
| `GET /api/notifications` | read the public event feed | anyone | validated cursor and limit only |
| `GET /api/wallet-nfts` | list an address's NFTs | anyone, any owner (H:504) | rate limits per client, per owner and global `web/lib/wallet-nfts-server.ts:202-210` |
| `GET /api/workflow/context` | read origin, chain, contract, terms | anyone | public configuration only |
| `GET /api/cron/draw` | run the draw | `CRON_SECRET` bearer of at least 16 characters | `web/lib/draw-runner/http.ts:23-24`; runner key must not be the owner, a Safe signer or the treasury `:32-34` |
| `GET /api/cron/notifications` | process and mail admin alerts | same bearer | `web/lib/notifications/http.ts:126-127`, digest comparison `:140-144` |
| `POST /api/cron/notifications` | send the fixed connection test | same bearer; empty body; fixed recipient | `http.ts:100`, `web/lib/notifications/delivery.ts:9` |
| `/api/amoe/*` | retired | nobody | 410 |

Nothing in the web app deletes a stored record, and there is no bulk export. The only "download" paths are the private reads above.

### Contract

| Function | Who may | Check (`LabxRaffle.sol`) |
|---|---|---|
| `transferOwnership`, `setPaused`, `setTreasury`, `setTermsHash`, `setVrfConfig`, `setNativePayment`, `proposeCoordinator`, `applyCoordinator`, `setEthPathEnabled`, `approveRaffle`, `revokeRaffleApproval` | owner | `onlyOwner`, lines 353-430, 568, 579 |
| `acceptOwnership` | pending owner | 360 |
| `createRaffle` | anyone, who becomes the seller | none; not blocked by pause |
| `updateDraft`, `escrow`, `open`, `openWithPolicy`, `claimProceeds`, `reclaimPrize` | seller (`open` also needs the current owner's approval and is blocked by pause) | 467, 522, 627, 633, 783, 838 |
| `reveal` | seller or current owner | 748 |
| `buyPack`, `buyPackWithEth` | anyone; blocked by pause | 951 |
| `refund` / `claimPrize` | the buyer with principal / the winner | 848-849 / 773 |
| `cancel` | seller or owner while nothing is sold; anyone seven days after sales end | 809-815 |
| `close`, `snapshot`, `settle`, `requestRandomness`, `abortDrawing`, `claimFee` | anyone, gated by time and phase | 647, 694, 761, 715, 826, 796 |
| `rawFulfillRandomWords` | acts only for a request recorded for the calling coordinator | 732 |
| `retryRandomness`, `claimAmoe` | nobody; always revert | 727, 687 |

## Scenarios checked

| Scenario | Result | Evidence |
|---|---|---|
| Direct API request without a signature, or with another wallet's signature | refused | `workflow-records.test.ts:35`, `signature-verifier.test.ts:96` |
| Signature replayed against another origin, chain, contract or terms version | refused | `independent-mainnet-isolation.test.ts:64`, `workflow-records.test.ts:35` |
| Deadline more than 600 seconds ahead | refused (was untested) | new: "a signed request is short-lived" |
| Changed resource id: another seller's commitment or preparation | refused | `workflow-records.test.ts:50,54` |
| Changed resource id: another wallet's purchase in `/api/records` | no email returned (was untested) | new: "shows the receipt email to the buyer and not to another wallet" |
| Another wallet asks for a receipt for someone else's purchase, before or after the buyer | refused, nothing stored or sent (was untested) | new: "a purchase receipt belongs to the wallet that bought" |
| Role change: ownership transfer | pending owner has no power; previous owner loses every setter on acceptance; unopened approvals die | new `OwnerOnlyAccess.t.sol`; `Admission.t.sol:127` |
| Revoked access: a contract wallet stops validating an old signature | its stored agreement is shown as not recorded | `private-records.ts:42-45`, `workflow-records.test.ts:102` |
| Revoked access: seller no longer owns the NFT | new commitments refused; the seller can still recover their own earlier commitment | `reserve/route.ts:26` |
| Background: cron without or with a short or wrong secret | refused before any dependency | `cron-bearer.test.ts`, `notification-public-http.test.ts:242,271,443` |
| Background: runner key equal to a privileged address | refused | `draw-runner.test.ts:509,523` |
| Bot check-in with a wrong, missing or empty token, another day's signature, or another wallet's signature | refused, no write (was partly untested) | new: "awards points only with the server token and the wallet's own signature for today" |

## Confirmed findings

### AC-1 Bot check-in reports a storage failure as an authorization refusal and returns internal error text (low, fixed)

- Where: `web/app/api/bot/check-in/route.ts` (catch-all `fail(error, 401)`), `web/lib/points.ts`.
- Behavior before: any exception in the route became a 401 carrying the raw `Error.message`. A storage outage answered `401 {"error":"connect ECONNREFUSED db-internal.example:5432 user=labx_owner"}` (synthetic text), and a malformed signature answered with the verifier's own text (`invalid signature length`). The caller cannot tell an outage from a refusal, and internal text leaves the server.
- Reach: two cases. Without the token, a caller reaches only the store construction, which runs before the token check, so a misconfigured store returned its configuration error text (for example which provider variable is missing) to anyone. Errors from store reads and writes and from the signature verifier need the bot token, because the token is checked first inside `checkIn`. Whether `BOT_CHECKIN_TOKEN` is set in production is UNKNOWN (not checked).
- Fix: refusals are a typed `CheckInRefusal` and answer 401. A rejected request body keeps its 401. Anything else answers `503 "Check-in could not be completed."` and logs the fixed line `bot-check-in unavailable`. `checkIn` treats a signature the verifier cannot parse as a non-matching signature.
- Regression tests (`web/test/access-control-boundaries.test.ts`, "bot check-in > route"): "reports a storage get failure as unavailable, without the internal error text", the same for set, "gives a caller without the token nothing about a misconfigured store", and "answers a malformed signature with the fixed refusal, not the verifier's error text". Before the fix the storage and malformed-signature tests FAILED (`expected 401 to be 503`; error `invalid signature length`). After the fix all PASS. The misconfigured-store test was added after the review and was run only after the fix; its failure before the fix follows from the old catch-all and was observed by the independent reviewer's probe, not by this test.
- Review: an independent reviewer read the diff and ran its own 16-case probe against the real route handler: PASS for both. Its four low findings (message-prefix matching, no log line, a clock-dependent test, document errors) are applied in this candidate. A second fresh reviewer then checked the final candidate: PASS on all five items, with its own 26-case probe (26 passed), including a storage error whose message imitates a refusal (503, as intended).
- Left as is: a rejected request body still answers 401 with the JSON parser's text about the caller's own body, and a caller without the token can tell a misconfigured store (503) from a healthy one (401).

No other reachable authorization failure was found. The receipt, records, commitment, recovery, agreement and cron boundaries held under every manipulation tried.

## Ambiguities

These are not settled by the documents or tests, so they are not treated as bugs.

1. Bot check-in. `LAUNCH.md:72` says not to revive bot-token settings; H:613 calls it a retained route. Its message (`web/lib/points.ts:17`) binds only the address and the UTC day, not origin, chain or contract, and it accepts EOA signatures only. A signature given to the bot for one deployment is valid on the other for the same day. Binding it would break the external bot client, so it needs an owner decision. The token has no minimum length, unlike the 16-character cron secret.
2. `/api/points` and `/api/wallet-nfts` answer for any address. The handoff says "Public GET" but does not say whether enumeration is acceptable.
3. Contract-wallet signatures: H:514 says "not implemented", SEC:49 says ERC-1271 and ERC-6492 are accepted. The code and tests follow SEC.
4. Owner reveal: the contract lets the owner reveal (`LabxRaffle.sol:748`), but the web recovery path returns the commitment to the creating seller only (`workflow-records.ts:32`).
5. Pause scope: `createRaffle`, `updateDraft` and `escrow` work while paused. The documents do not say whether that is intended.
6. A coordinator proposal made by the previous owner stays pending across an ownership change and the next owner can apply it. Pinned as observed behavior in `OwnerOnlyAccess.t.sol`, not as a requirement.
7. Signed requests carry no nonce. A captured request can be replayed until its deadline. Every signed write is idempotent, and the private reads only return data to someone who already holds the signed request body.
8. The saved receipt email preference is one browser-wide value, not per wallet (see the frontend consistency audit).

## Remaining gaps

- No rate limit on `/api/notifications`, `/api/email/receipt` (which reads the chain before checking the signature), `/api/agreements` or `/api/reserve`. Any key holder can add agreement records without bound. This is availability and cost, not authorization.
- `/api/wallet-nfts` per-client limits rely on `x-vercel-forwarded-for`. Whether a client can spoof it depends on the Vercel edge and was NOT_RUN against production. Limits are in memory per instance.
- The runner rule "not the VRF subscription owner, not a seller" (SEC:54) exists only in the document.
- `revealReserve` and `createReserve` in `web/lib/reserve.ts:98` have no caller in the app. The message there (`:29`) binds no origin or chain. It is dead code and unreachable, mentioned rather than removed.
- The store has no delete and no retention period for agreement records or receipt recipients.
- Contract observations (the contract is deployed and immutable, so none of this was changed): a pending owner can only be overwritten, not cleared; `createRaffle` has no reentrancy guard.
- Not verified here: production configuration, real wallets, real Safe signatures, real VRF.

## Test results

Run on 10 November 2026 against the candidate.

| Command | Result |
|---|---|
| `npx vitest run test/access-control-boundaries.test.ts` before the fix | FAIL: 2 of 9 failed (the two AC-1 tests that existed then) |
| same, after the fix and the review changes | PASS: 12 of 12 |
| `npm --prefix web test` | PASS: 1276 passed, 369 skipped. The skipped tests are the opt-in integration, fork and browser lanes: NOT_RUN |
| `npx tsc --noEmit -p web/tsconfig.json` | PASS |
| `forge test --root contracts --match-contract OwnerOnlyAccessTest` | PASS: 4 of 4 (two fuzz tests, 256 runs each) |
| `forge test --root contracts` | PASS: 131 passed, 1 skipped |

New tests that pin rules which had no test: non-buyer receipt requests, cross-wallet receipt status, the 600-second deadline bound in both message families, check-in token and signature refusals, public points, owner-only setters for any caller, pending-owner acceptance, loss of authority after transfer.
