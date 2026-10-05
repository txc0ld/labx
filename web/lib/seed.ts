export type PackName = "Entry" | "Bronze" | "Silver" | "Gold" | "Platinum";

export type Pack = {
  name: PackName;
  priceUsdc: number;
  bonusEntries: number;
  remaining: number;
  supply: number;
};

export type Phase = "draft" | "open" | "closed" | "drawing" | "drawn" | "settled" | "cancelled";

export type Piece = {
  id: string;
  title: string;
  artist: string;
  image: string;
  imageAlt: string;
  phase: Phase;
  escrowed: boolean;
  salesEnd: string;
  packs: Pack[];
  commit?: string;
  nonce?: string;
  publicHash?: string;
  privateHash?: string;
  salt?: string;
  publicSummary?: string;
  revealed?: boolean;
  snapshotTotal?: number;
  randomWord?: string;
  winner?: string;
  vrfNote?: string;
  nft: string;
  tokenId: string;
};

export type Entry = {
  id: string;
  pieceId: string;
  pieceTitle: string;
  label: string;
  count: number;
  expiresAt: string;
  kind: "pack" | "complimentary";
  address: string;
};

export const LAB_FEE = 5;
export const DEMO_ADDRESS = "0x00000000000000000000000000000000000b0b01";

export const PACK_LADDER: Pack[] = [
  { name: "Entry", priceUsdc: 25, bonusEntries: 1, remaining: 80, supply: 80 },
  { name: "Bronze", priceUsdc: 50, bonusEntries: 5, remaining: 40, supply: 40 },
  { name: "Silver", priceUsdc: 100, bonusEntries: 15, remaining: 24, supply: 24 },
  { name: "Gold", priceUsdc: 250, bonusEntries: 40, remaining: 12, supply: 12 },
  { name: "Platinum", priceUsdc: 500, bonusEntries: 100, remaining: 6, supply: 6 }
];

export const SEED_PIECES: Piece[] = [
  {
    id: "junction-array",
    title: "Junction Array",
    artist: "LABx studio",
    image: "/lab/hero-linked-panels.jpg",
    imageAlt: "Pearlescent terminal and glossy filter panel linked by mirrored chrome tubes and fluorescent cables",
    phase: "open",
    escrowed: true,
    salesEnd: "2027-06-01T00:00:00.000Z",
    packs: PACK_LADDER.map((pack) => ({ ...pack })),
    commit: "0x8c1e0a77c0ffee00112233445566778899aabbccddeeff001122334455667788",
    publicSummary: "The escrowed piece is the prize. Membership packs are the only thing for sale.",
    revealed: false,
    nft: "0x000000000000000000000000000000000000a11c",
    tokenId: "1"
  },
  {
    id: "filter-bank",
    title: "Filter Bank",
    artist: "LABx studio",
    image: "/lab/filter-panel.jpg",
    imageAlt: "Glossy pearlescent filter panel with chunky buttons, a chrome port, and a fluorescent cable",
    phase: "open",
    escrowed: true,
    salesEnd: "2027-05-12T00:00:00.000Z",
    packs: PACK_LADDER.map((pack) => ({ ...pack, remaining: Math.max(1, pack.remaining - 3) })),
    commit: "0x4411aa90bb22cc33dd44ee55ff66778899aabbccddeeff001122334455660011",
    publicSummary: "One piece, held in escrow, assigned with Chainlink VRF after the snapshot.",
    revealed: false,
    nft: "0x000000000000000000000000000000000000b22c",
    tokenId: "4"
  },
  {
    id: "terminal-well",
    title: "Terminal Well",
    artist: "LABx studio",
    image: "/lab/terminal-panel.jpg",
    imageAlt: "Purple terminal housing with a mirrored chrome bezel, chunky keys, and a fluorescent cable",
    phase: "open",
    escrowed: true,
    salesEnd: "2027-04-20T00:00:00.000Z",
    packs: PACK_LADDER.map((pack) => ({ ...pack })),
    commit: "0x77abc1234567890abcdeff00112233445566778899aabbccddeeff00112233aa",
    revealed: false,
    nft: "0x000000000000000000000000000000000000c33d",
    tokenId: "8"
  },
  {
    id: "cable-run",
    title: "Cable Run",
    artist: "LABx studio",
    image: "/lab/chrome-fluoro-run.jpg",
    imageAlt: "Mirrored chrome tube junctions and fluorescent cables linking two instrument panels",
    phase: "draft",
    escrowed: false,
    salesEnd: "2027-07-01T00:00:00.000Z",
    packs: PACK_LADDER.map((pack) => ({ ...pack })),
    nft: "0x000000000000000000000000000000000000d44e",
    tokenId: "12"
  }
];
