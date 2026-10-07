import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, zeroAddress, zeroHash, type Address } from "viem";
import { parseSellerRaffleId, sellerPortalActions, sellerOwnsRaffle } from "../lib/chain/seller-actions";
import { scanSellerPortfolio, sellerPortfolioTotals } from "../lib/chain/seller-portfolio";
import { mergeSellerActivityPage, type SellerRaffleActivity } from "../lib/chain/seller-types";
import type { ActionAvailability, ActionKind, RaffleSnapshot } from "../lib/chain/types";

const SELLER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function refundActivity(blockNumber: bigint): SellerRaffleActivity {
  return {
    eventName: "Refunded",
    args: { id: 1n, buyer: SELLER, amount: blockNumber },
    transactionHash: keccak256(toBytes(`refund-${blockNumber}`)),
    logIndex: Number(blockNumber),
    blockNumber
  };
}

function snapshot(input: {
  id: bigint;
  seller?: Address;
  phase?: number;
  grossPrincipal?: bigint;
  buyerFees?: bigint;
  principalEscrow?: bigint;
  feeEscrow?: bigint;
}): RaffleSnapshot {
  return {
    id: input.id,
    block: { number: 50n, hash: zeroHash, timestamp: 1_800_000_000n },
    raffle: {
      seller: input.seller ?? SELLER,
      nft: OTHER,
      tokenId: input.id,
      salesEnd: 1_800_000_100n,
      createdAt: 1n,
      drawnAt: 0n,
      vrfRequestedAt: 0n,
      phase: input.phase ?? 1,
      escrowed: true,
      snapshotted: false,
      revealed: false,
      reserveNonce: zeroHash,
      reserveCommit: zeroHash,
      publicHash: zeroHash,
      lotCursor: 0n,
      snapshotTotal: 0n,
      principalEscrow: input.principalEscrow ?? 0n,
      feeEscrow: input.feeEscrow ?? 0n,
      vrfRequestId: 0n,
      randomWord: 0n,
      winner: zeroAddress,
      packCount: 1,
      title: `Raffle ${input.id}`
    },
    packs: [],
    policy: {
      treasury: zeroAddress,
      termsHash: zeroHash,
      coordinator: zeroAddress,
      keyHash: zeroHash,
      subscriptionId: 1n,
      callbackGasLimit: 500_000,
      requestConfirmations: 3,
      nativePayment: true,
      buyerFeeBps: 200,
      sellerFeeBps: 200
    },
    accounting: {
      grossPrincipal: input.grossPrincipal ?? 0n,
      buyerFees: input.buyerFees ?? 0n
    },
    lotCount: 0n,
    paused: false,
    owner: OTHER,
    ethEnabled: false,
    drawStartGrace: 604_800n,
    randomnessGrace: 604_800n,
    revealGrace: 604_800n
  };
}

