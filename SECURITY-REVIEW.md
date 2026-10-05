# LABx security review

Independent review of branch `cursor/labx-v1-sepolia-a20f` at `536d7ec2905ecb2ab204c4aebaa804accf5458a8` (PR 1). The author of the contracts is not the author of this note. No fixes are included here.

## Scope

Reviewed in full:

- `contracts/src/LabxRaffle.sol`
- `contracts/src/interfaces/External.sol`
- `contracts/src/vendor/VRFV2PlusClient.sol`
- `contracts/script/DeploySepolia.s.sol`, `contracts/script/DeployLocal.s.sol`
- `contracts/test/LabxRaffle.t.sol` and `contracts/test/mocks/Mocks.sol` (as evidence of intended behavior, not as a substitute for the code)

Skimmed for signature replay and secret exposure:

- `web/app/api/**`
- `web/lib/reserve.ts`, `commitment.ts`, `captcha.ts`, `points.ts`, `store.ts`, `email.ts`, `bench.tsx`

Out of scope: OpenZeppelin and forge-std internals, the visual bench, and a live Sepolia deployment. Chainlink VRF v2.5 coordinator behavior was checked against `VRFCoordinatorV2_5` (callback via `rawFulfillRandomWords`, request commitment deleted before the consumer call, failed callback not retried). Uniswap SwapRouter02 on Sepolia (`0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E`) has no `deadline` field on `exactOutputSingle`.

## Result

No unprivileged path was found that withdraws another buyer's USDC or redirects the escrowed NFT to the attacker. The launch blockers are a permanent freeze of a raffle, an ETH swap that will spend the entire `msg.value`, and an owner key that can replace Chainlink as the source of the winning word.

| Severity | Count | Topic |
| --- | --- | --- |
| Critical | 0 | |
| High | 3 | NFT exit freeze, ETH sandwich cap, VRF coordinator substitution |
| Medium | 5 | AMOE signer, commit-reveal, ETH-path admin, owner liveness, mail relay |
| Low | 8 | API replay and storage, monitoring, deployment window |
| Info | — | Controls that held |

`SECURITY.md` already names the ERC-721 receiver case and the signer key. Both are worse than that note describes. The receiver case is permanent, and the signer key is one entry per arbitrary address with no raffle cap.

---

## High

### H-1. Every fund-exit path reverts if the prize NFT transfer reverts

**Location.** `settle` (`contracts/src/LabxRaffle.sol` lines 543–560), `cancel` (563–575), `abortDrawing` (578–584), `_returnPrize` (720–724).

**Impact.** Principal, lab fee, and the prize token sit in one contract with no USDC-only exit. `settle`, `cancel`, and `abortDrawing` all move the NFT with `safeTransferFrom` in the same transaction as any USDC movement. A revert on that transfer rolls the USDC back too. After `rawFulfillRandomWords` the phase is `Drawn`, and `cancel` rejects `Drawn`. `abortDrawing` rejects anything except `Drawing`. Nothing in `Drawn` can refund buyers.

Two concrete ways this becomes permanent:

1. Honest prize, incompatible or hostile winner. Any buyer can be a contract. If that contract wins and `onERC721Received` reverts, `settle` reverts forever. A contract that always reverts cannot "later accept" the token. The same freeze happens for a smart wallet that does not implement `IERC721Receiver`. A buyer who is the only entrant wins with certainty. The freeze then costs that buyer the published pack price. The contract minimum is 1 atomic USDC (0.000001 USDC), so a seller who lists a cheap pack makes the grief cheap. A pack priced at 25 USDC costs 25 USDC.
2. Prize that reverts on the way out. `escrow` only checks `ownerOf` after the inbound transfer. A later outbound revert (paused NFT, blocklist, upgrade, or a token that transfers in and then refuses to transfer out) makes `settle`, `cancel`, and `abortDrawing` all revert. Buyer USDC cannot be pulled. `refund` requires `Phase.Cancelled`, and the phase never changes.

`SECURITY.md` says a winner that cannot receive ERC-721 "blocks settlement until they can." For a reverting receiver there is no later success, and the owner has no override.

**PoC sketch.**

```solidity
contract Refuse721 {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("no");
    }
    function buy(LabxRaffle labx, uint256 id) external {
        labx.buyPack(id, 0, 1, labx.termsHash());
    }
}
// Refuse721 is the only buyer. Sales end, anyone calls close, snapshot, seller calls
// requestRandomness, VRF fulfills. settle() reverts. cancel() reverts (phase is Drawn).
// abortDrawing() reverts (phase is not Drawing). USDC and the NFT stay in LabxRaffle.
```

