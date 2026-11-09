# Security flows audit

Date: 10 November 2026. Candidate: branch `audit/access-security-20261110` on top of `main` at `2078b82`. Source and test review by an AI agent, not a formal security audit. All reproductions use synthetic data. No real secret appears in this document, and none was read to write it.

## Trust boundaries

1. Browser to API routes: request bodies, query strings and headers are untrusted. Bodies are read through one bounded reader (`web/lib/chain/request-body.ts`, 64 KiB, strict UTF-8, object only).
2. Chain and NFT metadata to the app: raffle titles, pack names, token URIs, metadata JSON and image URLs are controlled by sellers and third parties.
3. Upstream services to the server: the RPC node, Alchemy (NFT picker), Resend, the key-value store.
4. Server to outputs: HTTP responses, logs, email, the store.
5. Browser storage: readable by any script on the origin and by anyone with the device.

## Untrusted input to sinks

| Source | Sink | Guard | Status |
|---|---|---|---|
| Request fields that become store keys | SQL in `web/lib/store.ts:152,168-172,185-190` | every statement is parameterized against a constant table; keys are fixed prefixes plus a keccak hash or a validated address; the interface has only `get`, `set`, `setIfAbsent`, so there are no pattern scans | safe by reading |
| Store key | local file store | one fixed JSON file, the key is never a path (`store.ts:47`) | safe by reading |
| Store key | Upstash URL path | `encodeURIComponent` (`store.ts:275`) | safe by reading |
| `owner`, `cursor` query on `/api/wallet-nfts` | outbound fetch to Alchemy | host from a fixed table, validated address, cursor set through `searchParams`, key in a header, `redirect: "error"`, 8 s timeout, 2 MiB cap (`web/lib/wallet-nfts-server.ts:102-123,183-189`) | tested, `wallet-nfts.test.ts` |
| Token URI and metadata `image` | browser fetch and `<img src>` | the server never fetches them; `safeArtworkUrl` allows only `https` on a public host name and `ipfs://` (`web/lib/chain/metadata.ts:1-17`); fetch has no credentials, no referrer, no redirects, 64 KiB cap | tested, `metadata.test.ts`, `independent-service-boundaries.test.ts:151` |
| Metadata `name`, `description`, raffle title, pack names | rendered text | React text nodes; control characters stripped and lengths capped (`metadata.ts:20`); there is no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in `web/app`, `web/lib`, `web/components`, `web/hooks` | safe by grep |
| Feed item `href` | `<Link href>` | must equal `/review/<id>` or `/piece/<id>` on the server (`web/lib/notifications/events.ts:95-99`) and again in the client (`web/components/NotificationFeed.tsx:191-193`) | safe by reading |
| Purchase event fields | receipt email HTML (`web/lib/email.ts`) | derived from the verified chain event, not from the request (`web/lib/purchase-proof.ts:31`); HTML-escaped | SF-2 below |
| Receipt recipient | mail `to` | no whitespace, one `@`, at most 254 characters (`web/lib/receipt-delivery.ts:24`); sent as JSON, so no header injection; `from` checked for CR and LF (`:27`) | tested, `receipt-agreement.test.ts` |
| Admin alert content | notification email | fixed label, numeric id, ISO time, fixed-shape link; fixed recipient (`web/lib/notifications/delivery.ts:9,200-213`) | tested, `notification-delivery.test.ts` |
| Any input | command execution, dynamic import, file upload | none exists | safe by grep |
| Request input | redirects | the only redirect is the static `/terms` to `/legal` in `web/next.config.ts` | safe by reading |

## Sensitive data to outputs

| Data | Output | Finding |
|---|---|---|
| Commitment salt and private hash | response | returned only by `/api/reserve/reveal` to the creating seller with `no-store`; every other path drops them (`publishedReserve`), tested in `workflow-records.test.ts:35-60` |
| Recipient email | response | only to the buying wallet through `/api/records` (new test in `access-control-boundaries.test.ts`) |
| Recipient email | store | plaintext under `receipt:v2:<hash>` with the full mail payload, no retention period (`receipt-delivery.ts:39`). Gap, below |
| Recipient email | browser storage | `labx-preferences-v1` holds the last saved email for the whole browser (`web/lib/bench.tsx:166`). By design; noted as an ambiguity in the access control audit |
| Salt, signatures, private text | browser storage | not stored. Journals hold public transaction data and are keyed by chain, contract, code hash and account (`web/lib/chain/pending-journal.ts:57-59`); the create record holds the public commit, not the salt (`web/lib/chain/create-flow.ts`) |
| Signatures, request bodies, errors | logs | the server `console.*` calls log fixed labels, counters, public addresses and raffle ids only (`web/lib/workflow-failure.ts:19`, `web/lib/draw-runner/http.ts:46,53`, `web/lib/notifications/http.ts:71`, `web/lib/private-records.ts:45`, and the new fixed line in the check-in route). One browser call, `web/lib/chain/appkit-provider.ts:366`, logs a wallet error object to the visitor's own console |
| API keys | URLs, responses, logs | Alchemy and Resend keys travel in headers; upstream failures return fixed strings (`wallet-nfts.test.ts:278`) |
| Internal error text | responses | workflow routes map errors to fixed messages (`workflow-failure.ts`); agreements returns one fixed message; the receipt route filters by prefix; the bot check-in route returned raw text: SF-1 |
| Anything | analytics, error reporting | no analytics or error-reporting package is installed |