describe("seller portfolio state", () => {
  it("keeps earlier activity after a later-page error is retried to completion", () => {
    const first = refundActivity(10n);
    const retried = refundActivity(20n);

    expect(mergeSellerActivityPage("error", [first], [retried], 11n)).toEqual([first, retried]);
  });

  it("keeps earlier activity through repeated errors and an empty final page", () => {
    const first = refundActivity(10n);
    const afterFirstFailure = mergeSellerActivityPage("error", [first], [], 11n);
    const afterRepeatedFailure = mergeSellerActivityPage("error", afterFirstFailure, [], 11n);

    expect(afterFirstFailure).toEqual([first]);
    expect(afterRepeatedFailure).toEqual([first]);
  });

  it("scans every pinned page before returning complete totals", async () => {
    const first = snapshot({ id: 1n, grossPrincipal: 25_000_000n, principalEscrow: 25_000_000n });
    const later = snapshot({ id: 3n, phase: 5, grossPrincipal: 50_000_000n, buyerFees: 1_000_000n, principalEscrow: 49_000_000n, feeEscrow: 2_000_000n });
    const listSellerRaffles = vi.fn()
      .mockResolvedValueOnce({ items: [first], nextCursor: 3n, block: first.block })
      .mockResolvedValueOnce({ items: [later], nextCursor: null, block: first.block });
    const progress: number[] = [];

    const result = await scanSellerPortfolio({
      service: { listSellerRaffles },
      seller: SELLER,
      isCurrent: () => true,
      onProgress: (items) => progress.push(items.length)
    });

    expect(result).toMatchObject({ kind: "complete", raffles: [first, later], block: first.block });
    expect(progress).toEqual([1, 2]);
    expect(listSellerRaffles).toHaveBeenNthCalledWith(2, {
      seller: SELLER,
      cursor: 3n,
      limit: 24,
      block: first.block
    });
    if (result.kind !== "complete") throw new Error("Expected a complete portfolio scan.");
    expect(sellerPortfolioTotals(result.raffles)).toMatchObject({
      grossPrincipal: 75_000_000n,
      earnedNetProceeds: 49_000_000n,
      claimableProceeds: 49_000_000n,
      pendingPrincipal: 25_000_000n
    });
  });

  it("retains partial results without presenting them as complete after a later-page failure", async () => {
    const first = snapshot({ id: 1n });
    const result = await scanSellerPortfolio({
      service: {
        listSellerRaffles: vi.fn()
          .mockResolvedValueOnce({ items: [first], nextCursor: 2n, block: first.block })
          .mockRejectedValueOnce(new Error("RPC unavailable"))
      },
      seller: SELLER,
      isCurrent: () => true
    });

    expect(result).toEqual({
      kind: "incomplete",
      raffles: [first],
      block: first.block,
      message: "RPC unavailable"
    });
  });

  it("rejects a later page from a replaced block and keeps only prior pinned results", async () => {
    const first = snapshot({ id: 1n });
    const replaced = snapshot({ id: 2n });
    const replacementBlock = { ...replaced.block, hash: keccak256(toBytes("replacement block")) };
    const result = await scanSellerPortfolio({
      service: {
        listSellerRaffles: vi.fn()
          .mockResolvedValueOnce({ items: [first], nextCursor: 2n, block: first.block })
          .mockResolvedValueOnce({ items: [replaced], nextCursor: null, block: replacementBlock })
      },
      seller: SELLER,
      isCurrent: () => true
    });

    expect(result).toEqual({
      kind: "incomplete",
      raffles: [first],
      block: first.block,
      message: "Chain state changed during the seller scan."
    });
  });

  it("discards delayed pages after a wallet or chain revision invalidates the request", async () => {
    let resolvePage: ((page: { items: readonly RaffleSnapshot[]; nextCursor: null; block: RaffleSnapshot["block"] }) => void) | undefined;
    let current = true;
    const page = new Promise<{ items: readonly RaffleSnapshot[]; nextCursor: null; block: RaffleSnapshot["block"] }>((resolve) => { resolvePage = resolve; });
    const late = snapshot({ id: 9n });
    const progress = vi.fn();
    const pending = scanSellerPortfolio({
      service: { listSellerRaffles: vi.fn().mockReturnValue(page) },
      seller: SELLER,
      isCurrent: () => current,
      onProgress: progress
    });

    current = false;
    resolvePage?.({ items: [late], nextCursor: null, block: late.block });

    await expect(pending).resolves.toEqual({ kind: "stale" });
    expect(progress).not.toHaveBeenCalled();
  });
});

describe("seller-only action and ownership boundaries", () => {
  it("rejects malformed and uint256-overflowing direct-route IDs", () => {
    expect(parseSellerRaffleId("1")).toBe(1n);
    expect(parseSellerRaffleId((2n ** 256n - 1n).toString())).toBe(2n ** 256n - 1n);
    expect(parseSellerRaffleId((2n ** 256n).toString())).toBeNull();
    expect(parseSellerRaffleId("0")).toBeNull();
    expect(parseSellerRaffleId("01")).toBeNull();
    expect(parseSellerRaffleId("1e3")).toBeNull();
  });

  it("does not expose buyer, winner, refund or treasury controls", () => {
    const kinds: readonly ActionKind[] = [
      "updateDraft", "approvePrize", "escrow", "open", "close", "snapshot", "requestRandomness", "reveal",
      "settle", "claimProceeds", "cancel", "abortDrawing", "reclaimPrize", "approveUsdc", "buyMembership",
      "claimPrize", "claimFee", "refund"
    ];
    const actions: readonly ActionAvailability[] = kinds.map((kind) => ({ kind, label: kind, enabled: true, reason: "" }));

    expect(sellerPortalActions(actions)).toEqual([
      "updateDraft", "approvePrize", "escrow", "open", "close", "snapshot", "requestRandomness", "reveal",
      "settle", "claimProceeds", "cancel", "abortDrawing", "reclaimPrize"
    ].map((kind) => ({ kind, label: kind, enabled: true, reason: "" })));
  });

  it("accepts only the live raffle seller, regardless of operator or winner roles", () => {
    const raffle = snapshot({ id: 1n });
    expect(sellerOwnsRaffle(SELLER, raffle)).toBe(true);
    expect(sellerOwnsRaffle(OTHER, raffle)).toBe(false);
  });
});