Variant for (2): prize `transferFrom` returns success on the escrow into `LabxRaffle` and reverts on every later transfer. After at least one purchase, `cancel` by the owner reverts inside `_returnPrize`, so the admin refund path is closed as well.

**Fix.** Split money from the token.

- Record `Settled` or `Cancelled`, zero the escrow counters, and pay USDC without calling the NFT.
- Deliver the prize with a pull: `claimPrize(id)` for the winner, `reclaimPrize(id)` for the seller after cancel or abort. Use `transferFrom` on that pull so `onERC721Received` cannot roll back a payment that already happened. Keep `safeTransferFrom` on the way in.
- If a transfer still reverts because the token itself is hostile, the USDC refund must already have been possible in a separate transaction. Do not require a successful NFT transfer before `refund`.

### H-2. ETH purchases will spend the entire `msg.value`, not the slippage quote

**Location.** `buyPackWithEth` lines 416–450, especially 425–440. Quote helper `quoteEthForUsdc` lines 659–667. Router surface `contracts/src/interfaces/External.sol` lines 15–28. Deploy default `WIRE_ETH_PATH=true` in `contracts/script/DeploySepolia.s.sol`.

**Impact.** The function computes a ceiling, `required`, from the Chainlink ETH/USD quote plus `slippageBps` (max 10%), and uses it only as a minimum on `msg.value`. The swap then sets `amountInMaximum` to `msg.value` and `sqrtPriceLimitX96` to 0. Surplus is refunded only for WETH the router did not take.

`exactOutputSingle` on SwapRouter02 will spend up to `amountInMaximum`. A searcher can move the WETH/USDC pool so the exact USDC output costs almost all of the ETH the buyer attached, then move the pool back. The buyer still receives the pack. The extra ETH is gone. Sepolia WETH/USDC liquidity at fee tier 3000 is thin, so the searcher needs little capital. The mock router in `test_ethPurchaseSwapsAndRefundsSurplus` spends half of `msg.value` and refunds the rest; that test does not model an adversarial pool.

The same call has no deadline. SwapRouter02 enforces one only when the caller prepends `checkDeadline` inside `multicall`. The oracle is read at execution, so a transaction that waits does re-quote. It still executes when the pool has moved and the 3-hour Chainlink answer has not. `PRICE_STALE_AFTER` is 3 hours (line 31).

The USDC pot is not what gets taken. The loss is the buyer's ETH on that transaction, including any amount above `required`. Wallets and relayers that attach a buffer are the profitable targets.

**PoC sketch.**

1. Pack total is 30 USDC. `quoteEthForUsdc` returns 0.015 ETH. Buyer sends 1 ETH with `slippageBps = 50`. `required` is about 0.015075 ETH, so the floor check passes.
2. The contract wraps the full 1 ETH and approves the router for 1 ETH (`amountInMaximum = msg.value`).
3. Searcher back-runs a pool move that makes 30 USDC cost 0.99 ETH.
4. `exactOutputSingle` returns `spent ≈ 0.99 ether`. The buyer is refunded about 0.01 ETH and is credited the pack.
5. Searcher restores the pool and keeps the difference.

**Fix.**

- Set `amountInMaximum` to `required`, and wrap or approve only that amount.
- Refund `msg.value - pulled`, where `pulled` is the WETH balance delta. Ignore the router's returned `amountIn` for the refund size.
- Call the router through `multicall` with `checkDeadline(block.timestamp)` (or a buyer-supplied deadline that cannot exceed a few minutes).
- Keep `sqrtPriceLimitX96` as a second bound if a tick limit is derived from the same quote.
- Leave `WIRE_ETH_PATH` off until the Sepolia pool used by `poolFee` is deep enough that a sandwich of `required` is not worth it. The quote check and the 8-decimal stale-round checks can stay.

### H-3. The owner can replace the VRF coordinator and choose the winner

**Location.** `setCoordinator` lines 320–323. `requestRandomness` lines 493–513. `rawFulfillRandomWords` lines 516–528. `setVrfConfig` lines 307–318 changes the key hash and subscription but is not required for this path.

