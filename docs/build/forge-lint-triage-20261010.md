# Forge lint triage, 2026-10-10

## Scope and command

- Candidate: `c9ea8715d8bbce2bb84a22f358d530ae1dfc7bd6` on `fix/raffle-recovery-ux-20261010`, base `c5b143b07d299f49d47e7becdad2c954c80815a5`. The candidate does not touch `contracts/`.
- Command: `forge lint --root contracts`, run from `/home/tx/projects/labx`. Exit 0.
- Forge `1.8.5` (commit `51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f`, dist build 2026-10-05). solc 0.8.24, `via_ir = true`, optimizer 200 runs, Cancun.
- Full output: `.local/evidence/recovery-ux-c9ea871/forge-lint.txt`. By default, Forge 1.8.5 reports only high, med and low severity lints. The info, gas and code-size notes were captured separately with `forge lint --root contracts --severity info gas code-size` in `.local/evidence/recovery-ux-c9ea871/forge-lint-info-gas-codesize.txt`.
- No repository file was modified. `forge lint` did not touch `contracts/cache` or `contracts/out`.

## The linted source is the deployed v3 source

- `contracts/src/LabxRaffle.sol` has git blob `53657cc` at both the base and the candidate.
- The file's keccak256, `0xe4cf29ae…b7da`, matches the source hash recorded in the local Foundry artifact's metadata.
- The local artifact runtime is 23,894 bytes. After masking the 28 immutable slots, it is byte-identical to the code deployed at `0x8b0332D0ca48908e174F42eA1b3123e63f3F4327`. That includes the CBOR metadata hash. The deployed code keccak is `0x566af43a…eb31`, which equals the runtime hash in the approved manifest.
- A read-only RPC check at Sepolia block 11882049 returned `ethPathEnabled=false`, `router`, `weth` and `ethUsdFeed` all `address(0)`, and `contractVersion=3`. The ETH-path addresses are constructor immutables, and `setEthPathEnabled(true)` reverts while they are zero. On this deployed instance, `buyPackWithEth` and `quoteEthForUsdc` can never succeed.

## Totals

69 warnings in the default run.

| Lint id | Forge severity | Count | Files |
| --- | --- | --- | --- |
| environment-read-across-mutation | med | 21 | tests only |
| block-timestamp | low | 18 | LabxRaffle.sol |
| unsafe-typecast | med | 9 | LabxRaffle.sol (8), vendor/VRFV2PlusClient.sol (1) |
| reentrancy-no-eth | med | 7 | LabxRaffle.sol |
| reentrancy-events | low | 6 | LabxRaffle.sol |
| require-revert-in-loop | low | 4 | LabxRaffle.sol |
| non-reentrant-not-first | med | 2 | LabxRaffle.sol |
| unused-return | med | 1 | LabxRaffle.sol |
| reentrancy-eth | high | 1 | LabxRaffle.sol |

By file:

| File | Warnings |
| --- | --- |
| src/LabxRaffle.sol | 47 |
| src/vendor/VRFV2PlusClient.sol | 1 |
| test/LabxRaffle.t.sol | 6 |
| test/RecoveryPolicy.t.sol | 6 |
| test/IndependentPolicyVerification.t.sol | 4 |
| test/PermissionlessDraw.t.sol | 3 |
| test/Admission.t.sol | 2 |

The separate info, gas and code-size run produced 35 notes:

| Severity | Notes |
| --- | --- |
| info | 29 |
| gas | 5 |
| code-size | 1 |

## Reentrancy-related warnings

Every public or external state-changing function that makes an external call is `nonReentrant` (OpenZeppelin 5.2.0 `ReentrancyGuard`). The `_status` named in each reentrancy-no-eth message is the guard's own slot, which the guard resets after the call. The functions that remain unguarded and reachable during a call window are:

- `createRaffle`, which creates a new id and makes no external call.
- `rawFulfillRandomWords`. For a caller that is not the pinned coordinator, it does nothing.
- Owner-only and pending-owner admin functions.

