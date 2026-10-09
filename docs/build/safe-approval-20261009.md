# Safe approval handoff — 2026-10-09

## Scope and invariants

This slice keeps LABx read-only until the owner acts in Safe. LABx never signs, submits, proposes, or changes the connected account. Owner permissions, the stored intent parser, export validation, and `confirmOwnerExecution` remain authoritative.

The handoff exports one Safe Transaction Builder 2.0.1 file with format version 1.0. It contains exactly one zero-ETH call to the configured raffle contract. Chain, Safe, target, action calldata, file checksum, raffle ID, review digest, and action metadata are derived from the freshly prepared and exported intent. The parser rejects altered or additional fields.

Both `/review` and `/review/[id]` read the verified deployment and current owner before the owner gate. Disconnected, wrong-network, and wrong-account states explain the exact Safe WalletConnect flow. The owner-only queue is not read until the connected account equals the current owner.

Every download repeats `prepare` and `exportOwnerExecution`. Restored intent alone cannot authorize a new download. A recovered, already-recorded revocation is confirmation-only.

Execution discovery starts at the intent review block, scans pages of at most 2,000 blocks, caps matching logs at 32 per page, and has a bounded timeout. It pins and rechecks the page checkpoint around `eth_getLogs`, resets a noncanonical cursor, accepts only exact canonical event encodings, and returns deterministic outer Ethereum transaction hashes. Every candidate still passes unchanged `confirmOwnerExecution`, including receipt success, exact event/digest/generations/state, and two canonical confirmations. Visibility polling and return-to-page checks use operation-generation guards so wallet, network, route, review, and unmount changes retire stale work.

## Source compatibility

Pinned source evidence is in `artifacts/safe-approval-20261009/reference/`. The serializer matches the vendored Safe Transaction Builder 2.0.1 import schema and checksum algorithm documented there.

## Builder evidence

Passing checks observed before the first candidate freeze:

- `npx tsc --noEmit`: PASS.
- Focused unit/UI suite: 3 files, 20 tests PASS (`31-green-malformed-boundary.log`, `32-typecheck-candidate.log`).
- Admission integration: 13 tests PASS (`13-admission-integration.log`).
- Safe handoff browser: 2 tests PASS, including `/review` wrong-wallet help, responsive widths 320/390/768/1440, keyboard checklist/download, downloaded JSON, and discovery on return (`26-safe-approval-browser-queue.log`).
- Owner review race browser: 4 tests PASS (`27-owner-review-race.log`).
- Independent owner review race browser: 5 tests PASS (`28-independent-owner-review-race.log`).
- Contract fixture build: PASS (`12-contract-fixture-build.log`).

Red-to-green evidence includes checksum compatibility, discovery paging, reorg during log query, malformed log data/topics/identity, and malformed RPC items that precede a valid candidate. Full logs are under `artifacts/safe-approval-20261009/builder/`.

Pending at first freeze: activation-trust rerun and diagnosis of the independent browser journey's repeated resource 503 console errors. The journey behavior completed, but its strict console assertion failed; this is not recorded as a passing check.