**Impact.** `rawFulfillRandomWords` trusts `msg.sender == vrfCoordinator`. It does not check a VRF proof. That is the normal split of work with Chainlink, and it holds only while `vrfCoordinator` is the real coordinator (`0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B` on Sepolia).

`setCoordinator` is immediate, emits no event, and is allowed while a raffle is in `Drawing`. The owner can, in one transaction:

1. `setCoordinator(owner)`
2. `rawFulfillRandomWords(requestId, [word])` with a word whose `word % snapshotTotal` lands on an address the owner wants

The winner must already be in the snapshot. The owner can put themselves there by buying a pack, or by signing an AMOE claim (H related, see M-1) before `close`. Settlement then sends the NFT to that address and the principal to the seller. If the owner is also the seller, buyers pay USDC for a prize the owner assigned to themselves.

An honest Chainlink fulfillment sitting in the mempool can be front-run the same way. After the substitute callback, the phase is `Drawn`, so the real callback hits `phase != Drawing` and returns. Returning is a success from the coordinator's point of view: `VRFCoordinatorV2_5` deletes the request commitment before the consumer call and does not retry. The honest word is discarded.

Chainlink's own `VRFConsumerBaseV2Plus` has an owner `setCoordinator` for migration. The gap here is that an in-flight request is not pinned to the coordinator that accepted it, and there is no delay.

`abortDrawing` does not fix this. It is owner-only, waits 1 day, and returns the NFT to the seller. The owner who wants a particular winner will fulfill, not abort.

**PoC sketch.**

```text
seller opens a raffle; victims buy packs; owner buys 1 pack
seller or owner: close, snapshot, requestRandomness
owner: setCoordinator(owner)
owner: rawFulfillRandomWords(vrfRequestId, [word targeting owner])
after reveal, or after drawnAt + 7 days: settle
NFT -> owner, principal -> seller, fee -> treasury
```

**Fix.**

- On `requestRandomness`, store `coordinatorAtRequest` and accept `rawFulfillRandomWords` only from that address.
- Put `setCoordinator` behind a delay that is longer than an open draw, and reject it while any raffle is `Drawing`.
- Emit the old and new coordinator.
- Keep the real coordinator immutable if migration is not required for v1.

---

## Medium

### M-1. The AMOE signer is a hot key with an unbounded draw weight

**Location.** `claimAmoe` lines 455–470. `setAmoeSigner` lines 296–299. `hashAmoe` lines 638–646. Web gate `web/app/api/amoe/claim/route.ts` and `web/app/api/amoe/challenge/route.ts`.

**Impact.** Each valid signature adds one lot of weight 1 for `msg.sender`. `amoeClaimed` stops the same account from claiming twice. Nothing stops the signer from signing a new account. There is no per-raffle cap, no nullifier for `captchaDigest`, and no check that a captcha ever happened. A leaked `AMOE_SIGNER_PRIVATE_KEY`, or a call to `setAmoeSigner`, lets the holder add N weight-1 entries to every `Open` raffle before snapshot. N is limited by gas, not by the contract. On a small draw that is enough to take the NFT. Principal still settles to the seller, so this steals the prize odds, not the USDC.

The web route does not bind those checks to the contract. `POST /api/amoe/claim` checks a captcha HMAC, 10 points, and three booleans, then writes `amoe:${pieceId}:${address}`. It never signs `AmoeClaim`. `AMOE_SIGNER_PRIVATE_KEY` is only tested for presence (`mode: "signer-ready"`). The on-chain signature can be produced with no captcha at all. `pieceId` is an off-chain string, not `raffleId`.

There is no meta-transaction relayer. `claimAmoe` credits `msg.sender`. A relayer that submitted a user's signature would receive the entry itself. That is the blast radius of a future relayer: one key signs for every open raffle, and a naive forwarder would also assign the weight to the forwarder.

The on-chain signature itself is well scoped: EIP-712 domain (`LABx`, `1`, chain id, this contract), `raffleId`, `account`, `deadline`, and the current `termsHash`, plus `amoeClaimed` for single use. OpenZeppelin `ECDSA.tryRecover` rejects malleable `s`. Replay across users, raffles, or chains does not work. The problem is who is allowed to mint signatures, and that the server checks never become one of those signatures.

**Fix.**

