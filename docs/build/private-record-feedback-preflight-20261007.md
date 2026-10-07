# Private-record feedback after wallet changes

This bounded R2 amendment addresses the source review note in `PrivateRecordsPanel.tsx`. The authenticated APIs already bind the wallet and receipt recipient. No private-data disclosure or authorization bypass has been established. The observed source gap is that receipt delivery completion and error callbacks update component state without checking whether the wallet changed while awaiting the response.

## Invariants

- A result, loading indicator, delivery acknowledgement or error started by wallet A must never appear as wallet B's activity, including A to B to A, disconnect/reconnect and route unmount/remount.
- Compare the current wallet session revision, account and chain before applying asynchronous results. Account equality alone does not distinguish an earlier connection to that account.
- Completion of an old operation cannot release another operation's in-flight lock or change its status. Preserve duplicate-send prevention within the active session and existing API idempotency.
- Keep current private-history and record-query generation checks. Do not weaken wallet signatures, ownership proof, receipt recipient binding, finalized-purchase checks or persistent storage behavior.
- Show the actual configured receipt email next to its send controls so a browser preference is not mistaken for an address derived from the wallet. This is a saved browser preference, not a verified identity.
- Pending requests may finish server-side after a wallet change. Do not claim cancellation of a request already accepted by the server. Discard stale UI feedback and allow the user to refresh authoritative records.

## Implementation and evidence

Use an isolated Sol High owner for this component and its rendered regressions. Reproduce a delayed response with local dummy data before applying the smallest fix. Test success and failure after account switches, disconnect/reconnect and unmount, plus a current-session successful delivery and duplicate-click protection. Verify the existing record-loading isolation still works. A fresh independent browser verifier must execute these cases on the integrated candidate; source review alone is insufficient.

This change does not add wallet transaction support, alter contract policy, change any recipient, create a new backend endpoint or publish anything. Root owns the final integration and review.
