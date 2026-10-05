export type PackName = "Entry" | "Bronze" | "Silver" | "Gold" | "Platinum";

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
    artist: "Demo placeholder",
    mark: "junction",
    image: "/artwork/demo-portrait-01.png",
    imageAlt: "Grayscale pixel-art portrait on a dark background",
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
    artist: "Demo placeholder",
    mark: "filter",
    image: "/artwork/argonaut-7297.png",
    imageAlt: "Gray pixel-art figure wearing a pink cap on a pale gray background",
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
    artist: "Demo placeholder",
    mark: "terminal",
    image: "/artwork/demo-portrait-03.png",
    imageAlt: "Olive and charcoal pixel-art figure on a dark background",
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
    artist: "Demo placeholder",
    mark: "cable",
    image: "/artwork/demo-portrait-04.png",
    imageAlt: "Purple and mint pixel-art figure on a dark background",
    phase: "draft",
    escrowed: false,
    salesEnd: "2027-07-01T00:00:00.000Z",
    packs: PACK_LADDER.map((pack) => ({ ...pack })),
    nft: "0x000000000000000000000000000000000000d44e",
    tokenId: "12"
  }
];

const LEGACY_DEMO_IMAGES: Record<string, string> = {
  "junction-array": "/lab/hero-linked-panels.jpg",
  "filter-bank": "/lab/filter-panel.jpg",
  "terminal-well": "/lab/terminal-panel.jpg",
  "cable-run": "/lab/chrome-fluoro-run.jpg"
};

/** Refresh only the original placeholder, preserving saved demo activity and custom artwork. */
export function withCurrentDemoArtwork(piece: Piece): Piece {
  const seed = SEED_PIECES.find((item) => item.id === piece.id);
  if (!seed || piece.image !== LEGACY_DEMO_IMAGES[piece.id]) return piece;
  return { ...piece, image: seed.image, imageAlt: seed.imageAlt,
    artist: piece.artist === "LABx studio" ? seed.artist : piece.artist };
}
