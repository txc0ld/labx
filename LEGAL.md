# LABx product notes for counsel

This is an engineering/product draft, not a legal opinion or clearance to operate a public promotion. The website's canonical versioned membership terms and draw rules are in `web/lib/published-terms.ts`; editing those changes their hash and requires a reviewed publication/configuration plan.

## Operator and product

Operator details supplied for the project: Fantom Labs Pty Ltd, ABN 56 702 056 166, ACN 702 056 166. Brand: LABx.

Customers purchase memberships associated with an individual NFT raffle. Each pack publishes its price, included bonus-entry count and supply. The prepared v3 policy adds a processing fee of 2.50 USDC or 2% of each purchase call’s principal, whichever is higher, and deducts a separate 2% from the seller’s total membership principal at settlement. Percentage amounts round down in USDC atomic units after price is multiplied by quantity. Separate purchase calls each pay their own minimum. Cancelled raffles return pack principal only; processing fees are retained even after timeouts or funding failure. No seller commission accrues on cancellation. Existing v2 contracts retain their fixed 5-USDC fee. The design ladder is Entry, Bronze, Silver, Gold and Platinum; the contract also permits reviewed custom packs. Bonus entries are included with a purchase. There is no complimentary-entry route in version 3.

Member discounts supplied by the user are 5% off Fantom Labs services and 5% off SeatMap Pro membership. `XXXX` is a placeholder, not a redeemable code. Availability, eligibility and partner terms still need confirmation before redemption goes live.

## Intended contract process

An NFT is escrowed and LABx reviews the exact collection, token, custody, transfer behavior and use of draw funding before memberships can open. Changes to the draft require a fresh approval. Opening fixes the economics, deadline, treasury, terms and randomness policy. After sales close, eligible entries are snapshotted and the pinned VRF coordinator supplies randomness. Entries expire after 365 days. Settlement enables separate prize, seller-proceeds and treasury-fee claims. Cancellation enables buyers to claim their principal only and the seller to reclaim the NFT.

The fixed draw-start, randomness and reveal grace periods are seven days each, measured from their respective events. See `SECURITY.md` for exact boundaries and exceptions. A commitment proves recorded hashes, not a numeric reserve rule.

## Publication and release

The implementation is intended for Sepolia. Ethereum mainnet is blocked by the contract and no approved version 3 deployment manifest is configured. Local source changes do not change the existing Sepolia bytecode. Signed agreements are assertions, not verified age, identity or legal eligibility.

Before non-test operation, qualified counsel must review the actual membership benefits, promotion structure, entry conditions, eligibility, jurisdiction restrictions, fees, cancellation/refund terms, privacy and partner offers. Calling a payment a membership does not itself determine its legal treatment. No legal conclusion has been supplied for this product.

The user-facing routes are `/legal`, `/rules`, `/privacy`, `/about` and `/guide`; `/terms` redirects to `/legal`. Receipt emails require configured delivery and a verified finalized purchase.
