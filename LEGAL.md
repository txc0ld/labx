# LABx legal notes

This is a product draft for counsel. It is not a legal opinion and it is not advice to run a public promotion.

## Operator

Fantom Labs Pty Ltd  
ABN 56 702 056 166  
ACN 702 056 166  
Brand: LABx  
Site: labx.art

## Network

Version 1.0 is Ethereum Sepolia only. Sepolia assets have no cash value. The contract reverts on chain id 1. The deploy script reverts on every chain id other than 11155111. The website refuses a mainnet wallet. Do not advertise this deployment as a mainnet product.

## What is sold

A membership pack for one piece. The ladder is Entry, Bronze, Silver, Gold, Platinum. Each pack has a USDC price and a published number of bonus entries into that piece. A 5 USDC lab fee is added on top and is directed to the Safe treasury when the piece settles.

Packs are not marketed as tickets. Public pages do not show a floor or the private commitment. They show the pack price, the lab fee, the bonus-entry count, and the commitment hash.

## Draw

The prize is the escrowed token. Sales close, entries are snapshotted, expired entries drop out, then Chainlink VRF v2.5 supplies the word. Bonus entries expire 12 months after they are recorded.

If the piece is cancelled before settlement, the buyer can pull a refund of pack price and lab fee, and the token returns to the seller.

## Complimentary entry

One complimentary bonus entry may be requested per person per piece. The route requires a bot-gated check-in (points), a captcha, and the same agreements as a paid pack. It is placed on the draw-rules page and is not promoted on the explore bench. Counsel should confirm whether that placement meets the alternative-entry rules of each jurisdiction before any production use. This Sepolia deployment is not a consumer promotion.

## Agreements

A pack or complimentary entry requires three confirmations: membership terms, draw rules including the 12-month expiry, and eligibility including age 18 or older.

## Email

Receipts are sent with Resend when configured. They describe the pack, the bonus entries, the price, the lab fee, and the expiry.

## Counsel checklist before any non-test use

- Trade promotion and lottery treatment in each target jurisdiction, including Australia.
- Whether the complimentary route is prominent enough, and whether points may be required.
- Sanctions, age, and geo restrictions.
- Consumer copy, cooling-off, and refund wording.
- Privacy notice for wallet, email, and server records. The published draft is `/privacy`. The operator page is `/about`. Terms are `/legal` (`/terms` redirects there).
- Safe signer policy and key custody.

Until that review, keep the system on Sepolia and describe it as a test bench.
