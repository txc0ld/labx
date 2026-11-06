import { describe, expect, it } from "vitest";
import { zeroAddress, zeroHash } from "viem";
import { prizeStatus } from "../components/workflow/format";
import type { RaffleSnapshot } from "../lib/chain/types";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { fixtureTrust } from "./fixtures/deployment";

const NOW = 1_800_000_000n;

/** A raffle at `phase`. `listed` records that it was listed, which needs the prize locked first. */
function snapshot(phase: number, escrowed: boolean, listed = phase >= 1): RaffleSnapshot {
  return {
    id: 3n,
    block: { number: 50n, hash: zeroHash, timestamp: NOW },
    raffle: {
      seller: zeroAddress, nft: zeroAddress, tokenId: 7n, salesEnd: NOW - 3_600n, createdAt: 1n, drawnAt: 0n, vrfRequestedAt: 0n, phase,
      escrowed, snapshotted: false, revealed: false, reserveNonce: zeroHash, reserveCommit: zeroHash, publicHash: zeroHash,
      lotCursor: 0n, snapshotTotal: 0n, principalEscrow: 0n, feeEscrow: 0n, vrfRequestId: 0n, randomWord: 0n, winner: zeroAddress,
      packCount: 0, title: "Night garden"
    },
    packs: [],
    policy: { ...fixtureTrust.expectedPolicy, termsHash: PUBLISHED_TERMS_HASH },
    admission: { status: listed ? "opened" : "not-opened", reviewHash: null, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: zeroAddress, approvedAtOpening: listed } },
    accounting: { grossPrincipal: 0n, buyerFees: 0n },
    lotCount: 0n, paused: false, owner: zeroAddress, ethEnabled: false,
    drawStartGrace: 0n, randomnessGrace: 0n, revealGrace: 0n
  };
}

describe("raffle header prize status", () => {
  it("says the prize was claimed once the winner claims it from a finished raffle", () => {
    expect(prizeStatus(snapshot(5, false))).toEqual({ status: "Prize claimed", detail: "Claimed by the winner" });
  });

  it("says the prize went back to the seller once they reclaim it from a cancelled raffle", () => {
    expect(prizeStatus(snapshot(6, false))).toEqual({ status: "Prize returned to the seller", detail: "Returned to the seller" });
  });

  it("does not promise a lock for a cancelled draft that holds no prize", () => {
    expect(prizeStatus(snapshot(6, false, false))).toEqual({ status: "Prize not locked", detail: "Not locked" });
  });

  it("keeps the locked and not-yet-locked wording while the prize is in the contract or still to be locked", () => {
    for (const phase of [0, 1, 2, 3, 4, 5, 6]) expect(prizeStatus(snapshot(phase, true)).status).toBe("Prize locked");
    expect(prizeStatus(snapshot(0, false))).toEqual({ status: "Prize not locked yet", detail: "Not locked yet" });
  });
});
