# Seller workspace layout — 2026-10-08

The seller workspace now places draft creation in a full-width, normal-flow section. The draft form uses four numbered groups, container-responsive fields, identified pack removal controls, and explicit review/edit focus handoffs. Revenue remains derived from the existing portfolio calculations and is presented as seller proceeds, pending and refunds, and sales history.

The implementation does not change seller permissions, draft validation, commitments, persistence, transaction handlers, wallet behavior, or financial calculations.

Membership rows use stable local IDs that are omitted from submitted draft data. Removing a row moves focus to the visible Add membership control and announces the remaining count. Editing a reviewed draft scrolls the first fieldset and its label into view before focusing the title. Help text is exposed as an accessible description instead of being repeated in the field name.

Verification evidence is under `artifacts/unified-wallet-20261008/seller-layout/builder/`. The connected local-chain browser run covers 320, 390, 768, 1024, 1440, and 1680 pixel widths, CSS zoom at 200%, keyboard disclosure and pack controls, add/remove, review, and edit focus restoration without signing or submitting a transaction. Native device and screen-reader checks were not run.

Later accessibility repairs and independent seller-detail reflow checks are recorded under `artifacts/unified-wallet-20261008/seller-pack-focus-repair/` and `artifacts/unified-wallet-20261008/verification/`. These include computed accessible names, phone and desktop focus visibility, and the form reused on seller detail. Browser accessibility-tree checks do not establish behavior in a physical screen reader.