## Findings

### SF-1 Bot check-in returns internal error text (low, confirmed, fixed)

- Flow: store or verifier exception, `web/app/api/bot/check-in/route.ts` catch, `fail(error, 401)`, `web/lib/http.ts:5-8`, response body.
- Reproduction with synthetic data: with the bot token set, make the store's `get` reject with `connect ECONNREFUSED db-internal.example:5432 user=labx_owner`. Before the fix the response was 401 with that exact text. Neon errors are already collapsed to "Store request failed." inside the store, but Upstash network errors and local file errors are not (`store.ts:307`).
- Reach: a caller without the token could see the store's configuration error text when the store was misconfigured, because the store is constructed before the token check. Read, write and verifier errors need the bot token. Impact is limited to whatever those components put in an error message.
- Fix and tests: same change as AC-1 in `access-control.md`. FAIL before, PASS after.

### SF-2 Receipt email left three values unescaped (latent, not reachable, fixed)

- Flow: `receiptBody` in `web/lib/email.ts:23` interpolated `entries`, `priceUsdc` and `feeUsdc` into HTML without escaping while escaping `piece` and `pack`.
- Reach: none today. All five values come from the decoded on-chain event (`purchase-proof.ts:31`), and the three are numbers or digit strings. The risk was a later caller passing text.
- Reproduction: `receiptBody({ ..., priceUsdc: '<img src=x onerror="alert(\'1\')">' })` produced that markup verbatim in `html`.
- Fix: escape all interpolated values at the HTML boundary.
- Regression test: `web/test/security-flows.test.ts` "escapes every interpolated value, so no field can add markup". FAILED before (`expected … not to contain '<img'`), PASSES after.

## Unverified suspicions

- Feed amplification: each new `(cursor, limit)` on the public `/api/notifications` triggers a deployment check and up to 64 RPC reads (`web/lib/notifications/public-feed.ts:35-49`). Any in-range `before.N` is valid, the cache holds 128 entries, and nothing rate-limits the route. Not load-tested.
- `/api/email/receipt` reads the chain before validating the body or the signature (`web/app/api/email/receipt/route.ts:15`). Unauthenticated requests cost RPC calls. Not load-tested.
- NFT picker denial: a few clients rotating owners could use the 120 per minute global upstream budget. Depends on instance count; not tested.
- Header trust: the per-client bucket uses `x-vercel-forwarded-for`. Spoofing depends on the Vercel edge. NOT_RUN against production.
- Upstash and file-store error text can reach a client only through a route that returns raw messages. After SF-1 none is known, but the receipt route passes any message starting with `Store ` or `Persistent Redis`.
- The file store reads `all[key]` without an own-property check (`store.ts:51`). Every key in use has a prefix, so no caller can name `constructor`. Local development only.

## Remaining gaps

- Response headers set only `frame-ancestors 'none'`, `X-Frame-Options` and `nosniff` (`web/next.config.ts:16-18`). There is no script Content-Security-Policy. With no HTML injection sink found this is defense in depth, and adding one needs care with the wallet SDK.
- Recipient emails and agreement signatures are stored in plaintext with no deletion or retention rule.
- A buyer can direct a LABx receipt to three arbitrary addresses per purchase. This is the documented correction feature, bounded by the cost of a purchase.
- Seller-controlled image URLs load in the visitor's browser, which reveals the visitor's IP address to that host. No referrer or credentials are sent.
- Production logs, provider dashboards and deployed environment values were not inspected: UNKNOWN.

## Test results

Run on 10 November 2026 against the candidate.

| Command | Result |
|---|---|
| `npx vitest run test/security-flows.test.ts` before the fix | FAIL: 1 of 1 |
| same, after the fix | PASS: 1 of 1 |
| `npx vitest run test/access-control-boundaries.test.ts` (SF-1 tests) | FAIL before, PASS after |
| `npm --prefix web test` | PASS: 1276 passed, 369 skipped (opt-in lanes NOT_RUN) |
| `npx tsc --noEmit -p web/tsconfig.json` | PASS |
