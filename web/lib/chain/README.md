# Workflow service configuration and evidence

The browser uses `configuredBrowserService()`. A public raffle address alone does not authorize writes. `APPROVED_DEPLOYMENTS` in `deployment.ts` contains the verified Sepolia v3 deployment `0x8b0332D0ca48908e174F42eA1b3123e63f3F4327`; see [the registration record](../../../docs/build/v3-sepolia-registration-20261008.md). Unknown, historical and mainnet deployments are not registered. Its manifest binds chain ID, contract address, runtime hash, version 3, deployment block, USDC address, expected owner and the complete expected raffle policy. RPC reads and simulations use explicit block numbers; pagination retains the block hash. The historical Sepolia address remains unavailable for writes.

Manifest review must also verify the real coordinator and subscription, LINK/native billing and funding, owners/threshold/authority, treasury, USDC, router/oracle, published terms hash and monitoring/recovery procedures. Runtime attestation is not a Safe or trusted-dependency audit. Existing contracts do not inherit source changes.

`NEXT_PUBLIC_RAFFLE_ADDRESS` selects an approved Sepolia manifest. `NEXT_PUBLIC_RPC_URL` supplies its RPC. `NEXT_PUBLIC_SITE_URL` must equal the actual website origin for signed backend requests. The opening policy and accepted membership terms must match `PUBLISHED_TERMS_HASH` from `../published-terms.ts`; never invent a hash or silently adopt one returned by an API. Published section text, version and serialization determine that hash.

