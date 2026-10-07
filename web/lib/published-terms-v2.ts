// Historical v2 publication. Preserve its JSON serialization and hash exactly.
import { keccak256, stringToHex, type Hex } from "viem";

export type PublishedSection = { heading: string; paragraphs: readonly string[] };
export const TERMS_VERSION = "labx-membership-2026-10-06-v2";
export const MEMBERSHIP_TERMS: readonly PublishedSection[] = [
  { heading: "Operator", paragraphs: ["LABx is operated by Fantom Labs Pty Ltd (ABN 56 702 056 166, ACN 702 056 166)."] },
  { heading: "Network", paragraphs: ["This deployment is intended for Ethereum Sepolia only. It is a test network. Mainnet deployment is disabled in the contract and in the wallet gate."] },
  { heading: "Membership packs", paragraphs: ["A membership pack is a paid membership for a single piece. Bonus entries included with a pack are a feature of that membership. They expire 12 months after they are recorded."] },
  { heading: "Agreements", paragraphs: ["You must confirm the agreements, including that you are 18 or older and eligible where you participate. Participation may be restricted where it is not lawful. These terms are a product draft for counsel, not a legal opinion."] },
  { heading: "Draw and settlement", paragraphs: ["The piece is escrowed before memberships open. After sales close, eligible bonus entries are frozen, then Chainlink VRF v2.5 selects the wallet. The winner claims the NFT, the seller claims membership proceeds, and the pinned treasury receives the lab fee.", "If a raffle is cancelled before settlement, each buyer can claim the membership price and lab fee they paid. The seller can reclaim the NFT."] },
  { heading: "Lab fee", paragraphs: ["The lab fee is 5 USDC per pack, denominated in USDC. ETH can be used only as an optional route through Uniswap and the Chainlink ETH/USD feed. USDC is the unit of account."] },
  { heading: "Commitments", paragraphs: ["A private commitment is stored as a hash. LABx does not publish that private commercial number on public pages."] },
  { heading: "Admin", paragraphs: ["The intended admin and treasury authority is a Safe multisig. Fantom Labs can pause new membership sales. A pause does not stop closing, drawing, settlement, claims or timed recovery for an existing raffle."] },
  { heading: "Privacy", paragraphs: ["Wallet, email, agreement, and server records are described in the privacy policy. The operator is introduced on the about page."] }
];
export const DRAW_RULES: readonly PublishedSection[] = [
  { heading: "Membership first", paragraphs: ["Customers buy a membership for one piece. Bonus entries are included only with that purchased membership.", "Bonus entries expire 12 months after they are recorded. Expired entries are left out of the snapshot."] },
  { heading: "Before the draw", paragraphs: ["Opening fixes the NFT, membership economics, closing time, treasury and randomness configuration. The raffle cannot close before its published deadline.", "After sales close, eligible entries freeze before randomness is requested."] },
  { heading: "Outcome and recovery", paragraphs: ["Chainlink VRF selects from the frozen snapshot. The winner claims the NFT, the seller claims membership proceeds, and the pinned treasury receives the lab fee.", "If the raffle is cancelled, each buyer claims the membership price and lab fee they paid. The seller can reclaim the NFT."] }
];
export const PUBLISHED_TERMS_CONTENT = JSON.stringify({ version: TERMS_VERSION, terms: MEMBERSHIP_TERMS, rules: DRAW_RULES });
export const PUBLISHED_TERMS_HASH = keccak256(stringToHex(PUBLISHED_TERMS_CONTENT));
