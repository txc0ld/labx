# LABx

Membership packs for escrowed NFTs. Each purchased pack includes its published number of bonus raffle entries. The current contract source targets Ethereum Sepolia and uses Chainlink VRF v2.5 after a completed entry snapshot. It has no free-entry issuance.

Operator: Fantom Labs Pty Ltd · ABN 56 702 056 166 · ACN 702 056 166. The public origin is configured with `NEXT_PUBLIC_SITE_URL`.

## Current status

The v2 contract changes and complete website workflow are local implementation work. Their acceptance evidence and remaining checks are recorded in [the workflow checkpoint](docs/build/full-workflow-20261006.md). A passing source test does not establish that production or an existing deployed contract has the same behavior.

The historical Sepolia address is not an approved v2 deployment. Its owner and pending ownership target had no deployed code at the last recorded read-only check. A correctly configured Safe remains an operational requirement, not a verified fact about that deployment. No production, ownership, funding or on-chain change is implied by this source tree.

## Layout

- `contracts`: Solidity source, Foundry tests and isolated local/Sepolia deployment scripts.
- `web`: Next.js pages, wallet/contract services and authenticated records.
- `docs/build`: task contracts, candidate revisions and evidence pointers.
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
npm run build
npm run dev
```

Vercel's project root is `web`. A catalog without an approved deployment must show its unavailable state; do not add invented listings or wallet activity to fill it.

## Contract policy

Sellers can edit a draft. Opening fixes the prize, pack economics, closing time, terms, treasury and randomness configuration for that raffle. Sales cannot close early. Each pack charges its price plus a 5 USDC lab fee; bonus entries expire after 365 days.

Anyone can enable refunds if a draw has not started seven days after sales end, or if no randomness is accepted within seven days of the request. Results at or after the callback cutoff are ignored. There is no reroll. Anyone can settle a recorded winner after the seller reveals or the seven-day reveal grace expires. Prize, seller proceeds, treasury fees and buyer refunds have separate claim paths.

Pausing blocks new admissions and opening, while recovery and existing claims remain available. Operator discretion, external dependencies and chain conditions remain relevant; this is not a zero-risk or formal-audit claim.

## Configuration

Use `.env.example` for names, never for credentials. Durable server records require both Upstash settings on Vercel. Local file persistence is for a single development process.

A public contract address alone must not enable financial actions. The v2 portal requires an approved deployment manifest and verifies chain, bytecode, contract version and payment token. Approval of a new manifest and any hosted release are separate from local source implementation. See [LAUNCH.md](LAUNCH.md).