- Cap complimentary weight per raffle (absolute, or a fraction of `snapshotTotal` fixed before the signer can still add lots).
- Store a hash of each accepted signature or captcha digest.
- Sign inside the API only after the captcha is marked spent, and include `raffleId` plus the EIP-712 digest. Do that in a store that does not lose updates (see L-2) before the key is wired up.
- Keep the signer off the client. Rotate it through the Safe, with a delay, and emit the rotation.
- If a relayer is added, pass the claimant explicitly and require `msg.sender` to be an authorized forwarder. Do not treat the forwarder as the entrant.

### M-2. The reserve commitment does not constrain the draw, and the private hash is unsalted

**Location.** `createRaffle` lines 334–378 (`reserveNonce` and `reserveCommit` are stored in the clear). `reveal` lines 531–541. `settle` lines 546–548. `hashCommitment` lines 648–657. Web hashing `web/lib/reserve.ts` lines 35–38 and storage line 62. Client persistence `web/lib/bench.tsx` lines 51–63 and 148–155.

**Impact.** Winner selection is `word % snapshotTotal` inside `_select`. The revealed `publicHash` and `privateHash` are stored or logged and then ignored. A seller can `reveal` during `Open`, `Closed`, `Drawing`, or `Drawn`. The owner can `settle` with no reveal once `drawnAt + 7 days` has passed (`REVEAL_GRACE`). Buyers still receive the escrowed token. They do not receive a proof of the private text, and the text cannot change the winner.

The private preimage is `keccak256(utf8(plaintext))` with no salt. The outer commit hides it until reveal because the outer hash includes a 256-bit salt. On reveal the contract emits `privateHash` in the clear (`Revealed`). A short commercial number can be dictionary-attacked from that hash. The product copy says the private number stays unpublished. Publishing its raw hash is enough to recover a low-entropy number.

`POST /api/reserve` returns `privateHash`, `salt`, and `nonce` to the caller. `BenchProvider` writes the whole piece, including `salt` and `privateHash`, to `localStorage` under `labx-bench-v1`. The plaintext is stripped from the React state after submit and is not returned by `revealReserve`, which is the right shape. The unsalted hash is still on the seller's machine before any on-chain reveal. `POST /api/reserve/reveal` verifies `personal_sign` of ``LABx reveal ${commit}``. That string has no chain id, contract, or expiry, so a captured signature can be replayed against the API indefinitely. Replay returns the salt and the unsalted hash. It does not return `privateCommitment`, which the handler strips.

`reserveNonce` is public in `getRaffle`. Secrecy of the outer commit depends on `salt` and the two hashes, not on the nonce.

**Fix.**

- Decide what the commit is for. If it must change who wins, mix a revealed seed into the word only after the snapshot, with the VRF word. If it is a disclosure only, say that in the fairness page and do not treat a missing reveal as a settlement defect.
- Replace `privateHash = keccak256(text)` with `keccak256(abi.encode(salt, text))` so the value emitted on-chain is not a naked hash of a short string.
- Keep `salt` server-side until the seller signs a reveal that includes a deadline and the contract address. Do not put it in `localStorage`.
- Drop the owner bypass, or emit a distinct event when settlement proceeds without a reveal so indexers can flag it.

### M-3. The ETH path can be pointed at a new router, WETH, and feed in one transaction

**Location.** `setEthPath` lines 325–330. `receive` lines 267–269. `buyPackWithEth` lines 421–430.

**Impact.** There is no zero-address check, no decimals check at set time, no event, and no delay. The next `buyPackWithEth` wraps `msg.value` with whatever `weth` is, approves whatever `router` is for that full amount, and prices the trade with whatever `ethUsdFeed` returns. A feed that answers `1` makes `quoteEthForUsdc` demand `usdcAmount * 1e20` wei (about 3e9 ETH for a 30 USDC pack). A router that pulls the approved WETH, delivers `total` USDC so the balance check passes, and returns `spent` equal to the WETH it pulled prices the pack at whatever ETH amount it wants, up to `msg.value`. Reporting a `spent` smaller than the WETH pulled makes the refund `withdraw` revert, so that direction does not steal. This is the same owner trust as H-3, applied to the swap rather than the draw. Combined with H-2, the honest Uniswap router is already unsafe when `msg.value` exceeds the quote. A replaced router is unsafe even after H-2 is fixed, because the owner chooses the contract that receives the approval.

`poolFee == 0` in `setEthPath` leaves the old fee in place. A non-zero fee is stored even when no pool exists, which disables the ETH path by reverting swaps. That is a liveness switch, not a theft.

