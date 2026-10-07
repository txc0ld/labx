# LABx

Membership packs for escrowed NFTs. Each purchased pack includes its published number of bonus raffle entries. The current contract source targets Ethereum Sepolia and uses Chainlink VRF v2.5 after a completed entry snapshot. It has no free-entry issuance.

Operator: Fantom Labs Pty Ltd · ABN 56 702 056 166 · ACN 702 056 166. The public origin is configured with `NEXT_PUBLIC_SITE_URL`.

## Current status

The prepared v3 release includes the seller portal, raffle admission review and a minimum processing fee. Acceptance work is recorded in [the current task contract](docs/build/seller-portal-fees-20261007.md). The production approval registry remains empty; supplying an address does not enable transactions. A passing source test does not establish live functionality.

The v2 Sepolia contract at `0xef27306567a5ADA354fe9403008D041d0b468213` was verified on 7 October 2026 at block 11861349 with the Safe as owner and treasury, native-ETH VRF configured, and no raffles. That was a point-in-time deployment check, not a completed live raffle test. Its fixed 5-USDC fee cannot be changed by updating this website. Version 3 requires a separately approved deployment and migration. The older contract at `0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C` is also excluded from current transactions.

## Layout

- `contracts`: Solidity source, Foundry tests and isolated local/Sepolia deployment scripts.
- `web`: Next.js pages, wallet/contract services and authenticated records.
- `docs/build`: task contracts, candidate revisions and evidence pointers.
- `docs/build/README.md`: current documentation index and superseded-report labels.
- `SECURITY.md`: trust boundaries and known limits.
- `LEGAL.md`: product notes for counsel, not legal clearance.
- `LAUNCH.md`: separate deployment and migration plan.

## Local checks

```bash
cd contracts
forge build --sizes
forge test --fuzz-runs 1024
```

```bash
cd web
npm ci
npm test
npx tsc --noEmit
npm run build
```

The default web suite does not start Anvil. Build the contracts first, then run the opt-in chain suite:

```bash
forge build --root contracts
RUN_CHAIN_INTEGRATION=1 npm --prefix web test -- --maxWorkers=1
```

Install the pinned Playwright Chromium once and run the portable browser acceptance check:

```bash
npx --prefix web playwright install chromium
node web/test/walletconnect-accessibility.browser.cjs
```

`CHROMIUM_EXECUTABLE=/absolute/path/to/chromium` overrides Playwright's installed browser when an explicit executable is required. The Anvil-backed browser lanes use separate switches so each lane is visible in test output:

```bash
RUN_BROWSER_ACCEPTANCE=1 RUN_SELLER_PORTAL_BROWSER=1 RUN_PRIVATE_RECORDS_BROWSER=1 npm --prefix web test -- --maxWorkers=1
```

Vercel's project root is `web`. A catalog without an approved deployment must show its unavailable state; do not add invented listings or wallet activity to fill it.

See [the build documentation index](docs/build/README.md) for current reports and superseded historical candidates.

## Contract policy

Sellers can edit a draft. LABx must approve its exact NFT and use of draw funding before it can open. Draft edits, policy changes and ownership changes require a fresh approval. Opening fixes the prize, pack economics, closing time, terms, treasury and randomness configuration for that raffle. Sales cannot close early. Each purchase call adds the greater of 2.50 USDC or 2% of its membership principal. The percentage rounds down once in USDC atomic units after multiplying price by quantity. Separate calls each pay their own minimum. Settlement deducts a separate 2% of total membership principal from seller proceeds. Cancellation returns the pack principal only. The processing fee is retained and no seller commission applies. Treasury fees can be claimed only after settlement or cancellation. Bonus entries expire after 365 days.

Anyone can enable refunds if a draw has not started seven days after sales end, or if no randomness is accepted within seven days of the request. Results at or after the callback cutoff are ignored. There is no reroll. Anyone can settle a recorded winner after the seller reveals or the seven-day reveal grace expires. Prize, seller proceeds, treasury fees and buyer refunds have separate claim paths.

Pausing blocks new purchases and opening, while recovery and existing claims remain available. Operator discretion, external dependencies and chain conditions remain relevant; this is not a zero-risk or formal-audit claim.

## Configuration

Use `.env.example` for names, never for credentials. Durable server records require both Upstash settings on Vercel. Local file persistence is for a single development process.

A public contract address alone must not enable financial actions. The v3 portal requires an approved deployment manifest and verifies chain, bytecode, contract version and payment token. Approval of a new manifest and any hosted release are separate from local source implementation. See [LAUNCH.md](LAUNCH.md).
