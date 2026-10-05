# LABx

Membership packs for escrowed pieces on Ethereum Sepolia. Bonus entries come with the pack. Chainlink VRF v2.5 draws after an entry snapshot. The treasury and admin are a Safe.

Operator: Fantom Labs Pty Ltd · ABN 56 702 056 166 · ACN 702 056 166 · [labx.art](https://labx.art)

Mainnet is disabled.

## Layout

- `contracts` Foundry: `LabxRaffle`, Sepolia and local scripts, tests
- `web` Next.js bench: explore, piece, studio, profile, fairness, draw rules
- `DESIGN.md` materials and tokens
- `SECURITY.md` threat notes
- `LEGAL.md` counsel draft
- `LAUNCH.md` Sepolia checklist and environment

## Contracts

```bash
cd contracts
forge test
slither . --config-file slither.config.json --exclude-dependencies
forge script script/DeploySepolia.s.sol:DeploySepolia --rpc-url "$SEPOLIA_RPC_URL" --broadcast
```

Pack price is USDC. Each pack also charges 5 USDC to the treasury at settlement. ETH is an optional Uniswap exact-output swap priced with Chainlink ETH/USD. Entries expire after 365 days and are snapshotted before VRF.

## Web

```bash
cd web
npm install
npm test
npm run dev
```

Vercel root directory: `web`.

The bench runs without a deployed contract so the console can be reviewed. Wiring `NEXT_PUBLIC_RAFFLE_ADDRESS` enables the Sepolia wallet gate. The wallet gate rejects chain id 1.

## Environment

See `.env.example`. The launch-critical names are:

- `SAFE_ADDRESS`
- `DEPLOYER_PRIVATE_KEY`
- `SEPOLIA_RPC_URL`
- `VRF_SUBSCRIPTION_ID`
- `AMOE_SIGNER` and `AMOE_SIGNER_PRIVATE_KEY`
- `TERMS_HASH`
- `RESEND_API_KEY` and `RESEND_FROM`
- `BOT_CHECKIN_TOKEN`
- `NEXT_PUBLIC_RAFFLE_ADDRESS`
- `NEXT_PUBLIC_RPC_URL`

`LAUNCH.md` lists the Sepolia addresses for VRF, USDC, and the optional ETH route.
