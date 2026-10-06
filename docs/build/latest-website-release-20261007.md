# Latest website release candidate

Status: integrated for root-owned publication review. This record grants no push, deployment, wallet, contract, or on-chain authority.

## Revisions and scope

- Integration base: `7428c09b4d40f414007de8f924797c3bbca1b0f8` from `origin/main`.
- Reviewed source: `c5baec7e0ff5294982f9d47c743b89b0eb35d930` from `design/artwork-first-20261006`.
- Accepted runtime source: `db3c4a2fe9a9efb8caeb85885e3376f2deededd2`.
- Independent test addition: `4dd7688bdfaef754309aec590c75922d331bbf8c`.
- The source closeout at `c5baec7` changes documentation after those runtime and test revisions. This integration retains the main-only splash release record and marks its narrower scope as historical.

The candidate merges the complete reviewed website and contract tree. The primary menu has six links, including Membership and Discounts. Every menu item uses a transparent normal and current state, a thin current-page underline, `aria-current="page"`, and the shared keyboard focus outline. The approved BrandSplash and media remain byte-identical to the reviewed source.

## Invariants

- `web/` and `contracts/` must match the `c5baec7` trees exactly.
- `APPROVED_DEPLOYMENTS` remains empty. The legacy raffle address cannot enable actions because no deployment manifest approves it.
- The removed sample catalog and simulated actions remain absent. The points path does not create AMOE entries.
- The placeholder partner code `XXXX` remains unavailable for redemption.
- The privacy notice covers the email preference, pending-transaction journal, signed record requests, session intro flag, retention, and public-chain disclosure.
- Earlier build documents are historical evidence. They do not grant current publication or deployment authority.

## Candidate checks and evidence

Run against the committed merge candidate:

```text
RUN_CHAIN_INTEGRATION=1 RUN_BROWSER_ACCEPTANCE=1 npm test -- --maxWorkers=1
npx tsc --noEmit
npm run build
```

The first command is the 179-test aggregate and uses the existing local Anvil and browser fixtures. Full logs, the tree comparison, and the command-to-revision manifest belong in ignored `artifacts/latest-website-release-20261007/`. Root owns independent browser review and the separate contract gate before publication.
