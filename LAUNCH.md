# LABx Sepolia launch

Do not deploy to Ethereum mainnet. `DeploySepolia` reverts unless chain id is 11155111. `LabxRaffle` reverts in the constructor on chain id 1.

## 1. Safe

Create a Safe on Sepolia. That address is both treasury and admin.

`SAFE_ADDRESS`

The deployer key is only a proposer. After deploy it calls `transferOwnership(SAFE_ADDRESS)`. The Safe must call `acceptOwnership`.

`DEPLOYER_PRIVATE_KEY`  
`SEPOLIA_RPC_URL`

## 2. Chainlink VRF v2.5

Create a subscription on the Sepolia VRF v2.5 coordinator and fund it with Sepolia LINK from the Chainlink faucet.

| Item | Value |
| --- | --- |
| Coordinator | `0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B` |
| 500 gwei key hash | `0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae` |
| LINK | `0x779877A7B0D9E8603169DdbD7836e478b4624789` |
| Confirmations | 3 |
| Callback gas | 500000 |

`VRF_SUBSCRIPTION_ID`  
`VRF_COORDINATOR` (optional, default above)  
`VRF_KEY_HASH` (optional, default above)

After the raffle address exists, the subscription owner adds it as a consumer:

```bash
cd contracts
RAFFLE_ADDRESS=0x... VRF_SUBSCRIPTION_ID=... \
  forge script script/DeploySepolia.s.sol:AddVrfConsumer --rpc-url "$SEPOLIA_RPC_URL" --broadcast
```

## 3. USDC, terms, signer

USDC on Sepolia (Circle, 6 decimals): `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`

`TERMS_HASH` is `bytes32`, the keccak of the published terms text.  
`AMOE_SIGNER` is the address of the server key.  
`AMOE_SIGNER_PRIVATE_KEY` stays on the server. The contract stores only the address.

## 4. Deploy

```bash
cd contracts
forge script script/DeploySepolia.s.sol:DeploySepolia --rpc-url "$SEPOLIA_RPC_URL" --broadcast
```

Optional ETH route, off unless `WIRE_ETH_PATH=true`. Router, WETH, feed, and pool fee are fixed at deploy:

| Item | Sepolia default |
| --- | --- |
| SwapRouter02 | `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E` |
| WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| ETH/USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` |
| Pool fee | 3000 |

`WIRE_ETH_PATH` defaults to false.  
`UNISWAP_POOL_FEE`

Ship USDC only until the WETH/USDC pool at that fee is liquid and the swap deadline path has been checked on Sepolia. The owner cannot point the path at a different router later. Coordinator changes wait one day and are refused during a draw.

## 5. Vercel

Set the project root to `web`.

`NEXT_PUBLIC_CHAIN_ID=11155111`  
`NEXT_PUBLIC_RPC_URL`  
`NEXT_PUBLIC_RAFFLE_ADDRESS`  
`NEXT_PUBLIC_USDC_ADDRESS`

`RESEND_API_KEY`  
`RESEND_FROM` such as `LABx <draw@labx.art>`

`BOT_CHECKIN_TOKEN`  
`CAPTCHA_SECRET`

`UPSTASH_REDIS_REST_URL`  
`UPSTASH_REDIS_REST_TOKEN`

Without Upstash, serverless instances do not keep points or commitments. Local dev uses `web/data/store.json`.

## 6. Bot

The check-in route is `POST /api/bot/check-in` with header `x-labx-bot-token` and a body `{ address, signature }`. The signed message is:

```
LABx bot check-in
<address lowercase>
<UTC day YYYY-MM-DD>
```

Each successful day adds 10 points. The website never embeds the token.

## 7. Smoke

- Safe is the owner.
- Coordinator lists the raffle as a consumer.
- A draft piece can be escrowed and opened.
- A USDC pack pulls price + 5 USDC.
- Close, snapshot, VRF, reveal, settle.
- Cancel refunds a buyer.
- A mainnet wallet sees “Mainnet is disabled.”
