import type { Piece } from "../../lib/seed";

export const PIECE_FIXTURE: Piece = {
  id: "fixture-piece",
  title: "Fixture Piece",
  artist: "Test Artist",
  mark: "junction",
  image: "/artwork/argonaut-7297.png",
  imageAlt: "Test artwork",
  phase: "open",
  escrowed: true,
  salesEnd: "2027-06-01T00:00:00.000Z",
  packs: [
    { name: "Entry", priceUsdc: 25, bonusEntries: 1, remaining: 10, supply: 10 }
  ],
  nft: "0x0000000000000000000000000000000000000001",
  tokenId: "1"
};