**Fix.** Reuse the constructor checks. Store a pending path and apply it after a delay. Emit the change. Measure WETH pulled instead of trusting `amountIn`. Consider making the router, WETH, and feed immutable for the Sepolia deployment and disabling the path with a boolean.

### M-4. After the first purchase, buyers cannot leave unless the owner acts

**Location.** `cancel` lines 563–575 (`SalesStarted` for the seller when `principalEscrow != 0`). `abortDrawing` lines 578–584 (`onlyOwner`, `VRF_ABORT_AFTER`). `setPaused` lines 286–289. Pause checks in `open`, `claimAmoe`, `requestRandomness`, and `_quote`. `refund` lines 587–595.

**Impact.** Pause stops new packs, AMOE claims, and new VRF requests. It does not stop `close`, `snapshot`, `reveal`, `settle`, `cancel`, or `refund`. That part is right: a pause should not trap a raffle that can still settle or refund.

The exit itself is owner-gated once money has arrived. The seller cannot `cancel` an `Open` raffle with a non-zero principal. Only the owner can. A failed VRF callback is not retried: `VRFCoordinatorV2_5` deletes `s_requestCommitments[requestId]` before calling the consumer and continues the transaction when the call returns false. The raffle stays in `Drawing` until the owner waits one day and `abortDrawing` succeeds. If the Safe cannot sign, every raffle that has taken USDC stays in the contract. `refund` is a correct pull, and it is reachable only after someone sets `Cancelled`.

Deploy adds a second window: `DeploySepolia` calls `transferOwnership` and stops. Until the Safe calls `acceptOwnership`, the deployer key is the owner and can perform H-3 and M-3.

**Fix.** Allow the seller, or any buyer after a published timeout, to move `Open` or `Closed` to `Cancelled` when the owner has paused or when VRF has been outstanding longer than `VRF_ABORT_AFTER`. Keep the NFT return on a pull so this cannot be blocked by H-1. Accept ownership in the same deployment flow that adds the VRF consumer, or transfer the deployer key's owner role before any raffle is created.

### M-5. The receipt route is an open mail relay

**Location.** `web/app/api/email/receipt/route.ts`. `web/lib/email.ts` lines 27–41.

**Impact.** Any client can `POST` `{to, piece, pack}` and, when `RESEND_API_KEY` and `RESEND_FROM` are set, send mail from the project domain. There is no session, captcha, or rate limit. HTML is escaped. The damage is quota theft and phishing from the trusted From address, not disclosure of the API key. The key stays on the server.

**Fix.** Require a wallet signature over the receipt payload, or send only from the purchase transaction path. Rate-limit per address and reject recipients that the caller has not proven they control.

---

## Low

### L-1. Captcha and check-in signatures are reusable, and the two secrets collapse into one

**Location.** `web/lib/captcha.ts`. `web/app/api/amoe/challenge/route.ts` line 5. `web/app/api/amoe/claim/route.ts` lines 22–40. `web/lib/points.ts` lines 15–17 and 34–52. `web/app/api/bot/check-in/route.ts`.

**Impact.** The challenge is `a + b` with `a` in 2..8 and `b` in 3..7, derived from the clock. The HMAC covers `id:answer:expiresAt` and is not spent. The same solution works until `expiresAt` (10 minutes) for every `pieceId`. `CAPTCHA_SECRET || BOT_CHECKIN_TOKEN` means the bot bearer token is also the captcha key whenever the captcha secret is unset. The bot token is held outside the browser, so this widens the set of people who can forge challenges.

The check-in message is `LABx bot check-in\n${address}\n${utcDay}`. It has no chain id or server domain. The same signature works on any deployment that shares the bot token, for that UTC day. A second award on the same day is blocked only by `lastDay` in storage.

These gates do not mint on-chain entries today (M-1). They matter as soon as the API signs `claimAmoe`.

**Fix.** Use a single-use challenge id, a separate captcha secret, and a check-in message that includes chain id and the API origin. Mark the captcha spent in the same atomic write as the signature.

### L-2. The file store drops concurrent writes, and Upstash errors look like a cache miss

**Location.** `web/lib/store.ts` lines 22–71.

**Impact.** `fileStore` reads the whole JSON file, mutates one key, and writes it back with no lock. Two overlapping requests each write their own snapshot, so one of them erases the other's `reserve:${commit}` or AMOE key. Losing the reserve record loses the only server copy of the salt and the plaintext. `upstashStore` ignores `response.ok`. A 401 or a proxy error becomes `get => null` and a `set` that reports success to the caller. Check-in can award points the store did not save. AMOE duplicate detection can pass twice.

