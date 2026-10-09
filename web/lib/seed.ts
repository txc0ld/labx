import type { MembershipTierName } from "./membership-tiers";

export type PackName = MembershipTierName;

export type Pack = {
  name: PackName;
  priceUsdc: number;
  bonusEntries: number;
  remaining: number;
  supply: number;
};

export type Phase = "draft" | "open" | "closed" | "drawing" | "drawn" | "settled" | "cancelled";
export type PieceMark = "cable" | "filter" | "terminal" | "junction";

export type Piece = {
  id: string;
  title: string;
  artist: string;
  mark: PieceMark;
  image: string;
  imageAlt: string;
  phase: Phase;
  escrowed: boolean;
  salesEnd: string;
  packs: Pack[];
  commit?: string;
  nonce?: string;
  publicHash?: string;
  publicSummary?: string;
  revealed?: boolean;
  snapshotTotal?: number;
  randomWord?: string;
  winner?: string;
  vrfNote?: string;
  nft: string;
  tokenId: string;
};
