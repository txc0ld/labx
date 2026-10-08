# Seller workspace layout — 2026-10-08

The seller workspace now places draft creation in a full-width, normal-flow section. The draft form uses four numbered groups, container-responsive fields, identified pack removal controls, and explicit review/edit focus handoffs. Revenue remains derived from the existing portfolio calculations and is presented as seller proceeds, pending and refunds, and sales history.

The implementation does not change seller permissions, draft validation, commitments, persistence, transaction handlers, wallet behavior, or financial calculations.

Verification evidence is under `artifacts/unified-wallet-20261008/seller-layout/builder/`. The connected local-chain browser run covers 320, 390, 768, 1024, 1440, and 1680 pixel widths, CSS zoom at 200%, keyboard disclosure and pack controls, add/remove, review, and edit focus restoration without signing or submitting a transaction. Native device and screen-reader checks were not run.
