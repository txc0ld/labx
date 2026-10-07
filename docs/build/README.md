# Build documentation index

Use these documents for the current version 3 source:

- [Verified v3 Sepolia registration](v3-sepolia-registration-20261008.md) records the deployed contract, Safe acceptance and exact source manifest.
- [Action-specific activation guard](v3-activation-guard-20261008.md) records authority/policy enforcement and recovery boundaries; its empty-registry status describes its earlier freeze.
- [Repository cleanup and portable verification](repository-cleanup-plan-20261007.md) defines the current cleanup and verification contract.
- [Seller portal and percentage fees](seller-portal-fees-20261007.md) records the original portal scope; the following amendment supersedes its fee and refund policy.
- [Raffle admission and minimum buyer fee](raffle-admission-minimum-fee-20261007.md) records the current admission and retained-fee behavior.
- [Permissionless draw start and bounded snapshots](permissionless-draw-20261007.md) records the current draw and recovery behavior.
- [Scalability hardening](scalability-hardening-20261007.md) records the current bounded-read behavior.
- [Private-record feedback preflight](private-record-feedback-preflight-20261007.md) defines the current wallet-scoped feedback contract.
- [Wallet and checkout review repairs](review-repairs-20261007.md) defines the final recovery, signing and confirmation requirements.
- [Transaction outcome recovery](transaction-outcomes-20261007.md) defines durable receipts, replacement handling and the boundary between receipt inspection and pending-nonce reconciliation.
- [Aikido vendored CI finding](aikido-vendored-ci-20261007.md) records the unreachable upstream automation and its removal.
- [Dependency and CI security](dependency-ci-security-20261007.md) records the patched WebSocket dependency and verified action pins.
- [Release and migration plan](../../LAUNCH.md) lists the checks and approvals required before a release.

The following reports are retained as historical evidence. Later reports above supersede their candidate or design status:

- `*-20261006.md` reports predate the current version 3 seller, fee, admission and recovery candidate.
- [Latest website release candidate](latest-website-release-20261007.md) and [Revised LABx splash release](splash-release-20261007.md) describe earlier website candidates. The seller portal report and repository cleanup contract supersede them.
- [Seller portal and percentage fees design preflight](seller-portal-fees-preflight-20261007.md), [Admission and retained processing fee preflight](admission-fee-preflight-20261007.md) and [Contract policy preflight](contract-policy-20261006.md) are design inputs. Their implementation reports and the current source are authoritative for implemented behavior.

Historical reports remain useful for their exact revision and evidence pointers. They do not establish that the current candidate passed the same checks.
