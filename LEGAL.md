# LABx product notes for counsel

This is an engineering/product draft, not a legal opinion or clearance to operate a public promotion. The website's canonical versioned membership terms and draw rules are in `web/lib/published-terms.ts`; editing those changes their hash and requires a reviewed publication/configuration plan.

## Operator and product

Operator details supplied for the project: Fantom Labs Pty Ltd, ABN 56 702 056 166, ACN 702 056 166. Brand: LABx.

Customers purchase memberships associated with an individual NFT raffle. Each pack publishes its price, included bonus-entry count and supply. The v3 policy adds a processing fee of 2.50 USDC or 2% of each purchase call’s principal, whichever is higher, and deducts a separate 2% from the seller’s total membership principal at settlement. Percentage amounts round down in USDC atomic units after price is multiplied by quantity. Separate purchase calls each pay their own minimum. Cancelled raffles return pack principal only; processing fees are retained even after timeouts or funding failure. No seller commission accrues on cancellation. Existing v2 contracts retain their fixed 5-USDC fee. The design ladder is Entry, Bronze, Silver, Gold and Platinum; the contract also permits reviewed custom packs. Bonus entries are included with a purchase. There is no complimentary-entry route in version 3.

Member discounts supplied by the user are 5% off Fantom Labs services and 5% off SeatMap Pro membership. `XXXX` is a placeholder, not a redeemable code. Availability, eligibility and partner terms still need confirmation before redemption goes live.

## Intended contract process

An NFT is escrowed and LABx reviews the exact collection, token, custody, transfer behavior and use of draw funding before memberships can open. Changes to the draft require a fresh approval. Opening fixes the economics, deadline, treasury, terms and randomness policy. After sales close, eligible entries are snapshotted and the pinned VRF coordinator supplies randomness. Entries expire after 365 days. Settlement enables separate prize, seller-proceeds and treasury-fee claims. Cancellation enables buyers to claim their principal only and the seller to reclaim the NFT.

The fixed draw-start, randomness and reveal grace periods are seven days each, measured from their respective events. See `SECURITY.md` for exact boundaries and exceptions. A commitment proves recorded hashes, not a numeric reserve rule.

## Publication and release

On Sepolia, the v3 contract runs at `0x8b0332D0ca48908e174F42eA1b3123e63f3F4327` and labx.art uses it; local source changes do not change that bytecode. Its constructor blocks Ethereum mainnet. The mainnet version (PR #16) removes that block, deploys paused through `contracts/script/DeployMainnet.s.sol`, and hands ownership to the Safe, which sets the final terms hash and unpauses at launch. Signed agreements are assertions, not verified age, identity or legal eligibility.

Before non-test operation, qualified counsel must review the actual membership benefits, promotion structure, entry conditions, eligibility, jurisdiction restrictions, fees, cancellation/refund terms, privacy and partner offers. Calling a payment a membership does not itself determine its legal treatment. No legal conclusion has been supplied for this product.

The user-facing routes are `/legal`, `/rules`, `/privacy`, `/about` and `/guide`; `/terms` redirects to `/legal`. Receipt emails require configured delivery and a verified finalized purchase.

## Mainnet launch: counsel items

A build with `NEXT_PUBLIC_CHAIN_ID=1` publishes terms version `labx-membership-2026-10-19-mainnet-v1`. Its text equals the Sepolia v3 terms except two statements of fact: the Network section describes Ethereum mainnet, and the Fees section says purchases are paid in USDC only, because the mainnet deployment has no swap router, WETH or price feed (Sepolia's terms describe an optional ETH route that its live contract also leaves disabled). The pages' network facts follow the configured chain. A Sepolia build is unchanged.

These legal characterizations still read as they do on Sepolia. On a mainnet build each is shown under a "Pending counsel review" label until counsel decides the wording:

- About: "These pages are a product draft for counsel, not a legal opinion and not a consumer promotion."
- Privacy, opening paragraph: "It is a product draft for counsel, not a legal opinion."
- Privacy, Who we are: "This deployment is a test bench. It is not a consumer promotion."
- Terms: the mainnet terms keep every legal characterization of the Sepolia terms, including "These terms are a product draft for counsel, not a legal opinion." The Terms page carries one label saying so, because the published text itself is hashed.

These statements are the same on both networks and also need counsel's review before mainnet operation: the Privacy Act 1988 and APP 3 and APP 6 basis, the 18-or-older eligibility, the statement that no government identity document is requested, the pages' description of LABx as a "bench", and the fees, cancellation and refund terms. Privacy also has no published privacy mailbox yet (it points to the operator's profile), and its list of processors (site host, Neon or Redis, Alchemy NFT API, email sender, wallet, public chain infrastructure) should be confirmed for the mainnet project's actual vendors.