`web/data/store.json` is gitignored. Next does not serve it from `public/`. The plaintext is still on disk on a single-machine deploy.

**Fix.** Use Upstash (or another atomic store) in every deployed environment, check the HTTP status, and fail closed. Do not fall through to the file store on Vercel. `/tmp` is per-instance, so the duplicate checks are not global there either.

### L-3. Agreement records are not signatures

**Location.** `web/app/api/agreements/route.ts`. `web/lib/agreements.ts`. The bench posts the connected address from `web/lib/bench.tsx` lines 108–112 with no signature.

**Impact.** Anyone can store `{address, terms, rules, age}` for any wallet. The record is not evidence that the wallet accepted the terms. On-chain purchases do check `acceptedTerms == termsHash` inside `_quote`. The API log does not.

**Fix.** Store a wallet signature over the terms hash, piece id, and timestamp, or drop the log and rely on the on-chain check.

### L-4. Reserve commits default to the wrong contract if the public address is unset

**Location.** `web/app/api/reserve/route.ts` lines 6 and 19–27. `hashCommitment` binds `chainId` and `labx`.

**Impact.** Missing `NEXT_PUBLIC_RAFFLE_ADDRESS` becomes `0x0000000000000000000000000000000000000001`. The stored commit cannot `reveal` on the deployed raffle. `Math.random()` plus `Date.now()` is used for the nonce. The salt comes from `generatePrivateKey`, so the outer commit is still hiding. The footgun is a commit that does not match the contract the seller later escrows into.

**Fix.** Reject the request when the raffle address or chain id is missing. Generate the nonce from the same CSPRNG as the salt.

### L-5. Admin setters that move money or randomness do not emit events

**Location.** `setTreasury`, `setAmoeSigner`, `setVrfConfig`, `setCoordinator`, `setEthPath`. `setPaused` and `setTermsHash` do emit.

**Impact.** An owner transaction that performs H-3 or M-3 is invisible to an indexer that watches events. The state change is still on-chain and visible in traces.

**Fix.** Emit old and new values for each setter.

**Status (commit 2b60a12 follow-up).** `setTreasury`, `setAmoeSigner`, and `setVrfConfig` now emit `TreasurySet`, `AmoeSignerSet`, and `VrfConfigSet`. Coordinator and ETH-path changes already emitted. `setNativePayment` emits `NativePaymentSet`. See Chain Security M-4 below.

### L-6. Refunds do not reduce the raffle escrow counters, and settlement pushes USDC

**Location.** `_credit` lines 693–704. `settle` lines 551–558. `refund` lines 587–595.

**Impact.** On the path that was reviewed, credits match tokens. `buyPack` pulls `principal + fee` with `safeTransferFrom`. `buyPackWithEth` requires the USDC balance to rise by that same total. `settle` pays `principalEscrow` to the seller and `feeEscrow` to the treasury, then zeros both. `refund` pays `principalOf + feeOf` and zeros those slots. Fee is 5 USDC per pack on top of price (`LAB_FEE`), escrowed until settle, and refunded on cancel. There is no split that pays the fee out of principal or the principal out of the fee.

The counters `principalEscrow` and `feeEscrow` are not reduced in `refund`. After a partial refund they still show the original total. A monitor that sums those counters and compares them to `usdc.balanceOf` will report a shortfall that the pull balances do not have. All raffles share one USDC balance, so a real shortfall on one raffle would be paid with another raffle's tokens. No such shortfall was found for standard 6-decimal USDC.

`settle` pushes USDC to `seller` and `treasury`. A Circle USDC blocklist on either address reverts settlement for every buyer in that raffle. `refund` is already per buyer, so one blocklisted buyer does not block the others.

Direct USDC transfers to the contract are not credited and there is no sweep. They increase the balance above the sum of credits. They do not become withdrawable by a buyer.

**Fix.** Decrement the raffle counters inside `refund`, or stop using them after `Cancelled`. Account per raffle with internal balances only, which is already the case, and add an invariant test: `usdc.balanceOf(labx) >= sum over raffles of unpaid principalOf + feeOf`. Pay the seller and treasury by pull if a blocklist should not freeze the NFT payout (see H-1).

### L-7. A prize sent straight to the contract cannot be returned

