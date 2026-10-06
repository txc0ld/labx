# Workflow service configuration and evidence

The browser uses `configuredBrowserService()`. A public raffle address alone does not authorize writes. `APPROVED_DEPLOYMENTS` in `deployment.ts` is intentionally empty until a separately approved deployment is reviewed. Its manifest binds chain ID, contract address, runtime hash, version 2, deployment block and USDC address. RPC reads and simulations use explicit block numbers; pagination retains the block hash. The historical Sepolia address remains unavailable for writes.

Manifest review must also verify the real coordinator and subscription, LINK/native billing and funding, owners/threshold/authority, treasury, USDC, router/oracle, published terms hash and monitoring/recovery procedures. Runtime attestation is not a Safe or trusted-dependency audit. Existing contracts do not inherit source changes.

`NEXT_PUBLIC_RAFFLE_ADDRESS` selects an approved Sepolia manifest. `NEXT_PUBLIC_RPC_URL` supplies its RPC. `NEXT_PUBLIC_SITE_URL` must equal the actual website origin for signed backend requests. The opening policy and accepted membership terms must match `PUBLISHED_TERMS_HASH` from `../published-terms.ts`; never invent a hash or silently adopt one returned by an API. Published section text, version and serialization determine that hash.

Vercel requires `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for durable records. Local file persistence is for a single development process; `LABX_STORE=memory` is disposable test storage. Receipt mail additionally requires `RESEND_API_KEY` and `RESEND_FROM`; missing configuration is reported as unavailable. Credentials are not browser variables. No AMOE/CAPTCHA signing key is used. The remaining bot token supports only historical non-entry check-ins, with no points-to-entry path.

## Local fixture only

A development server on `localhost`/`127.0.0.1` may use `NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST`, JSON with `chainId:31337`, `address`, `runtimeCodeHash`, `usdc` and decimal-string `deploymentBlock`. `NEXT_PUBLIC_LOCAL_RPC_URL` must be loopback. Both browser and server reject this override outside development. No fixture manifest is committed or approved for production.

Run from the repository root:

```
forge build --root contracts
RUN_CHAIN_INTEGRATION=1 npm --prefix web test
web/node_modules/.bin/tsc --noEmit --project web/tsconfig.json
npm --prefix web run build
```

The integration suite starts disposable Anvil on an ephemeral loopback port and uses only its unlocked fixture accounts. It requires `anvil` and compiled Forge artifacts. Without `RUN_CHAIN_INTEGRATION=1`, those tests are explicitly skipped. Tests cover real service transactions through membership purchases, draw, settlement, claims, refunds, rejection, replacement and reload recovery. They do not establish live Sepolia readiness.

## UI binding

Call `prepare`, show the returned transaction review, then call `submit` only after the user's explicit confirmation. Wallet account/network changes invalidate the review. Repeated submissions are locked while confirmation is pending. An uncertain wallet response requires checking wallet activity and using `resume` with its actual hash. `confirm` distinguishes pending, reverted, replaced and confirmed transactions; refresh authoritative state after confirmation. Two confirmations used for UI progress are not finality; purchase receipts require a finalized block.

Authenticated `api.ts` helpers request a scoped wallet signature only when called. Commitment recovery reveals hashes/salt only to the seller. Agreements are assertions, not proof of age or legal clearance. Receipt and private-record APIs verify their wallet and deployment scope. Never put recovered commitment data or authorization signatures in localStorage, analytics or logs.

Artwork reads use bounded on-chain tokenURI data and safe display URLs. Remote JSON is fetched only in the browser with omitted credentials/referrer, no redirects, an 8-second timeout and a 64-KiB limit; no arbitrary metadata URL is fetched by the server. Failed/unsupported metadata returns a null image. No listings, entries or artwork are fabricated.

## Pending transaction recovery

Browser writes require localStorage and the Web Locks API in a secure browser context. If either is unavailable, the service refuses new writes. A deployment/runtime/account-scoped journal stores only an intent digest, nonce, starting block, public transaction hash (when known), and random record ID. It never stores calldata, reveal salt, private commitments or signatures. Normal reloads and another tab cannot bypass an unresolved intent.

The wallet adapter invokes its `beforeRequest` callback only after its final session check. The service claims the journal there, immediately before the provider request. Explicit wallet rejection clears that matching record; an ambiguous post-send error keeps it. Use the wallet's actual transaction or same-nonce replacement/cancellation hash to reconcile. The website offers no manual clear shortcut. An unrelated older hash cannot overwrite or clear the pending action. Canonical mined confirmation is checked before releasing the guard; a reverted transaction or confirmed replacement also resolves its nonce.

This protects normal website use, not deliberate browser-storage deletion, another device, or transactions sent outside LABx. Wallets must honor the requested sender/network/nonce. An ambiguous request with no known hash requires examining wallet activity and, if necessary, completing a same-nonce wallet replacement. Contract rules remain authoritative.

For deterministic Node/Anvil tests, inject one shared `memoryPendingJournal()` into recreated service instances. It is never the browser persistence fallback.
