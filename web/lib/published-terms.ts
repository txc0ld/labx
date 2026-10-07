import { keccak256, stringToHex, type Hex } from "viem";
import * as historicalV2 from "./published-terms-v2";

export type PublishedSection = { heading: string; paragraphs: readonly string[] };
export const TERMS_VERSION = "labx-membership-2026-10-07-v3";
export const MEMBERSHIP_TERMS: readonly PublishedSection[] = [
  { heading: "Operator", paragraphs: ["LABx is operated by Fantom Labs Pty Ltd (ABN 56 702 056 166, ACN 702 056 166)."] },
  { heading: "Network", paragraphs: ["These terms describe unpublished v3 contracts. The existing live v2 contract retains its fixed 5-USDC fee per pack. The v3 contract blocks Ethereum mainnet chain 1. The website permits only approved Sepolia or isolated local deployments. Sepolia is a test network."] },
  { heading: "Membership packs", paragraphs: ["A membership pack is a paid membership for a single piece. Bonus entries included with a pack are a feature of that membership. They expire 12 months after they are recorded."] },
  { heading: "Agreements", paragraphs: ["You must confirm the agreements, including that you are 18 or older and eligible where you participate. Participation may be restricted where it is not lawful. These terms are a product draft for counsel, not a legal opinion."] },
  { heading: "Draw and settlement", paragraphs: ["The piece is escrowed before memberships open. After sales close, eligible bonus entries are frozen, then Chainlink VRF v2.5 selects the wallet. The winner claims the NFT, the seller claims net membership proceeds, and the pinned treasury receives buyer fees and the seller commission.", "If a raffle is cancelled before settlement, each buyer can claim their outstanding membership principal only. The processing fee is retained, including cancellation after a draw timeout or funding failure. No seller commission accrues on cancellation. The seller can reclaim the NFT."] },
  { heading: "Fees", paragraphs: ["Each successful purchase call adds a processing fee equal to the greater of 2.50 USDC and 2% of principal. A call selects one pack ID. Multiply its price by quantity first, then round the 2% amount down to the nearest USDC base unit, 0.000001 USDC, and apply the minimum once to that call. Each separate call pays a new minimum, including multiple calls in a smart-wallet batch. Failed purchases retain no fee.", "At settlement, a separate 2% seller commission is deducted once from the total membership principal sold, rounded down to the nearest USDC base unit. The seller receives the remaining principal. Buyer fees and the seller commission are separate charges.", "Cancellation refunds outstanding principal only; the successful purchase processing fee is nonrefundable. No seller commission is charged on cancellation. ETH is an optional payment route through Uniswap and the Chainlink ETH/USD feed for the same USDC total. ETH-route cancellation refunds are principal denominated in USDC, not ETH. Gas and swap costs are not refunded. USDC is the unit of account."] },
  { heading: "Commitments", paragraphs: ["A private commitment is stored as a hash. LABx does not publish that private commercial number on public pages."] },
  { heading: "Admin", paragraphs: ["The intended admin and treasury authority is a Safe multisig. LABx must approve each draft's exact prize and use of draw funding before opening. Seller draft edits require review again. Approval does not reserve subscription balance, prove authenticity or guarantee transferability. NFT code hashes do not identify proxy implementations or mutable transfer restrictions. Runtime attestation checks bytecode and payment-token identity, not approved Safe custody, a legitimate coordinator or NFT authenticity. Fantom Labs can change future opening settings, cancel drafts or eligible no-sale raffles, reveal a valid commitment, pause new sales and affect subscription funding. After purchases, discretionary cancellation remains restricted to a completed empty snapshot; timed cancellation and VRF abort remain available under the contract deadlines. A pause does not stop closing, drawing, settlement, claims or timed recovery. Cancellation refunds principal only."] },
  { heading: "Privacy", paragraphs: ["Wallet, email, agreement, and server records are described in the privacy policy. The operator is introduced on the about page."] }
];
export const DRAW_RULES: readonly PublishedSection[] = [
  { heading: "Membership first", paragraphs: ["Customers buy a membership for one piece. Bonus entries are included only with that purchased membership.", "Bonus entries expire 12 months after they are recorded. Expired entries are left out of the snapshot."] },
  { heading: "Before the draw", paragraphs: ["LABx reviews the exact NFT and draw-funding use before opening. Draft edits require a fresh review. Opening fixes the NFT, membership economics, closing time, treasury and randomness configuration. The raffle cannot close before its published deadline.", "After sales close, eligible entries freeze before randomness is requested."] },
  { heading: "Outcome and recovery", paragraphs: ["Chainlink VRF selects from the frozen snapshot. The winner claims the NFT, the seller claims net membership proceeds, and the pinned treasury receives buyer fees and the seller commission.", "If the raffle is cancelled, each buyer claims outstanding membership principal only. Processing fees remain retained even after draw timeout or funding failure. No seller commission accrues on cancellation. The seller can reclaim the NFT."] }
];
export const PUBLISHED_TERMS_CONTENT = JSON.stringify({ version: TERMS_VERSION, terms: MEMBERSHIP_TERMS, rules: DRAW_RULES });
export const PUBLISHED_TERMS_HASH = keccak256(stringToHex(PUBLISHED_TERMS_CONTENT));
export function requirePublishedTerms(hash: Hex): void {
  if (hash.toLowerCase() !== PUBLISHED_TERMS_HASH.toLowerCase()) throw new Error("The raffle's terms do not match the published membership terms. Purchases are unavailable.");
}

// Historical lookup is for reading published content, never permission for a new purchase.
export function publishedTermsByHash(hash: Hex) {
  const publication = hash.toLowerCase() === PUBLISHED_TERMS_HASH.toLowerCase()
    ? { version: TERMS_VERSION, hash: PUBLISHED_TERMS_HASH, content: PUBLISHED_TERMS_CONTENT, terms: MEMBERSHIP_TERMS, rules: DRAW_RULES }
    : hash.toLowerCase() === historicalV2.PUBLISHED_TERMS_HASH.toLowerCase()
      ? { version: historicalV2.TERMS_VERSION, hash: historicalV2.PUBLISHED_TERMS_HASH, content: historicalV2.PUBLISHED_TERMS_CONTENT, terms: historicalV2.MEMBERSHIP_TERMS, rules: historicalV2.DRAW_RULES }
      : null;
  if (!publication) throw new Error("Unknown published terms hash.");
  return publication;
}
