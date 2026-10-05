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
| Owner | Intended Safe, after `acceptOwnership` | Pause, treasury, terms hash, VRF config, VRF payment mode, ETH path, cancel funded raffles, abort a stuck draw, settle an unrevealed draw after 7 days |
| Seller | Piece creator | Escrow, open, close early, request VRF, reveal, cancel only before money arrives or when the snapshot is empty |
| AMOE signer | Server key | At most `amoeCap` complimentary entries per raffle (default 100). Each captcha digest is single-use |
| Buyer | Any wallet | Buy a pack, refund after cancel |

There is no renounce. A Safe is the intended production admin, not a runtime invariant: the deployer is owner until acceptance, and ownership can transfer to any nonzero address. `DeploySepolia` rejects a `SAFE_ADDRESS` without deployed code before broadcasting; operators must still verify the Safe implementation, signers, threshold, and completed ownership acceptance.

## Draw integrity

1. The seller commits `keccak256(abi.encode(chainId, labx, nonce, nft, tokenId, publicHash, privateHash, salt))` before packs open. `privateHash` is `keccak256(abi.encode(salt, plaintext))`, not a bare hash of the text. The salt and plaintext stay off-chain until a seller-signed reveal that includes the contract and a 10-minute deadline. Reveal submits hashes, not the private text.
2. The prize token is escrowed before `open`.
3. Buys stop at `close` or at `salesEnd`.
4. `snapshot` walks lots in chunks of at most 500 and skips lots whose 365-day expiry has passed. VRF cannot be requested until the cursor finishes.
5. `requestRandomness` calls Chainlink VRF v2.5 (`nativePayment` defaults to false / LINK, 3 confirmations, 500k callback gas). The owner may flip `nativePayment` only while `activeDrawings == 0`. The live Sepolia raffle `0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C` was deployed with LINK billing hardcoded; fund that subscription with LINK until a redeploy can set native ETH. The coordinator that accepted the request is pinned. `rawFulfillRandomWords` accepts only that address. A coordinator change is a one-day timelock and is refused while `activeDrawings` is non-zero. `setVrfConfig` is refused the same way. If a callback fails, Chainlink does not retry: the owner must wait `VRF_ABORT_AFTER` and use `abortDrawing` to enable refunds (clears the request map). `retryRandomness` is retained for ABI compatibility but always reverts with `RandomnessRetryDisabled`; replacing a pending request would let the owner discard an unfavorable result and reroll the winner. This source change requires a new deployment.
6. The word walks a cumulative weight table with a binary search. Entries that arrive after the snapshot are absent from that table.
7. `settle` only records the winner. The winner pulls the NFT with `transferFrom` (so `onERC721Received` cannot revert the claim). The seller pulls USDC principal and anyone can pull the lab fee to the current treasury. Cancel and `abortDrawing` do not push the NFT. The seller pulls it afterwards, and buyers pull their own USDC.

## ETH route

Off unless router, WETH, and the ETH/USD feed were all set at construction. Those three addresses and the pool fee are immutable. The owner can only disable or re-enable that path. `buyPackWithEth` reads Chainlink ETH/USD (8 decimals, 3 hour stale bound, round completeness), caps `amountInMaximum` at the quote plus slippage (max 10%), and requires a deadline inside the next 10 minutes. The swap goes through SwapRouter02 `multicall(deadline, ...)`. Surplus ETH is measured from the WETH balance delta and returned. Direct ETH transfers from anyone but WETH revert. `WIRE_ETH_PATH` defaults to false.

## Reentrancy

State changes that follow token or coordinator calls are inside `nonReentrant`. Cancel and abort set `Cancelled` and leave the NFT in escrow for a later pull. Escrow sets the escrow flag before `safeTransferFrom`. A malicious prize token that calls back into `buyPack` reverts. Slither is run with dependencies excluded. Remaining reentrancy notes are the external calls inside the guard (router, coordinator, NFT). They are accepted because the guard blocks cross-function reentry and USDC pulls are separate from the NFT pull.

## Server

- `BOT_CHECKIN_TOKEN` is compared in constant time and is never sent to the browser.
- Complimentary entry requires the captcha HMAC, 10 points from a bot check-in, and the three agreements. The captcha id is marked spent before any signature. The signer key produces an EIP-712 `AmoeClaim` only after that. Without the key the route stays in bench mode and does not pretend a signature exists.
- Creating a commitment requires `NEXT_PUBLIC_RAFFLE_ADDRESS` and a non-mainnet chain id. The create response omits the salt and the private hash. Reveal requires a seller signature over the commit, the contract, and a deadline, and still omits the plaintext.
- A receipt requires a wallet signature over the sender, recipient, piece, pack, and a 10-minute deadline, then a per-address rate limit. The signature is checked even when Resend is unset. Resend is used only when `RESEND_API_KEY` and `RESEND_FROM` are set.
- On Vercel, set Upstash. The file store is for a single machine. `/tmp` on Vercel is ephemeral.

## Known limits

- Snapshot gas grows with lots. Callers must chunk.
- A prize token that reverts `transferFrom` can stick the NFT in escrow. It cannot stick the USDC, which is pulled on its own calls.
- The ETH route depends on a liquid WETH/USDC pool at the immutable fee. Leave `WIRE_ETH_PATH` unset so the deploy script leaves the path unwired.
- The signer key can mint up to the per-raffle complimentary cap. Keep it off the client. Rotating it is an owner call.
- The owner can force-cancel a funded Open or Closed raffle without a delay. That is accepted v1 centralization (Chain Security H-3). Buyers then pull USDC; the seller pulls the NFT. A pause+timelock on this path is a follow-up, not a silent removal. The owner can also abort a Drawing after one day, including a delayed fulfillment; that cancellation authority and owner-dependent refund liveness remain trust assumptions. Disabling retries prevents same-raffle rerolls, not all owner censorship.
- This document is an engineering note, not a pentest.

## Commands

```bash
cd contracts && forge test
cd contracts && slither . --config-file slither.config.json --exclude-dependencies
cd web && npm test
```
