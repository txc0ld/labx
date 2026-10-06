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
| Owner | Intended Safe, after `acceptOwnership` | Pause, treasury, terms hash, VRF config, VRF payment mode, ETH path, immediately cancel funded Open/Closed raffles |
| Seller | Piece creator | Escrow, open, close early, request VRF, reveal, cancel before money arrives or when the snapshot is empty; all public recovery rights also apply |
| AMOE signer | Server key | At most `amoeCap` complimentary entries per raffle (default 100). Each captcha digest is single-use |
| Buyer | Any wallet | Buy a pack, pull their own principal plus fee after cancellation |
| Public caller | Any wallet | Cancel Open/Closed at salesEnd + 7 days, abort Drawing at request time + 7 days, settle after reveal or drawnAt + 7 days |

There is no renounce. A Safe is the intended production admin, not a runtime invariant: the deployer is owner until acceptance, and ownership can transfer to any nonzero address. `DeploySepolia` rejects a `SAFE_ADDRESS` without deployed code before broadcasting; operators must still verify the Safe implementation, signers, threshold, and completed ownership acceptance.

## Draw integrity

1. The seller commits `keccak256(abi.encode(chainId, labx, nonce, nft, tokenId, publicHash, privateHash, salt))` before packs open. `privateHash` is `keccak256(abi.encode(salt, plaintext))`, not a bare hash of the text. The salt and plaintext stay off-chain until a seller-signed reveal that includes the contract and a 10-minute deadline. Reveal submits hashes, not the private text.
2. The prize token is escrowed before `open`.
3. Buys stop at `close` or at `salesEnd`.
4. `snapshot` walks lots in chunks of at most 500 and skips lots whose 365-day expiry has passed. VRF cannot be requested until the cursor finishes.
5. `requestRandomness` requires a completed nonempty snapshot and must execute strictly before `salesEnd + DRAW_START_GRACE`, where the grace is seven days. At or after that deadline anyone can cancel Open/Closed, including while paused or with an incomplete snapshot. An accepted request gets its own seven-day callback window. `rawFulfillRandomWords` accepts a result only from the pinned coordinator and strictly before `vrfRequestedAt + VRF_ABORT_AFTER`. At or after that cutoff, results are ignored even if cancellation has not run; anyone may call `abortDrawing`, which clears both request maps and enables buyer refunds. Retry remains disabled and cannot extend either deadline.

   VRF v2.5 defaults to LINK billing, three confirmations and 500k callback gas. Payment-mode and configuration changes require no active drawings; coordinator changes also wait one day. Expired requests still count as active until someone aborts them. Historical notes identify LINK-billed bytecode at Sepolia `0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C`; this address and its funding were not rechecked for this source change. Existing deployments do not acquire these recovery rules.
6. The word walks a cumulative weight table with a binary search. Entries that arrive after the snapshot are absent from that table.
7. The timely callback records the winner. Anyone may call `settle` immediately after a valid reveal, or at/after `drawnAt + REVEAL_GRACE` without one. The grace is seven days. Settlement only changes phase and never redirects payees. The winner pulls the NFT with `transferFrom` (so `onERC721Received` cannot revert the claim). The seller pulls USDC principal and anyone can pull the lab fee to the current treasury. Cancel and `abortDrawing` do not push the NFT. The seller pulls it afterwards, and buyers pull their own USDC.

## ETH route

Off unless router, WETH, and the ETH/USD feed were all set at construction. Those three addresses and the pool fee are immutable. The owner can only disable or re-enable that path. `buyPackWithEth` reads Chainlink ETH/USD (8 decimals, 3 hour stale bound, round completeness), caps `amountInMaximum` at the quote plus slippage (max 10%), and requires a deadline inside the next 10 minutes. The swap goes through SwapRouter02 `multicall(deadline, ...)`. Surplus ETH is measured from the WETH balance delta and returned. Direct ETH transfers from anyone but WETH revert. `WIRE_ETH_PATH` defaults to false.

## Reentrancy

