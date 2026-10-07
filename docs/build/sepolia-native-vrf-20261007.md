# Sepolia native VRF billing

## Scope and authority

User approved using Sepolia ETH for randomness on the new LABx deployment on 2026-10-07. Prepare and verify that configuration locally. Wallet signing, deployment, funding, ownership acceptance, consumer registration and published deployment manifests remain separate operations requiring a concrete release decision and the user's wallet flow. No website release or database migration is part of this change.

Risk: R3, because the deployment script selects the billing asset for randomness. The raffle runtime already supports pinned native billing; preserve that runtime and its ABI. Base: `f683c4753c360a411727ff91a69f8eb67c0fc858`, confirmed equal to fetched `origin/main`; no open PRs at start. Worktree: `labx-native-vrf`, branch `deploy/sepolia-native-vrf-20261007`. Existing checkout was clean and remains untouched.

## Implementation contract

The designated critical implementation owner owns `contracts/script/DeploySepolia.s.sol`, `contracts/test/DeploySepolia.t.sol`, `.env.example`, `LAUNCH.md`, this checkpoint and relevant ignored evidence. The owner may add a focused test file but must not modify raffle runtime, website, dependencies or lockfiles without escalating a concrete need. One writer per worktree. No child agents from workers.

1. The Sepolia script must explicitly enable native VRF billing on the freshly deployed raffle before proposing Safe ownership. Default Solidity zero initialization must not leave the production script using LINK.
2. Keep Sepolia-only and deployed-Safe guards. Code presence is not Safe verification. Preserve constructor addresses, subscription, terms, confirmations, callback gas and treasury.
3. `WIRE_ETH_PATH=false` remains the default. ETH-funded VRF does not enable ETH membership purchases or alter the USDC payment path.
4. Opening a raffle must still pin its billing mode. A later owner default change must not alter an existing raffle's request or deadline. Existing LINK-mode behavior remains supported by the runtime.
5. Correct operator guidance must distinguish the subscription owner adding the consumer from the Safe accepting raffle ownership. In the current read-only inventory the subscription owner is the deployer, not the Safe.
6. No real private keys, secret reads, broadcasts, funding, contracts or source publication. Use only deterministic disposable test identities for local simulation.

## Threat assumptions and recovery

Deployment inputs and the intended Safe require operator review. The Safe guard checks code presence only. Native billing must be set by the initial deployer before ownership is proposed; neither a pending Safe nor a subscription balance proves consumer registration or fulfillment. Tests use disposable identities and mocked dependencies at the pinned addresses, with no RPC or wallet access. The bounded change leaves runtime and ABI untouched. Before broadcast, recovery is to discard this candidate. If an authorized future deployment stops between transactions, keep it inactive and inspect billing and ownership before resuming; do not open raffles until native billing, Safe ownership and subscription registration have been read back. Open raffle policy and deadlines cannot be repaired by changing defaults.

## Acceptance and evidence

- Reproduce the old script's LINK default with a regression exercising the deployment script, then prove the new deployment leaves native billing on, optional ETH purchases off, correct owner/pending owner and constructor configuration.
- Retain and run wrong-chain and undeployed-Safe failure cases and billing pinning/actual request-flag checks.
- Run the full contract suite including all existing fuzz tests with 1,024 runs, scoped formatting and runtime size checks. Record versions, exact candidate and exit statuses.
- Independent verification must inspect the deployment behavior and request configuration. A fresh Astra High review must inspect the actual candidate, source dependencies and evidence. A passing local review is not a live draw.
- Perform read-only Sepolia checks of Safe code, subscription owner/consumers and native balance. Estimate the coordinator's maximum reservation using the chosen callback gas, key hash and confirmations where supported. Do not equate 0.05 ETH with sufficient balance without checking.
- Local mock verification is required. Live deployment and live Chainlink fulfillment remain BLOCKED until operational prerequisites and the user's wallet flow are available.

Evidence directory: ignored `artifacts/sepolia-native-vrf-20261007/`. Independent verifier uses a separate worktree and evidence directory. Usage telemetry unavailable; record unknown rather than estimating cost savings.

## Current checkpoint

Implementation, builder checks and independent behavioral verification PASS for source candidate `49db614a00c18c160afe74ccfdd32c7b5a1ca51f`. The final Astra High source verdict is recorded separately in `artifacts/sepolia-native-vrf-20261007/independent-review.md`, bound to the final checkpoint revision. The builder does not approve its own work. The tested source fingerprints are in `artifacts/sepolia-native-vrf-20261007/candidate.log`. Only the five contracted paths changed. Runtime source, ABI definitions, compiler settings, dependencies, locks and website are unchanged.

The script enables native billing immediately after construction and before proposing Safe ownership. Its logs and operator documentation distinguish the subscription owner's consumer registration from the Safe's ownership acceptance. `WIRE_ETH_PATH=false` remains independent and keeps membership purchases in USDC.

The real-script regression initially failed because `nativePayment()` returned false. Final tests cover native billing before the ownership-proposal event, all constructor configuration, disabled ETH purchases, both script guards, Safe acceptance and revoked deployer authority. A script-deployed raffle requests native billing while the global default is LINK; a later LINK raffle requests LINK while the default is native. Exact request calldata is checked. The native raffle retains its seven-day deadline, rejects early recovery and late fulfillment, and refunds after cancellation.

An optional ETH-on test initially caused a process-wide Foundry environment race with parallel ETH-off fixtures. It was removed; all retained fixtures set the same deterministic environment values. The failed attempt is retained in `deployment-tests-first-attempt.log`. This was a fixture issue, not a runtime change. All final checks below ran after the repair and final request-pinning assertions.