Vercel requires `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for durable records. Local file persistence is for a single development process; `LABX_STORE=memory` is disposable test storage. Receipt mail additionally requires `RESEND_API_KEY` and `RESEND_FROM`; missing configuration is reported as unavailable. Credentials are not browser variables. No AMOE/CAPTCHA signing key is used. The remaining bot token supports only historical non-entry check-ins, with no points-to-entry path.

## Local fixture only

A development server on `localhost`/`127.0.0.1` may use `NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST`, JSON with `chainId:31337`, `version:3`, `address`, `runtimeCodeHash`, `usdc`, decimal-string `deploymentBlock`, `expectedOwner` and `expectedPolicy`. Both parsers require every policy member. `subscriptionId` and `minBuyerFeeUsdc` are decimal strings; `callbackGasLimit`, `requestConfirmations`, `buyerFeeBps` and `sellerFeeBps` are bounded integers; `nativePayment` is a boolean; the remaining members are `coordinator`, `treasury`, `termsHash` and `keyHash`. `NEXT_PUBLIC_LOCAL_RPC_URL` must be loopback. Both browser and server reject this override outside development. No fixture manifest is committed or approved for production.

Run from the repository root:

```
forge build --root contracts
RUN_CHAIN_INTEGRATION=1 npm --prefix web test
web/node_modules/.bin/tsc --noEmit --project web/tsconfig.json
npm --prefix web run build
```

The integration suite starts disposable Anvil on an ephemeral loopback port and uses only its unlocked fixture accounts. It requires `anvil` and compiled Forge artifacts. Without `RUN_CHAIN_INTEGRATION=1`, those tests are explicitly skipped. Tests cover real service transactions through membership purchases, draw, settlement, claims, refunds, rejection, replacement and reload recovery. They do not establish live Sepolia readiness.

The browser fixtures import the repository's pinned `playwright` package. Run `npx --prefix web playwright install chromium` once before browser acceptance. Playwright selects its installed Chromium by default; set `CHROMIUM_EXECUTABLE` only to use a specific executable. `RUN_BROWSER_ACCEPTANCE`, `RUN_SELLER_PORTAL_BROWSER` and `RUN_PRIVATE_RECORDS_BROWSER` enable the three Anvil-backed browser lanes.

## UI binding

Call `prepare`, show the returned transaction review, then call `submit` only after the user's explicit confirmation. Wallet account/network changes invalidate the review. Repeated submissions are locked while confirmation is pending. An uncertain wallet response requires checking wallet activity and using `resume` with its actual hash. `confirm` distinguishes pending, reverted, replaced and confirmed transactions; refresh authoritative state after confirmation. Two confirmations used for UI progress are not finality; purchase receipts require a finalized block.

Authenticated `api.ts` helpers request a scoped wallet signature only when called. Commitment recovery reveals hashes/salt only to the seller. Agreements are assertions, not proof of age or legal clearance. Receipt and private-record APIs verify their wallet and deployment scope. Never put recovered commitment data or authorization signatures in localStorage, analytics or logs.

Artwork reads use bounded on-chain tokenURI data and safe display URLs. Remote JSON is fetched only in the browser with omitted credentials/referrer, no redirects, an 8-second timeout and a 64-KiB limit; no arbitrary metadata URL is fetched by the server. Failed/unsupported metadata returns a null image. No listings, entries or artwork are fabricated.

## Action-specific trust

`assertActionTrust` checks the expected owner and an empty pending owner at a canonical block. Approval and opening additionally require no pending coordinator and exact equality of all current opening-policy fields. Quotes, USDC approvals and purchases require the raffle's frozen policy to match the manifest and admission at opening by the expected owner. Future global policy or coordinator changes do not block purchases in an already approved raffle with the expected frozen policy.

The builder repeats these checks during the existing submission/export rebuild before a wallet transaction or Safe payload is returned. The UI checks trust separately and blocks only new approvals, openings and purchases. Runtime identity, catalog reads, revocation, private commitment recovery, draws, claims, refunds and historical receipt/journal reconciliation remain independent of mutable trust settings. These checks do not reserve future authority, subscription funding or NFT authenticity.

## Admission and processing fees

Before opening, the current owner reviews the exact NFT collection/token, custody, transfer restrictions, draft economics and use of draw funding. Draft revisions, owner generations and opening-policy generations invalidate an earlier review even if values are restored. Both opening selectors enforce the same contract approval. Approval becomes historical after opening and never gates buyer recovery or claims.

`readOwner` and `readAdmission` pin their reads to a canonical block. `/review` scans bounded pages, including empty filtered pages with a next cursor. The page does not infer NFT authenticity from its name, artwork, code presence or `ownerOf`. Human review remains necessary.

A Safe owner prepares the two admission actions, exports the exact zero-value payload for external Safe execution, then supplies the actual Ethereum execution hash. Public persisted intents are decoded through `parseOwnerExecutionIntent`; no private commitments or signatures belong in this storage. Confirmation requires the exact raffle event, matching owner/digest/revision, sufficient confirmations and canonical review/receipt/state blocks. A Safe proposal hash is not an Ethereum execution hash. This path does not submit a Safe proposal or replace the EOA financial journal.

For each successful purchase call, the processing fee is `max(2_500_000, floor(principal * buyerFeeBps / 10_000))` USDC atomic units under the pinned policy. Principal is pack price multiplied by quantity. Each separate call incurs its own minimum. Cancelled raffles return principal only; historical `feeOf` remains nonrefundable and must never enable another refund. Treasury collects retained processing fees only after settlement or cancellation. The separate seller commission is charged only at settlement. Current terms define rounding and ETH-route refund denomination; archived v2 terms retain their original policy.

## Pending transaction recovery

Browser writes require localStorage and the Web Locks API in a secure browser context. If either is unavailable, the service refuses new writes. A deployment/runtime/account-scoped journal stores only an intent digest, nonce, starting block, public transaction hash (when known), and random record ID. It never stores calldata, reveal salt, private commitments or signatures. Normal reloads and another tab cannot bypass an unresolved intent.

The wallet adapter invokes `beforeRequest` after its initial session check so the service can claim the journal. It then validates the session again after that asynchronous callback. Only after this final check does it invoke the separate synchronous `onProviderRequest` marker and call the provider. Identity changes during journal acquisition clear the matching prepared journal without leaving a phantom submission. Explicit wallet rejection clears that matching record; an ambiguous post-send error keeps it. Use the wallet's actual transaction or same-nonce replacement/cancellation hash to reconcile. The website offers no manual clear shortcut. An unrelated older hash cannot overwrite or clear the pending action. Canonical mined confirmation is checked before releasing the guard; a reverted transaction or confirmed replacement also resolves its nonce.

This protects normal website use, not deliberate browser-storage deletion, another device, or transactions sent outside LABx. Wallets must honor the requested sender/network/nonce. An ambiguous request with no known hash requires examining wallet activity and, if necessary, completing a same-nonce wallet replacement. Contract rules remain authoritative.

For deterministic Node/Anvil tests, inject one shared `memoryPendingJournal()` into recreated service instances. It is never the browser persistence fallback.