| Lint | Location | Function and external call | Verdict | Reason |
| --- | --- | --- | --- | --- |
| reentrancy-no-eth | LabxRaffle.sol:523 | `escrow`, seller's NFT `safeTransferFrom` | False positive | Guarded. `r.escrowed = true` is set before the call. Only a view `ownerOf` check and the event follow. `updateDraft` is guarded, so the NFT identity cannot change during the call. |
| reentrancy-events | LabxRaffle.sol:525 | `escrow`, `Escrowed` after transfer | Acceptable by design | The event must follow the post-transfer custody check. During the call, no reachable emitter can emit an event for this raffle id. The web reader filters logs by contract address and decodes them strictly. |
| non-reentrant-not-first | LabxRaffle.sol:566 | `approveRaffle` | False positive | `onlyOwner` only reads `owner` and reverts. No external call or state write runs before the guard. `docs/build/admission-fee-preflight-20261007.md:54` required these mutators to be guarded. |
| non-reentrant-not-first | LabxRaffle.sol:577 | `revokeRaffleApproval` | False positive | Same as line 566. |
| reentrancy-no-eth | LabxRaffle.sol:991 | `_swapEthForUsdc` via `buyPackWithEth`, WETH `approve` | False positive, unreachable on deployed instance | `buyPackWithEth` is guarded. WETH and the router are constructor immutables. `_credit` runs after the swap, but every function that reads or writes pack supply, escrow balances or lots is guarded, so the values `_quote` checked cannot change mid-call. The deployed instance has zero router, WETH and feed addresses. |
| reentrancy-no-eth | LabxRaffle.sol:1006 | `_swapEthForUsdc`, router `multicall` | False positive, unreachable on deployed instance | Same as line 991. |
| unused-return | LabxRaffle.sol:1006 | `_swapEthForUsdc`, `multicall` results ignored | Acceptable by design, unreachable on deployed instance | The swap outcome is enforced by balance deltas at lines 1007 to 1012: USDC received must be at least `usdcOut`, and WETH spent must be at most `cap`. |
| reentrancy-no-eth | LabxRaffle.sol:1016 | `_refundEth`, WETH `withdraw` | False positive, unreachable on deployed instance | All accounting is already written by `_credit`. Only the guard reset follows. `receive()` accepts ETH only from WETH. |
| reentrancy-eth | LabxRaffle.sol:1017 | `_refundEth`, `msg.sender.call{value}` | False positive, unreachable on deployed instance | The change refund goes to the payer after all effects. A reentrant call to any guarded function reverts. That makes `ok` false, `RefundFailed` follows, and only the payer's own purchase reverts. Forwarding all gas affects only the payer. |
| reentrancy-events | LabxRaffle.sol:971 | `_credit` via `buyPack`, `PackPurchased` after USDC `safeTransferFrom` | Acceptable by design | The transfer comes first deliberately so the received amount can be proven by the balance check at lines 652 to 657. USDC is a constructor immutable. The guard blocks re-entry. |
| reentrancy-no-eth | LabxRaffle.sol:1026 | `_requestWords` via `requestRandomness`, pinned coordinator `requestRandomWords` | Acceptable by design | The request id exists only after the call, so the phase, request mappings and timestamps are written afterwards. Lifecycle functions are guarded. The coordinator's only unguarded path is `rawFulfillRandomWords`. For an unmapped id, it stores one synchronous word, gated on `_awaitingCoordinator`, and that word is applied only if the returned id matches (line 1051). For a mapped id, it fulfills another raffle, which the coordinator can already do at any time. Coordinator trust is documented in SECURITY.md. |
| reentrancy-events | LabxRaffle.sol:1050 | `_pinRequest`, `RandomnessRequested` | Acceptable by design | The event carries the coordinator-assigned request id. |
| reentrancy-events | LabxRaffle.sol:1068 | `_applyWord`, `WinnerDrawn` | Acceptable by design | After the VRF call, this is reachable only through the synchronous path or a coordinator fulfillment. Both are gated by the phase, request-id and deadline checks at lines 1061 and 1062. |
| reentrancy-no-eth | LabxRaffle.sol:774 | `claimPrize`, NFT `transferFrom` to the winner | False positive | Guarded. Settled phase and winner identity are checked, and `r.escrowed = false` is set before the call. Only the event follows. |
| reentrancy-events | LabxRaffle.sol:775 | `claimPrize`, `PrizeClaimed` | Acceptable by design | Same reasoning as line 525. |
| reentrancy-no-eth | LabxRaffle.sol:838 | `reclaimPrize`, NFT `transferFrom` to the seller | False positive | Guarded. Cancelled phase and seller identity are checked, and `r.escrowed = false` is set before the call. Only the event follows. |
| reentrancy-events | LabxRaffle.sol:839 | `reclaimPrize`, `PrizeReclaimed` | Acceptable by design | Same reasoning as line 525. |

## Unsafe typecasts

| Location | Cast | Verdict | Reason |
| --- | --- | --- | --- |
| LabxRaffle.sol:449, 1046, 1066 | `uint64(block.timestamp)` | False positive | A uint64 holds seconds far beyond any reachable timestamp. |
| LabxRaffle.sol:970 | `uint64(block.timestamp + ENTRY_EXPIRY)` | False positive | Same as above, with an extra 365 days. |
| LabxRaffle.sol:489, 498 | `uint8(n)` | False positive | Line 487 enforces `n <= MAX_PACKS` (8) before either cast. |
| LabxRaffle.sol:932 (two casts) | `uint256(answer)` | False positive, unreachable on deployed instance | Line 927 enforces `answer > 0`. |
| vendor/VRFV2PlusClient.sol:6 | `bytes4(keccak256("VRF ExtraArgsV1"))` | Acceptable by design | Intentional truncation to Chainlink's 4-byte extraArgs tag. Changing it would break coordinator decoding. |

## Block timestamp

All 18 are acceptable by design. Post-merge Ethereum and Sepolia fix each block timestamp to its 12-second slot. A proposer can only choose whether to include a transaction at a boundary, and SECURITY.md already lists inclusion and censorship as risks. The reachable windows range from 1 day to 180 days.

