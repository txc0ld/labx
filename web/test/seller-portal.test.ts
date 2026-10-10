import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, zeroAddress, zeroHash, type Address } from "viem";
import { parseSellerRaffleId, sellerNextStep, sellerPortalActions, sellerOwnsRaffle, sellerSecondaryActions } from "../lib/chain/seller-actions";
import { availableActions } from "../lib/chain/workflow";
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
    admission: { status: "opened", reviewHash: null, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: zeroAddress, approvedAtOpening: true } },
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
      sellerFeeBps: 200, minBuyerFeeUsdc: 2_500_000n
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


describe("seller next step", () => {
  const cancel = { kind: "cancel", enabled: true, label: "Cancel draft", reason: "" } as const;
  const open = { kind: "open", enabled: true, label: "Open memberships", reason: "" } as const;
  function draft(status: "pending" | "changed" | "approved") {
    const value = snapshot({ id: 1n, phase: 0 });
    return { ...value, admission: { ...value.admission, status, reviewHash: zeroHash } };
  }
  function currentSellerActions(value: RaffleSnapshot) {
    return sellerPortalActions(availableActions(value, {
      account: SELLER, snapshot: value, principal: 0n, fee: 0n,
      usdcBalance: 0n, usdcAllowance: 0n, nftOwner: null, nftApproved: false
    }));
  }
  it("shows that settled proceeds are exhausted instead of a generic seller-role restriction", () => {
    const value = snapshot({ id: 1n, phase: 5, principalEscrow: 0n });
    const actions = currentSellerActions(value);
    expect(actions.find(item => item.kind === "claimProceeds")).toMatchObject({ enabled: false, reason: "Only the seller can claim remaining membership proceeds." });
    expect(sellerNextStep(value, actions)).toEqual({ kind: "waiting", title: "Raffle settled", message: "There are no seller proceeds left to claim." });
    const funded = snapshot({ id: 1n, phase: 5, principalEscrow: 1n });
    expect(sellerNextStep(funded, currentSellerActions(funded))).toMatchObject({ kind: "action", action: { kind: "claimProceeds", enabled: true } });
  });
  it("promotes refunds for an empty completed snapshot of recorded lots", () => {
    const value = snapshot({ id: 1n, phase: 2 });
    value.raffle.snapshotted = true;
    value.lotCount = 1n;
    value.block.timestamp = value.raffle.salesEnd;
    const actions = currentSellerActions(value);
    expect(actions.find(item => item.kind === "cancel")).toMatchObject({ enabled: true, label: "Enable refunds" });
    expect(sellerNextStep(value, actions)).toEqual({ kind: "action", action: actions.find(item => item.kind === "cancel"), message: "No entries were frozen. Enable refunds so buyers can claim their principal." });
    expect(sellerNextStep(value, actions.filter(item => item.kind !== "cancel"))).toEqual({ kind: "waiting", title: "Draw cannot start", message: "No entries were frozen." });
  });
  it.each([1, 2])("offers cancellation, then NFT reclaim, for an expired phase %i raffle without memberships", phase => {
    const value = snapshot({ id: 1n, phase });
    value.block.timestamp = value.raffle.salesEnd;
    const actions = currentSellerActions(value);
    const cancelRaffle = actions.find(item => item.kind === "cancel");
    expect(cancelRaffle).toMatchObject({ enabled: true, label: "Cancel raffle" });
    const next = sellerNextStep(value, actions);
    expect(next).toEqual({ kind: "action", action: cancelRaffle, message: "No memberships were sold. Cancel the raffle, then reclaim your NFT." });
    expect(sellerSecondaryActions(value, actions, next)).toEqual([]);
    const cancelled = snapshot({ id: 1n, phase: 6 });
    cancelled.block.timestamp = value.block.timestamp;
    const after = currentSellerActions(cancelled);
    expect(sellerNextStep(cancelled, after)).toEqual({ kind: "action", action: after.find(item => item.kind === "reclaimPrize"), message: "The raffle is cancelled. Reclaim your NFT." });
  });
  it("labels seller cancellation by whether buyers have refunds to claim", () => {
    const value = snapshot({ id: 1n, phase: 1 });
    const actions = currentSellerActions(value);
    expect(actions.find(item => item.kind === "cancel")).toMatchObject({ enabled: true, label: "Cancel raffle" });
    const next = sellerNextStep(value, actions);
    expect(next).toMatchObject({ kind: "waiting", title: "Memberships are open" });
    expect(sellerSecondaryActions(value, actions, next).map(item => item.kind)).toEqual(["reveal", "cancel"]);
    value.lotCount = 1n;
    expect(currentSellerActions(value).find(item => item.kind === "cancel")).toMatchObject({ enabled: false, label: "Enable refunds" });
  });
  it("keeps draw controls secondary while a sold raffle can still be drawn", () => {
    const value = snapshot({ id: 1n, phase: 1 });
    value.lotCount = 1n;
    value.block.timestamp = value.raffle.salesEnd;
    const actions = currentSellerActions(value);
    const next = sellerNextStep(value, actions);
    expect(next).toMatchObject({ kind: "action", action: { kind: "close", enabled: true } });
    expect(sellerSecondaryActions(value, actions, next).map(item => item.kind)).toEqual(["reveal"]);
  });
  it.each([true, false])("uses the real draw-start cutoff when snapshot completion is %s", snapshotted => {
    const value = snapshot({ id: 1n, phase: 2 });
    value.raffle.snapshotted = snapshotted;
    value.raffle.snapshotTotal = 3n;
    value.lotCount = 1n;
    value.block.timestamp = value.raffle.salesEnd + value.drawStartGrace - 1n;
    expect(sellerNextStep(value, currentSellerActions(value))).toMatchObject({ kind: "action", action: { kind: snapshotted ? "requestRandomness" : "snapshot", enabled: true } });
    value.block.timestamp += 1n;
    const actions = currentSellerActions(value);
    const next = sellerNextStep(value, actions);
    expect(next).toEqual({ kind: "action", action: actions.find(item => item.kind === "cancel"), message: "The draw-start deadline has passed. Enable refunds so buyers can claim their principal." });
    expect(next).toMatchObject({ action: { label: "Enable refunds" } });
    expect(sellerSecondaryActions(value, actions, next)).toEqual([]);
  });
  it.each([
    { paused: false, reason: "Owner trust changed." },
    { paused: true, reason: "Draw requests are paused." }
  ])("preserves a disabled draw reason without inventing an elapsed cutoff: $reason", ({ paused, reason }) => {
    const value = snapshot({ id: 1n, phase: 2 });
    value.raffle.snapshotted = true;
    value.raffle.snapshotTotal = 3n;
    value.lotCount = 1n;
    value.paused = paused;
    value.block.timestamp = value.raffle.salesEnd;
    expect(sellerNextStep(value, currentSellerActions(value))).toMatchObject({ kind: "action", action: { kind: "requestRandomness", enabled: true } });
    const actions = currentSellerActions(value).map(item => item.kind === "requestRandomness" ? { ...item, enabled: false, reason } : item);
    expect(sellerNextStep(value, actions)).toEqual({ kind: "waiting", title: "Draw not ready", message: reason });
  });
  it("only mentions draw recovery once the actual randomness timeout action is enabled", () => {
    const value = snapshot({ id: 1n, phase: 3 });
    value.raffle.revealed = true;
    value.raffle.vrfRequestedAt = value.raffle.salesEnd;
    value.block.timestamp = value.raffle.vrfRequestedAt + value.randomnessGrace - 1n;
    const beforeTimeout = currentSellerActions(value);
    expect(beforeTimeout.filter(item => item.enabled)).toEqual([]);
    expect(sellerNextStep(value, beforeTimeout)).toEqual({ kind: "waiting", title: "Waiting for the draw", message: "The randomness request is pending. Refresh after fulfillment." });
    value.block.timestamp += 1n;
    const atTimeout = currentSellerActions(value);
    expect(atTimeout.find(item => item.kind === "abortDrawing")).toMatchObject({ enabled: true, label: "Enable refunds" });
    expect(sellerNextStep(value, atTimeout)).toEqual({ kind: "action", action: atTimeout.find(item => item.kind === "abortDrawing"), message: "The randomness deadline passed without a result. Enable refunds so buyers can claim their principal." });
  });
  it.each([
    { lots: 0n, principal: 0n, message: "No memberships were purchased." },
    { lots: 1n, principal: 1_000_000n, message: "Buyers can claim any remaining refundable principal." }
  ])("describes cancelled raffle purchases accurately with $lots recorded lots", ({ lots, principal, message }) => {
    const value = snapshot({ id: 1n, phase: 6, principalEscrow: principal });
    value.raffle.escrowed = false;
    value.lotCount = lots;
    expect(sellerNextStep(value, currentSellerActions(value))).toEqual({ kind: "waiting", title: "Raffle cancelled", message });
  });
  it("only points cancelled raffles to NFT recovery when that control exists", () => {
    const value = snapshot({ id: 1n, phase: 6 });
    value.lotCount = 1n;
    const actions = currentSellerActions(value);
    expect(sellerNextStep(value, actions)).toEqual({ kind: "action", action: actions.find(item => item.kind === "reclaimPrize"), message: "The raffle is cancelled. Reclaim your NFT. Buyers can claim any remaining refundable principal." });
    expect(sellerNextStep(value, actions.map(item => ({ ...item, enabled: false })))).toEqual({ kind: "waiting", title: "Raffle cancelled", message: "Buyers can claim any remaining refundable principal." });
    value.raffle.escrowed = false;
    expect(sellerNextStep(value, currentSellerActions(value))).toEqual({ kind: "waiting", title: "Raffle cancelled", message: "Buyers can claim any remaining refundable principal." });
  });
  it.each(["pending", "changed"] as const)("keeps cancellation secondary for an escrowed %s draft", status => {
    expect(sellerNextStep(draft(status), [cancel])).toMatchObject({ kind: "waiting", title: "Awaiting LABx review" });
  });
  it("uses eligible approval and escrow before opening", () => {
    const value = draft("pending");
    value.raffle.escrowed = false;
    const approve = { kind: "approvePrize", enabled: true, label: "Approve NFT", reason: "" } as const;
    const escrow = { kind: "escrow", enabled: true, label: "Escrow NFT", reason: "" } as const;
    expect(sellerNextStep(value, [cancel, approve])).toEqual({ kind: "action", action: approve });
    expect(sellerNextStep(value, [cancel, { ...approve, enabled: false }, escrow])).toEqual({ kind: "action", action: escrow });
  });
  it("requires current approval, eligibility, an unpaused state and a future deadline to open", () => {
    const value = draft("approved");
    expect(sellerNextStep(value, [cancel, open])).toEqual({ kind: "action", action: open });
    expect(sellerNextStep(value, [cancel, { ...open, enabled: false, reason: "Owner trust changed" }])).toMatchObject({ kind: "waiting", message: "Owner trust changed" });
    expect(sellerNextStep({ ...value, paused: true }, [cancel, open])).toMatchObject({ kind: "waiting", title: "Opening paused" });
    expect(sellerNextStep({ ...value, block: { ...value.block, timestamp: value.raffle.salesEnd } }, [cancel, open])).toMatchObject({ kind: "waiting", title: "Sales deadline passed" });
  });
  it("does not promote refund or reveal controls while waiting for the deadline or randomness", () => {
    const actions = [cancel, { kind: "abortDrawing", enabled: true, label: "Enable refunds", reason: "" }, { kind: "reveal", enabled: true, label: "Reveal commitment", reason: "" }] as const;
    expect(sellerNextStep(snapshot({ id: 1n, phase: 1 }), actions)).toMatchObject({ kind: "waiting", title: "Memberships are open" });
    const drawing = snapshot({ id: 1n, phase: 3 });
    drawing.raffle.vrfRequestedAt = drawing.block.timestamp;
    expect(sellerNextStep(drawing, actions)).toMatchObject({ kind: "waiting", title: "Waiting for the draw" });
    expect(sellerNextStep(snapshot({ id: 1n, phase: 6 }), actions)).toMatchObject({ kind: "waiting", title: "Raffle cancelled" });
  });
});
