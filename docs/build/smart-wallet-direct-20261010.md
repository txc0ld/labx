# Direct transactions from delegated accounts

Base revision: `f7eb05edb608a715c9c3e754a4d937eca22a79f0`.
Risk: R3. The parent approved the exact EIP-7702 marker admission change.

## Contract

Accept empty account code and exactly 23 bytes encoded as `0xef0100` followed by 40 hexadecimal characters, case insensitive. Reject every other nonempty code value before nonce retrieval, journal access or a wallet transaction request. Preserve the contract-wallet error and Safe external execution route.

Preserve the reviewed sender, destination, calldata, value, network and explicit nonce. Preserve fresh simulation, wallet-session validation, exclusive journal ownership before the provider request, two canonical confirmations, and exact sender, nonce and intent checks. A rejection may clear only its matching unsent journal entry. An ambiguous response must retain recovery.

The wallet and RPC may return malformed or misleading values. Delegation alone does not authorize a wrapper, relayer, bundle identifier or changed transaction intent. No production signing, deployment, delegate authorization or adapter changes are in scope.

## Acceptance and recovery

Use isolated Anvil to authorize delegation with a local fixture account, then submit and confirm direct prize approval and escrow with consecutive nonces. Test empty-code accounts and uppercase delegation markers. Reject short, long, nonhex, wrong-prefix, ordinary-contract and trailing-newline code before submission side effects. Run existing wallet rejection/recovery and Safe admission tests, plus TypeScript checking.

The parent owns independent adversarial verification, fresh source review, aggregate checks and the release decision. These gates remain required after implementation. Rollback reverts the service admission condition; no data, deployment or schema changes need reversal. Keep the existing journal recovery path for any transaction already sent.

## Evidence

Full logs: `../artifacts/smart-wallet-20261010/builder/` relative to the worktree root.

- Baseline: existing wallet repair and admission integration suites passed, 28 tests in 2 files, exit 0.
- Regression before the fix: `regression-before-fix.log`, exit 1. Both real-delegation cases failed at the smart-account rejection; the other 11 cases passed.
- Final candidate: `RUN_CHAIN_INTEGRATION=1 npm test -- test/smart-wallet-direct.integration.test.ts test/wallet-review-repairs.integration.test.ts test/admission.integration.test.ts` passed, 41 tests in 3 files, exit 0. See `focused-final.log`.
- Final candidate: `npx tsc --noEmit` passed, exit 0. See `typecheck-final.log`. `git diff --check` also passed, exit 0.
- Independent verification, source review, aggregate tests, build and release are NOT_RUN by this worker and remain with the parent.
- Model usage is unavailable to this worker and is recorded as unknown.