**Location.** `onERC721Received` lines 669–671. `_returnPrize` only runs for the `tokenId` stored on a raffle that was marked `escrowed` through `escrow`.

**Impact.** `safeTransferFrom` of the prize into `LabxRaffle`, skipping `escrow`, leaves the token with no owner record the contract will act on. `escrow` then fails because the seller is no longer `ownerOf`. There is no admin recovery. This is user error, and it is permanent.

**Fix.** Optional `recoverUnrecognized(nft, tokenId, to)` limited to tokens that are not the escrowed prize of a live raffle. Keep it off if the extra admin power is not worth the mistaken-transfer case.

### L-8. Snapshot timing and early close are seller-controlled, within wide bounds

**Location.** `close` lines 402–408. `snapshot` lines 472–491. Lot expiry in `_credit` and `claimAmoe` (`ENTRY_EXPIRY = 365 days`). `SALES_WINDOW_CAP = 180 days`.

**Impact.** The seller, or the owner, can `close` before `salesEnd`. Anyone can `snapshot` immediately after that, so a third party cannot usefully wait out the 365-day expiry. If every caller waits a year, expired lots are skipped and a seller can cancel an empty snapshot. Chunking (`maxSteps` 1..500) is sound: the cursor only moves forward. A snapshot spread across more than the remaining life of a lot can drop later lots and keep earlier ones. That window is a year, not a single block.

`requestRandomness` is refused until `snapshotted` is true, and `_select` binary-searches the cumulative array. The search matches the tests (`word % 7` boundaries at 0, 1, and 6). Callback gas is O(log n) storage reads. At the deployed 500,000 gas limit this stays inside the callback for any number of lots a buyer can realistically create. VRF v2.5 will not retry if the callback ever does run out of gas; recovery is `abortDrawing` (M-4).

**Fix.** None required for the binary search. If early close should be visible in advance, enforce `salesEnd` for the seller as well and let only the owner close early.

---

## Info

### Reentrancy

Value-moving entry points use `nonReentrant`: `escrow`, `open`, `close`, `buyPack`, `buyPackWithEth`, `claimAmoe`, `snapshot`, `requestRandomness`, `reveal`, `settle`, `cancel`, `abortDrawing`, `refund`. `rawFulfillRandomWords` does not, and it makes no external call. `createRaffle` and the admin setters do not either.

`escrow` sets `escrowed` before `safeTransferFrom` and checks `ownerOf` after. The test `test_reentrancyOnEscrowIsRejected` covers a prize that calls `buyPack` from `safeTransferFrom`. `cancel` and `abortDrawing` set `Cancelled` before `_returnPrize`. `refund` zeros the pull balances before `safeTransferFrom` of USDC. `settle` sets `Settled` and zeros escrow before the USDC transfers.

`buyPackWithEth` calls the router before `_credit`. The lock blocks `refund`, `settle`, and `buyPack` during that call. A later unguarded USDC transfer would see a balance that has already increased and credits that have not. No such function exists today. The ETH refund to `msg.sender` happens after `_credit`. `receive` accepts value only from `weth`.

### Access control that held

- Owner transfer is two-step. There is no `renounce`.
- `escrow` and `open` are seller-only. `requestRandomness` and `reveal` are seller or owner.
- `rawFulfillRandomWords` reverts for every caller except `vrfCoordinator`.
- `buyPack` credits `msg.sender` only. There is no recipient argument.
- Constructor rejects chain id 1, a USDC token whose `decimals()` is not 6, an empty terms hash, and a callback gas limit outside 200,000..2,500,000. `DeploySepolia` additionally requires chain id 11155111. The wallet helper refuses chain id `0x1`.
- AMOE uses `tryRecover` and checks `RecoverError.NoError`. The 65-byte path is the one `claimAmoe` uses.

### Fee and principal

Happy-path accounting is consistent: price and the 5 USDC lab fee are escrowed separately, refunded together, and on settlement paid to the seller and the treasury respectively. The winner is paid in the NFT, not in USDC. `uint32` pack math stays inside the configured caps (`MAX_QTY` 20, `MAX_BONUS_ENTRIES` 10,000, `MAX_PACK_PRICE` 1,000,000e6). The ETH quote `usdcAmount * 1e20 / answer` matches 6-decimal USDC and an 8-decimal ETH/USD feed (`30e6` USDC at `$2000` is 0.015 ETH, as in the test).

### VRF callback

