import { describe, expect, it } from "vitest";
import { pieceView, closingDate } from "../lib/piece-view";
import type { Piece } from "../lib/seed";
import { PIECE_FIXTURE } from "./fixtures/pieces";

const deadline = Date.parse("2027-06-01T00:00:00.000Z");
const piece: Piece = { ...PIECE_FIXTURE, salesEnd: new Date(deadline).toISOString() };

describe("piece availability", () => {
  it("closes at the exact sales deadline even if the stored phase remains open", () => {
    expect(pieceView(piece, deadline - 1).isOpen).toBe(true);
    expect(pieceView(piece, deadline).isOpen).toBe(false);
    expect(pieceView(piece, deadline).status).toBe("Sales ended");
    expect(pieceView(piece, deadline + 1).isEnded).toBe(true);
  });
  it("fails closed for an unavailable schedule", () => {
    const view = pieceView({ ...piece, salesEnd: "not-a-date" }, deadline - 1000);
    expect(view.isOpen).toBe(false);
    expect(view.status).toBe("Schedule unavailable");
    expect(closingDate("not-a-date")).toBe("Not scheduled");
  });
  it("keeps drafts and closed phases out of the open filter", () => {
    expect(pieceView({ ...piece, phase: "draft" }, deadline - 1000).isOpen).toBe(false);
    expect(pieceView({ ...piece, phase: "closed" }, deadline - 1000).isEnded).toBe(true);
    expect(pieceView({ ...piece, phase: "draft" }, deadline + 1000).isEnded).toBe(false);
    expect(pieceView({ ...piece, escrowed: false }, deadline - 1000).status).toBe("Awaiting escrow");
  });
  it("does not offer an open console without any available packs", () => {
    expect(pieceView({ ...piece, packs: [] }, deadline - 1000).isOpen).toBe(false);
    const soldOut = { ...piece, packs: piece.packs.map(pack => ({ ...pack, remaining: 0 })) };
    expect(pieceView(soldOut, deadline - 1000).status).toBe("Packs unavailable");
  });
  it("reports remaining time without negative or fabricated activity figures", () => {
    expect(pieceView(piece, deadline - 60000).timing).toBe("1m left");
    expect(pieceView(piece, deadline).timing).toBe("Sales deadline passed");
    expect(closingDate(piece.salesEnd)).toBe("1 June 2027");
  });
});