State changes that follow token or coordinator calls are inside `nonReentrant`. Cancel and abort set `Cancelled` and leave the NFT in escrow for a later pull. Escrow sets the escrow flag before `safeTransferFrom`. A malicious prize token that calls back into `buyPack` reverts. Slither is run with dependencies excluded. Remaining reentrancy notes are the external calls inside the guard (router, coordinator, NFT). They are accepted because the guard blocks cross-function reentry and USDC pulls are separate from the NFT pull.

## Server

- `BOT_CHECKIN_TOKEN` is compared in constant time and is never sent to the browser.
- Complimentary entry requires the captcha HMAC, 10 points, strict agreement assertions, and fresh wallet authorization bound to the origin, mode, chain, contract, raffle, piece, captcha and terms version. Signed issuance requires a nonzero terms hash. The server prepares the EIP-712 signature internally, atomically persists the claim result and captcha consumption, and returns only after acknowledgement. An authenticated retry validates the stored identity, context, fields and EIP-712 signer before recovering the same unexpired result. Corrupt records, expired signatures, signer/terms/context changes and old consumed records require reconciliation; automatic renewal is deliberately absent. Bench mode does not pretend a chain signature exists.
- Creating a commitment requires `NEXT_PUBLIC_RAFFLE_ADDRESS` and a non-mainnet chain id. The create response omits the salt and the private hash. Reveal requires a seller signature over the commit, the contract, and a deadline, and still omits the plaintext.
- A receipt requires a fresh origin/chain/contract-bound wallet signature over its recipient and transaction/log identity, plus a successful finalized `PackPurchased` event from the configured Sepolia contract and buyer. Amounts come from the event, not the request. Each purchase is atomically bound to one recipient and an immutable email payload. Retries reuse the provider idempotency key for less than 23 hours; unresolved older jobs or changed provider credentials require reconciliation. The credential fingerprint is one-way; raw keys are never stored in receipt records. This verifies purchase and wallet authorization, not ownership of the recipient's mailbox. No real email is issued from browser demo records.
- Server agreement records require strict boolean assertions, a configured nonzero terms hash and fresh wallet signature bound to origin/chain/contract/piece/version. Records are normalized and idempotent. This proves a wallet-signed assertion, not age, purchase or legal enforceability; mapping the configured hash to approved legal text remains an operator responsibility. Browser demo agreement records stay local.
- On Vercel, both Upstash settings are required; missing durable storage fails closed. Redis claim/reservation operations use atomic `MSETNX`. The file store serializes writers in one process only and is not safe as a multiprocess database. `NEXT_PUBLIC_SITE_URL` must explicitly identify the intended authorization domain for separate environments. EOA signatures are supported here; contract-wallet signature verification is not implemented.

## Known limits

- Snapshot gas grows with lots. Callers must chunk.
- A prize token that reverts `transferFrom` can stick the NFT in escrow. It cannot stick the USDC, which is pulled on its own calls.
- The ETH route depends on a liquid WETH/USDC pool at the immutable fee. Leave `WIRE_ETH_PATH` unset so the deploy script leaves the path unwired.
- The signer key can mint up to the per-raffle complimentary cap. Keep it off the client. Rotating it is an owner call.
- The owner can force-cancel a funded Open or Closed raffle without a delay. That is accepted v1 centralization (Chain Security H-3). Buyers then pull USDC; the seller pulls the NFT. A pause+timelock on this path is a follow-up, not a silent removal. Fixed expiry deliberately discards valid late randomness. Inclusion delays or censorship near the cutoff can therefore prevent an award, but transaction ordering after the cutoff cannot choose between accepting that result and refunds. Disabling retries prevents same-raffle rerolls; it does not remove all owner trust. Refund eligibility still requires a cancellation transaction, and each buyer must claim separately.
- This document is an engineering note, not a pentest.

## Commands

```bash
cd contracts && forge test
cd contracts && slither . --config-file slither.config.json --exclude-dependencies
cd web && npm test
```