`rawFulfillRandomWords(uint256,uint256[])` matches the selector `VRFCoordinatorV2_5` calls. `extraArgs` use `ExtraArgsV1`. Source after this follow-up reads `nativePayment` from storage (default false). The live Sepolia raffle `0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C` was compiled with `nativePayment: false` hardcoded; fund that VRF sub with LINK. The deployed key hash and coordinator match Chainlink's published Sepolia VRF v2.5 values. Storing the winner in the callback is a few SLOADs plus a binary search. That fits the 500,000 gas limit. The callback does not transfer tokens, which is what Chainlink asks consumers to avoid.

`requestToRaffle` is written after `requestRandomWords` returns. A synchronous coordinator callback is buffered (`_awaitingRequest`) and applied once the request id is pinned. `abortDrawing` and `retryRandomness` delete the mapping so a late word cannot land on a cancelled or replaced request.

`word % total` has the usual modulo bias. It is not material at 256-bit words and raffle-sized totals.

### Secrets that stayed on the server

`AMOE_SIGNER_PRIVATE_KEY`, `CAPTCHA_SECRET`, `BOT_CHECKIN_TOKEN`, `RESEND_API_KEY`, and the Upstash token are read from `process.env` in route handlers. Client components do not import `captcha.ts`, `store.ts`, or `email.ts`. The challenge response includes `id`, `prompt`, `expiresAt`, and `mac`, and does not include the answer. The presence check `mode: "signer-ready"` tells a caller that the signer key is loaded. That string can be removed.

### What this review did not do

No exploit was broadcast, no mainnet or Sepolia state was used, and the Forge suite was not re-run as part of this pass. The findings above are from reading the source and the coordinator and router behavior those calls depend on.

---

## Chain Security threat model (commit `2b60a12`, live Sepolia `0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C`)

IDs below are from that read-only model. They are **not** the H/M/L numbers in the PR-1 review above.

| ID | Topic | v1 response |
| --- | --- | --- |
| C-1 | VRF billed in LINK while the live sub has 0 LINK / 0.05 native ETH | Code: owner-settable `nativePayment`, default `false`, gated by `activeDrawings == 0`. Ops: fund LINK on the live contract; do not wait for a redeploy. A future deploy may set native ETH. |
| M-1 | Failed VRF callback leaves `Drawing` with no word; `abortDrawing` left `requestToRaffle` populated | Owner `retryRandomness` re-requests without cancelling. `abortDrawing` and retry delete `requestToRaffle` / `requestCoordinator`. |
| M-2 | `setVrfConfig` while a draw is in flight | Same `DrawInFlight` gate as coordinator changes. |
| M-3 | Runtime over EIP-170 | Inherited from main after PR #7: `via_ir = true` in `foundry.toml`, CI runs `forge build --sizes` before `forge test`. |
| M-4 | Treasury / AMOE signer / VRF config setters emit nothing | `TreasurySet`, `AmoeSignerSet`, `VrfConfigSet`, `NativePaymentSet`. |
| H-3 | Owner can force-cancel a funded raffle | Accepted v1 centralization. Documented in NatSpec on `cancel`, `SECURITY.md`, and this note. Do not remove `cancel`. Pause+timelock is an optional follow-up. |

The live bytecode at `0xa59B62…` still has `nativePayment: false` hardcoded. Hardening above is for the next compile. Until then, fund the existing VRF subscription with Sepolia LINK.

## Follow-up: VRF retry fairness hardening (2026-10-05)

At source `2bb586e798cfe5bf797965657954a1f2161f461f`, the retry added in `9230205` allows the owner to replace a request immediately. A local two-buyer reproduction confirms that replacing the request before an unfavorable fulfillment discards that result and allows a different winner over the same snapshot. Exploitation requires owner authority and transaction ordering before fulfillment; no live abuse was tested or observed. This is a new privileged fairness issue, not clearance from the earlier review.

The current source disables `retryRandomness` with `RandomnessRetryDisabled`, retaining its selector. Chainlink's [VRF security guidance](https://docs.chain.link/vrf/v2-5/security) warns against discarding unfavorable randomness through retries. A timeout alone would not prevent that behavior. The old Chain Security M-1 retry response above is superseded; failed callbacks now require the existing timed abort and refunds. The owner can still censor a delayed draw through that timed abort, so this change does not remove all owner trust or guarantee liveness. Existing Sepolia bytecode is unchanged by this source patch.