| Check | Command | Observed result | Evidence |
| --- | --- | --- | --- |
| Regression before production edit | `forge test --root contracts --match-test test_runEnablesNativeBillingWithEthPurchasesOff -vvvv` | Expected FAIL, exit 1; `nativePayment()` returned false | `regression-before.log` |
| Final real-script checks | `forge test --root contracts --match-contract DeploySepoliaTest -vvvv` | PASS, exit 0; 7 tests | `deployment-tests.log` |
| Full contract suite | `forge test --root contracts --fuzz-runs 1024 -vv` | PASS, exit 0; 84 tests across 5 suites, all 10 fuzz tests ran 1,024 cases each | `full-suite.log` |
| Scoped formatting | `forge fmt --root contracts --check contracts/script/DeploySepolia.s.sol contracts/test/DeploySepolia.t.sol` | PASS, exit 0 | `format.log` |
| Runtime size | `forge build --root contracts --sizes --skip test --skip script` | PASS, exit 0; LabxRaffle runtime 21,027 bytes, 3,549 bytes below EIP-170 | `size.log` |
| Whitespace | `git diff --check` | PASS, exit 0 | `diff-check.log` |
| Unchanged runtime and related inputs | `git diff f683c4753c360a411727ff91a69f8eb67c0fc858 --exit-code -- contracts/src contracts/lib contracts/foundry.toml web package-lock.json` | PASS, exit 0 | `runtime-scope-check.log` |

All local evidence above is under `artifacts/sepolia-native-vrf-20261007/`, which is ignored and mode 0700. Existing lint warnings from unchanged source are retained in the size log. Forge is 1.5.1-stable, compiler 0.8.24, via IR, optimizer 200 runs, Cancun. The critical role's context specifies GPT-6 Astra High; independent process routing telemetry and usage counts are unavailable. Usage is unknown. See `versions.log`.

Root's read-only Sepolia evidence is in the sibling `labx-nav-fix/artifacts/sepolia-native-vrf-20261007/` worktree directory: `sepolia-readiness.json`, `operational-readiness.md`, and `balance-recheck-11860441.json`. At block 11860407 the intended Safe had no code and the subscription had zero LINK, 0.05 native ETH, zero requests and only the legacy consumer. The later observation at block 11860441 supersedes that balance with 0.10 native ETH; the Safe still has no code. Neither balance is proof of sufficient funding. Root's 0.434 ETH calculation is an illustrative planning allowance using a documented example overhead, not verified live Max Cost or an exact minimum.

No keys or secret files were read, and no broadcasts, network writes, pushes or deployments occurred in this implementation lane. Tests overwrite script inputs with disposable fixtures, including the public test key `0xA11CE`; these values are not credentials. Live deployment and Chainlink fulfillment remain BLOCKED on Safe activation and verification, a qualified human release decision and wallet flow, consumer registration, and an approved funding budget checked against live Max Cost.

## Independent verification and release boundary

The independent verifier used the separate `labx-native-vrf-independent` worktree. Its test-only commit `539d01fffc01b35681ca7a0424efa3eca60c3471` is directly based on tested source candidate `49db614a00c18c160afe74ccfdd32c7b5a1ca51f`; it does not change production code and has not been merged into the deployment branch. Evidence lives in that worktree's `artifacts/sepolia-native-vrf-20261007-independent/` directory.

- PASS: two independent real-script tests, including omitted `WIRE_ETH_PATH` and a recorded request that retains the original billing/key/subscription/gas/confirmation/terms policy after Safe default changes. Evidence: `focused-independent-post-format.log` and its exit file, exit 0.
- PASS: all seven candidate deployment tests rerun independently, exit 0. Evidence: `candidate-deployment-tests.log` and its exit file.
- PASS: independent formatting, runtime size, unchanged runtime scope and whitespace checks, all exit 0. Runtime size is 21,027 bytes.
- An initial independent fixture called the ETH-path setter from an unauthorized caller and received `NotOwner` instead of the intended disabled-path error. Only the fixture caller was corrected. The failed log remains preserved; this was not a candidate defect.
- The independent verifier did not repeat the full fuzz suite. The 84-test, ten-by-1,024-fuzz result above belongs to the builder's full run; the separate independent checks must not be combined into an invented aggregate run.
- Web tests, browser QA, public-chain deployment and live randomness fulfillment were NOT_RUN for this slice. The website, raffle runtime, ABI, compiler configuration and dependencies are unchanged. The first two checks are outside this deployment-script slice; the live checks remain blocked.

The final checkpoint commit changes this document only. Existing test results remain evidence for unchanged source candidate `49db614`; a diff check and final independent review bind the closeout revision to that source rather than claiming another test run.

Root's public reads are also copied into `artifacts/sepolia-native-vrf-20261007/live-readiness/`; `LATEST.md` identifies the confirmed 0.10 ETH subscription balance at block 11860441 and the still-undeployed Safe. The Subscription Manager's public details independently displayed the account and historical consumer; no wallet was connected in this check. No live Max Cost for a new consumer has been verified. The user, not the agent, performed the confirmed top-up.

Deployment, setting native billing and proposing ownership are separate transactions. The runtime permits sellers to open raffles during setup, so treating a partially configured contract as inactive is an operational restriction, not an enforced contract state. Before release, inspect any openings and their pinned policies as well as current defaults; do not assume a later default correction repairs an already-open raffle.

Next operational action: the user activates the intended Safe on Sepolia through their wallet. Read back and verify its implementation, owners, threshold, modules and guards, then prepare the exact deployment transaction sequence and funding budget for the qualified human release decision. This locally reviewed change does not activate the historical contract or publish a website deployment manifest.