| Location | Function | Rule |
| --- | --- | --- |
| 418 | `applyCoordinator` | 1-day coordinator delay |
| 483 (two) | `_setDraft` | Sales end is in the future and at most 180 days away |
| 569, 628 | `approveRaffle`, `_open` | No approval or opening at or after `salesEnd` |
| 645 | `close` | Not before `salesEnd` |
| 670 (two) | `buyPackWithEth` | 10-minute deadline window, unreachable on deployed instance |
| 699 | `snapshot` | 365-day lot expiry. A lot bought at or after `salesEnd - 180 days` expires after the draw-start deadline of `salesEnd + 7 days`, so expiry never changes a snapshot that can still be drawn |
| 715 | `requestRandomness` | Draw must start before `salesEnd + 7 days` |
| 759 | `settle` | 7-day reveal grace |
| 808 | `cancel` | Public timed recovery at `salesEnd + 7 days` |
| 823 | `abortDrawing` | 7-day VRF deadline |
| 927 (two), 930 | `quoteEthForUsdc` | 3-hour oracle freshness, unreachable on deployed instance |
| 949 | `_quote` | Sales deadline |
| 1062 | `_applyWord` | Late randomness is ignored |

## Grouped style, gas and test lints

- require-revert-in-loop (4, LabxRaffle.sol:503 to 506). This is per-pack validation in `_setDraft`. The loop runs at most 8 times, and reverting the whole draft is intended.
- environment-read-across-mutation (21, tests only, not in the deployed metadata). Under via-IR, a `block.timestamp` read can be reused across `vm.warp`. I spot-checked LabxRaffle.t.sol:298, Admission.t.sol:113 and PermissionlessDraw.t.sol:78. Each is a positive-path assertion that would fail, not pass vacuously, on a stale read. I did not review the other sites individually. Switching tests to `vm.getBlockTimestamp()` would not change the deployed hash.
- Info, gas and code-size notes (35). None changes behavior:
  - low-level-calls at line 1017, already covered above.
  - literal-instead-of-constant (8).
  - screaming-snake-case-immutable (5). `usdc`, `router`, `weth`, `ethUsdFeed` and `poolFee` are public ABI getters, so renaming them would change the ABI.
  - cyclomatic-complexity (2): the constructor and `_setDraft`.
  - costly-loop (2): `_setDraft`, bounded at 8 iterations.
  - asm-keccak256 (3).
  - unwrapped-modifier-logic (1): `onlyOwner`.
  - interfaces/External.sol naming and multi-contract-file (7).
  - unsafe-cheatcode (6): test/DeploySepolia.t.sol.

## Prior dispositions

- `SECURITY.md:51` says prior Slither results were triaged under documented trust assumptions and are not a clean-scan claim. `docs/handoff/CLAUDE_HANDOFF_2026-10-10.md:636` says those results covered a historical revision. This checkout has no Slither report or `artifacts/` directory. `contracts/slither.config.json` filters `lib|test` and excludes low and informational findings.
- `docs/build/full-workflow-20261006.md:65` says Forge lint warnings were inspected and makes no clean static-scan claim. Line 85 of the same file records a current Slither scan as NOT_RUN because it was unavailable.
- Earlier records say the existing lint warnings remain but give no ids or per-warning dispositions:
  - `docs/build/refresh-20261006.md:29`
  - `docs/build/contract-policy-implementation-20261006.md:33` and `:59`
  - `docs/build/main-release-20261006.md:11`
  - `docs/build/sepolia-native-vrf-20261007.md:55`, which used Forge 1.5.1
  
  Without recorded counts, this run cannot be diffed against them.
- Requirements to preserve checks-effects-interactions and nonreentrancy: `docs/build/seller-portal-fees-20261007.md:21`, `docs/build/contract-policy-20261006.md:99` and `docs/build/admission-fee-preflight-20261007.md:54`. The code matches them. The only interaction-before-effect orderings are the measured USDC receipt, the unreachable ETH swap and the VRF request id, and all three are guarded.

## Checks not run

- `forge test`: NOT_RUN in this triage, to avoid writing `contracts/cache` and `contracts/out`. The same contract source passed `forge test --root contracts` locally earlier on 2026-10-10 (11 suites, 117 passed, 0 failed) during the takeover baseline, and main CI passed at the base.
- Slither: NOT_RUN.
- `forge build`: NOT_RUN.

## Conclusion

No warning shows a real issue in the deployed v3 contract. All 17 reentrancy-related warnings are false positives or acceptable by design, either because of the `nonReentrant` guard and effects-before-transfer ordering, or because of documented trust in immutable USDC and the pinned coordinator. Five of them are in the ETH path, which the deployed instance cannot execute. The typecast and timestamp warnings are bounded by explicit checks or are day-scale policy windows.

No source change is recommended. Any edit to `contracts/src`, even a comment, changes the metadata hash and therefore the pinned runtime hash. Two changes would leave the deployed code untouched:

- A `[lint]` exclusion in `foundry.toml`, which does not affect compiler input.
- Test-only `vm.getBlockTimestamp()` changes.
