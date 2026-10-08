# LABx

Membership packs for escrowed NFTs. Each purchased pack includes its published number of bonus raffle entries. The current contract source targets Ethereum Sepolia and uses Chainlink VRF v2.5 after a completed entry snapshot. It has no free-entry issuance.

Operator: Fantom Labs Pty Ltd · ABN 56 702 056 166 · ACN 702 056 166. The public origin is configured with `NEXT_PUBLIC_SITE_URL`.

## Current status

The source registry now includes the verified v3 Sepolia contract `0x8b0332D0ca48908e174F42eA1b3123e63f3F4327`, created at block 11865781. The Safe `0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1` accepted ownership and is the pinned treasury. Native-ETH VRF billing is configured; membership purchases use USDC, with the optional ETH purchase route disabled. See [the activation record](docs/build/v3-sepolia-registration-20261008.md) for exact manifest and verification evidence. Hosted selection and release are separate checks. Durable hosted storage is still a separate configuration blocker for seller commitments and buyer agreement recording; registration alone does not make those flows ready.

This is a Sepolia testing deployment. The Safe's threshold of one is testing-only. Human review remains required for each raffle. Deployment verification does not establish a completed live Chainlink raffle lifecycle; that test remains separate.

The v2 contract `0xef27306567a5ADA354fe9403008D041d0b468213` and older contract `0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C` remain excluded from current transactions. Updating the website does not change their bytecode or migrate their entries, balances or claims.

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

Use `.env.example` for names, never for credentials. Hosted durable records use an explicit provider: set `LABX_STORE=neon` with the server-only pooled `DATABASE_URL` (the existing server-only `NEON_DATABASE` name is accepted as an alias), or set `LABX_STORE=upstash` with both Upstash values. If both Neon variable names are present, they must be identical. Credentials must never use a `NEXT_PUBLIC_*` name. Missing, conflicting, unknown and ephemeral hosted selections fail closed. Local development with no selection uses `web/data/store.json` in one process; explicit `file` and `memory` modes are local-only.

Before selecting Neon in a hosted environment, apply [`web/db/migrations/001_labx_store.sql`](web/db/migrations/001_labx_store.sql) with a direct, non-pooled migration connection and verify the table columns and named constraints. The application role needs schema `USAGE` and table `SELECT`, `INSERT` and `UPDATE`; migration credentials stay separate. Inventory existing durable records before a provider switch. This repository does not migrate Redis or local-file records, and preview and production must not unintentionally share private records.

A public contract address alone must not enable financial actions. The v3 portal requires an approved deployment manifest and verifies chain, bytecode, contract version and payment token. Approval of a new manifest and any hosted release are separate from local source implementation. See [LAUNCH.md](LAUNCH.md).
