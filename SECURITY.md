# LABx security

LABx v1.0 is an Ethereum Sepolia membership-pack contract plus a Next.js bench. Mainnet (chain id 1) is rejected in the constructor, the deploy scripts, and the wallet gate.

## Assets

- Escrowed ERC-721 prize.
- USDC principal (pack price) and the 5 USDC lab fee, both 6-decimal.
- VRF subscription LINK, held by Chainlink, not by this contract.
- Server records: private commitment plaintext, points, captcha challenges, agreement log, receipt requests.

## Roles

| Role | Held by | Powers |
| --- | --- | --- |
| Owner | Safe, after `acceptOwnership` | Pause, treasury, terms hash, VRF config, ETH path, cancel, abort a stuck draw, settle an unrevealed draw after 7 days |
| Seller | Piece creator | Escrow, open, close early, request VRF, reveal, cancel only before money arrives or when the snapshot is empty |
| AMOE signer | Server key | One complimentary entry signature per account per piece |
| Buyer | Any wallet | Buy a pack, refund after cancel |

There is no renounce. Admin stays a Safe.

## Draw integrity

1. The seller commits `keccak256(abi.encode(chainId, labx, nonce, nft, tokenId, publicHash, privateHash, salt))` before packs open. The plaintext stays off-chain. Reveal submits hashes, not the private text.
2. The prize token is escrowed before `open`.
3. Buys stop at `close` or at `salesEnd`.
4. `snapshot` walks lots in chunks of at most 500 and skips lots whose 365-day expiry has passed. VRF cannot be requested until the cursor finishes.
5. `requestRandomness` calls Chainlink VRF v2.5 (`nativePayment: false`, 3 confirmations, 500k callback gas). The coordinator must be the caller of `rawFulfillRandomWords`.
6. The word walks a cumulative weight table with a binary search. Entries that arrive after the snapshot are absent from that table.
7. Settlement pays principal to the seller, the lab fee to the treasury, and the token to the winner. The fee is escrowed until then, so a cancel can refund both principal and fee.

## ETH route

Optional. USDC is the unit of account. `buyPackWithEth` reads Chainlink ETH/USD (8 decimals, 3 hour stale bound, round completeness), requires the buyer to cover that quote plus slippage (max 10%), wraps to WETH, and swaps exact-output USDC on SwapRouter02. Surplus WETH is unwrapped and returned. Direct ETH transfers from anyone but WETH revert.

## Reentrancy

State changes that follow token or coordinator calls are inside `nonReentrant`. Cancel and abort set `Cancelled` before the prize token moves. Escrow sets the escrow flag before `safeTransferFrom`. A malicious prize token that calls back into `buyPack` reverts. Slither is run with dependencies excluded. Remaining reentrancy notes are the external calls inside the guard (router, coordinator, NFT). They are accepted because the guard blocks cross-function reentry and checks-effects-interactions is used for settlement and refunds.

## Server

- `BOT_CHECKIN_TOKEN` is compared in constant time and is never sent to the browser.
- Complimentary entry requires the captcha HMAC, 10 points from a bot check-in, the three agreements, and one claim per piece.
- Reveal of a commitment requires a wallet signature from the seller. The API returns hashes and the public summary, not the private plaintext.
- Resend is used only when `RESEND_API_KEY` and `RESEND_FROM` are set. Otherwise the receipt route reports that it did not send.
- On Vercel, set Upstash. The file store is for a single machine. `/tmp` on Vercel is ephemeral.

## Known limits

- Snapshot gas grows with lots. Callers must chunk.
- A winner that cannot receive ERC-721 blocks settlement until they can.
- The ETH route depends on a liquid WETH/USDC pool at the configured fee. If that pool is thin, disable it with `WIRE_ETH_PATH=false`.
- The signer key can mint complimentary entries. Keep it off the client and rotate it through the Safe.
- This document is an engineering note, not a pentest.

## Commands

```bash
cd contracts && forge test
cd contracts && slither . --config-file slither.config.json --exclude-dependencies
cd web && npm test
```
