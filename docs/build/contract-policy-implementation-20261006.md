# Approved contract policy implementation

Base `48135d8`, branch `design/artwork-first-20261006`. Local R3 source work only, 2026-10-06. The user approved both changes with seven days for randomness. The designated critical implementation owner is configured as GPT-6 Astra High. The role tool declaration and inspected `/home/tx/.codex/agents/critical_builder.toml` both specify `gpt-6-astra` with `high` effort. Provider-level attestation and usage telemetry are unavailable. Applied unslop and karpathy-guidelines. No deployment, chain transaction, signing key, or publication is in scope.

## Accepted policy

- Anyone may settle a recorded winner at or after `drawnAt + 7 days` without a reveal. A valid reveal still allows immediate settlement. Settlement does not redirect any asset.
- Anyone may cancel an Open or Closed raffle at or after its published `salesEnd + 7 days`, even while paused and regardless of snapshot progress. New randomness requests must fail at or after that cutoff.
- A request accepted before the sales cutoff gets its own seven-day fulfillment window. Only words received strictly before `vrfRequestedAt + 7 days` may record a winner. Words at or after the cutoff are ignored, including when cancellation has not yet run.
- Anyone may abort a Drawing at or after that same request cutoff, even while paused. Each buyer then pulls their own principal plus fee; the seller separately reclaims the NFT.
- Existing immediate owner cancellation of funded Open/Closed raffles remains. Retry remains disabled. No new refund recipients, configurable deadlines, or contract upgrade mechanism are added.

## Invariants and assumptions

At most one winner is accepted. Cancellation and settlement are mutually exclusive. Deadlines cannot reset; pre-request recovery and requesting do not overlap. An accepted timely result cannot be cancelled, while an expired result cannot revive an award. Pausing, absent operators, absent callbacks, incomplete snapshots and failing NFT receivers cannot prevent deadline recovery eligibility. Refunds and claims retain existing exact-once accounting and recipients. Drawing counts decrement once on fulfillment or abort; abort clears both request mappings once. Existing successful-draw request history and coordinator pinning remain unchanged.

The pinned coordinator and token dependencies retain their existing trust assumptions. Inclusion before a deadline is not guaranteed. Valid late results are intentionally discarded. Owner cancellation before requesting remains discretionary. Refunds require buyers to submit successful claim transactions. This source cannot change deployed bytecode.

Rollback is a local patch reversal before release. Recovery on the changed contract uses existing cancellation, buyer refund and seller prize-reclaim functions; no administrative recovery deployment is needed. Any real deployment needs separate authorization and a release decision.

## Objective acceptance checks

Regression and fuzz tests cover exact deadline boundaries, caller authority, pause independence, early close versus published deadline, incomplete snapshots, timely and expired callback ordering, replay, winner/payee preservation, cleanup and refund conservation. Preserve existing synchronous callback, pinning, configuration, AMOE and accounting tests. Run the full Forge suite with 1,024 fuzz runs, scoped Solidity formatting and contract size checks. Independent verification and separate review remain required before acceptance.

## Evidence

Implemented a bounded source change in `contracts/src/LabxRaffle.sol` and regressions in `contracts/test/LabxRaffle.t.sol`. The new public constant getter `DRAW_START_GRACE` is additive; existing selectors and view structs are unchanged. `VRF_ABORT_AFTER` retains its getter and now returns seven days. Expired callbacks return without changing Drawing state; a separate permissionless abort clears mappings and drawing counts.

Observed checks, all exit 0:

- `forge test --fuzz-runs 1024`: 56 tests passed, zero failures or skips. Seven fuzz tests each ran 1,024 cases. Log `artifacts/contract-policy-20261006/implementation-tests.log`.
- `forge fmt --check src/LabxRaffle.sol test/LabxRaffle.t.sol`: passed. Log `artifacts/contract-policy-20261006/implementation-format.log`.
- `forge build --sizes`: passed. Log `artifacts/contract-policy-20261006/implementation-sizes.log`. Compiler/linter warnings remain in the log; this was not a warning-free build.
- `git diff --check`: passed.

The tests replace the prior three policy limitations with the approved expected behavior and preserve their adversarial scenarios. New fuzz checks cover Open/Closed and snapshot progress, pause on/off, owner/seller request boundaries, unrelated settlement callers, callback-first versus abort-first at expiry, timely winner protection, payout recipients and replay. Existing synchronous callback, configuration lock, AMOE, failed NFT claims and two-raffle accounting coverage passes.

Test run inputs, before independent verification adds its separate test file:

```text
71bd94c18af2802f81d86e0ebce07a29bc1646fe0a1328b274efd92d2e87e8b1  contracts/src/LabxRaffle.sol
e0ac9244c8c7eeca09df934c9afd9f88efff57d4883709d03e5c6a4877a10246  contracts/test/LabxRaffle.t.sol
```

One initial test-edit command used a repository-relative path from the contracts subdirectory and failed with FileNotFoundError before changing tests. It was corrected from the repository root. No test run failed.

Independent verification and separate final review remain pending. The coordinator owns ABI synchronization, release documentation and the combined candidate revision. No commit, publication or live operation was performed by this implementation owner.
