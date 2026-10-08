# Automatic seller commitment

Base: `d978919d804db83c193102914d5da9ae78387c43`

The seller form now creates its private commitment from 32 browser-CSPRNG bytes only when the seller prepares a valid draft. Its public summary is derived from the canonical NFT address and decimal token ID. Existing drafts retain their commitment when that identity is unchanged, including escrowed drafts. A pending generated input remains stable across failed storage attempts, while a changed NFT generates a fresh input. The private value stays out of the DOM and browser storage and is discarded after durable storage succeeds.

The signed commitment API, durable-storage-before-transaction boundary, recovery flow, reveal flow, and contract inputs are unchanged. The form has three numbered sections and explains the storage signature without asking the seller to enter commitment values or copy a recovery hash.

Observed checks before candidate freeze:

- `npm test -- --run test/automatic-commitment.test.ts`: PASS, 2 tests.
- `npx tsc --noEmit --pretty false`: PASS.
- `RUN_SELLER_PORTAL_BROWSER=1 ... npm test -- --run test/seller-portal.browser.test.ts`: PASS, 10 tests, including retry stability, mismatch rejection, entropy failure, unchanged/escrowed retention, no transaction after failed storage, and responsive layouts.

Default tests, production build, and the existing authenticated browser lifecycle remain pending for the integration owner after this source freeze. Full builder logs and screenshots are in the ignored protected directory `artifacts/automatic-commitment-20261008/builder/`.
