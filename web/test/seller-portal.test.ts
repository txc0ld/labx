import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, zeroAddress, zeroHash, type Address } from "viem";
import { cancelGuidance, cancelReclaimsPrize, parseSellerRaffleId, sellerNextStep, sellerPortalActions, sellerOwnsRaffle, sellerSecondaryActions, sellerStepText } from "../lib/chain/seller-actions";
import { drawRunnerEnabled } from "../lib/draw-runner/enabled";
import { catalogAvailability, fromPriceLabel } from "../components/workflow/format";
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
  const open = { kind: "open", enabled: true, label: "List", reason: "" } as const;
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
    expect(actions.find(item => item.kind === "claimProceeds")).toMatchObject({ enabled: false, reason: "Only the seller can claim the sales." });
    expect(sellerNextStep(value, actions)).toEqual({ kind: "waiting", title: "Raffle complete", message: "Your sales have been paid to your wallet." });
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
    expect(sellerNextStep(value, actions)).toEqual({ kind: "action", action: actions.find(item => item.kind === "cancel"), message: "No entries were counted. Enable refunds so buyers get their membership price back." });
    expect(sellerNextStep(value, actions.filter(item => item.kind !== "cancel"))).toEqual({ kind: "waiting", title: "Draw cannot start", message: "No entries were counted." });
  });
  it.each([1, 2])("offers one Cancel and get NFT back click, then NFT reclaim, for an expired phase %i raffle without memberships", phase => {
    const value = snapshot({ id: 1n, phase });
    value.block.timestamp = value.raffle.salesEnd;
    const actions = currentSellerActions(value);
    const cancelRaffle = actions.find(item => item.kind === "cancel");
    expect(cancelRaffle).toMatchObject({ enabled: true, label: "Cancel raffle" });
    expect(cancelReclaimsPrize(value)).toBe(true);
    const next = sellerNextStep(value, actions);
    expect(next).toEqual({ kind: "action", action: { ...cancelRaffle, label: "Cancel and get NFT back" }, message: "No memberships were sold. Cancel the raffle and get your NFT back. Your wallet asks you to confirm twice." });
    expect(sellerNextStep(value, actions, true)).toEqual(next);
    expect(sellerSecondaryActions(value, actions, next)).toEqual([]);
    const cancelled = snapshot({ id: 1n, phase: 6 });
    cancelled.block.timestamp = value.block.timestamp;
    const after = currentSellerActions(cancelled);
    expect(sellerNextStep(cancelled, after)).toEqual({ kind: "action", action: after.find(item => item.kind === "reclaimPrize"), message: "The raffle is cancelled. Reclaim your NFT." });
  });
  it("keeps Enable refunds without an NFT reclaim when memberships were sold, and Cancel raffle before the deadline", () => {
    const sold = snapshot({ id: 1n, phase: 1 });
    sold.lotCount = 2n;
    sold.block.timestamp = sold.raffle.salesEnd + sold.drawStartGrace;
    expect(cancelReclaimsPrize(sold)).toBe(false);
    expect(sellerNextStep(sold, currentSellerActions(sold))).toMatchObject({ kind: "action", action: { kind: "cancel", label: "Enable refunds" }, message: "The draw didn’t start in time. Enable refunds so buyers get their membership price back." });
    const early = snapshot({ id: 1n, phase: 1 });
    expect(cancelReclaimsPrize(early)).toBe(false);
    const actions = currentSellerActions(early);
    expect(sellerSecondaryActions(early, actions, sellerNextStep(early, actions)).find(item => item.kind === "cancel")).toMatchObject({ label: "Cancel raffle" });
  });
  it("tells other wallets that only the seller reclaims the NFT", () => {
    const value = snapshot({ id: 1n, phase: 1 });
    expect(cancelGuidance(value, "No memberships were sold.")).toBe("No memberships were sold. Cancel the raffle, then reclaim your NFT.");
    expect(cancelGuidance(value, "No memberships were sold.", false)).toBe("No memberships were sold. Cancel the raffle so the seller can reclaim the NFT.");
    value.lotCount = 1n;
    expect(cancelGuidance(value, "The draw didn’t start in time.", false)).toBe("The draw didn’t start in time. Enable refunds so buyers get their membership price back.");
  });
  it("labels seller cancellation by whether buyers have refunds to claim", () => {
    const value = snapshot({ id: 1n, phase: 1 });
    const actions = currentSellerActions(value);
    expect(actions.find(item => item.kind === "cancel")).toMatchObject({ enabled: true, label: "Cancel raffle" });
    const next = sellerNextStep(value, actions);
    expect(next).toMatchObject({ kind: "waiting", title: "Your raffle is live" });
    // Confirm the draw waits for a drawn winner, so a live raffle offers only cancellation.
    expect(sellerSecondaryActions(value, actions, next).map(item => item.kind)).toEqual(["cancel"]);
    value.lotCount = 1n;
    expect(currentSellerActions(value).find(item => item.kind === "cancel")).toMatchObject({ enabled: false, label: "Enable refunds" });
  });
  it("keeps Confirm the draw out of Advanced until a winner is drawn", () => {
    const value = snapshot({ id: 1n, phase: 1 });
    value.lotCount = 1n;
    value.block.timestamp = value.raffle.salesEnd;
    const actions = currentSellerActions(value);
    const next = sellerNextStep(value, actions);
    expect(next).toMatchObject({ kind: "action", action: { kind: "close", enabled: true } });
    expect(actions.find(item => item.kind === "reveal")).toMatchObject({ enabled: true });
    expect(sellerSecondaryActions(value, actions, next)).toEqual([]);
    for (const phase of [2, 3]) {
      const early = { ...value, raffle: { ...value.raffle, phase } };
      const earlyActions = currentSellerActions(early);
      expect(sellerSecondaryActions(early, earlyActions, sellerNextStep(early, earlyActions)).map(item => item.kind)).not.toContain("reveal");
    }
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
    expect(next).toEqual({ kind: "action", action: actions.find(item => item.kind === "cancel"), message: "The draw didn’t start in time. Enable refunds so buyers get their membership price back." });
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
    expect(sellerNextStep(value, beforeTimeout)).toEqual({ kind: "waiting", title: "Drawing a winner", message: "This usually takes a few minutes. This page updates on its own." });
    value.block.timestamp += 1n;
    const atTimeout = currentSellerActions(value);
    expect(atTimeout.find(item => item.kind === "abortDrawing")).toMatchObject({ enabled: true, label: "Enable refunds" });
    expect(sellerNextStep(value, atTimeout)).toEqual({ kind: "action", action: atTimeout.find(item => item.kind === "abortDrawing"), message: "The draw didn’t return a result in time. Enable refunds so buyers get their membership price back." });
  });
  it.each([
    { lots: 0n, principal: 0n, message: "No memberships were sold." },
    { lots: 1n, principal: 1_000_000n, message: "Buyers can claim refunds of the membership price." }
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
    expect(sellerNextStep(value, actions)).toEqual({ kind: "action", action: actions.find(item => item.kind === "reclaimPrize"), message: "The raffle is cancelled. Reclaim your NFT. Buyers can claim refunds of the membership price." });
    expect(sellerNextStep(value, actions.map(item => ({ ...item, enabled: false })))).toEqual({ kind: "waiting", title: "Raffle cancelled", message: "Buyers can claim refunds of the membership price." });
    value.raffle.escrowed = false;
    expect(sellerNextStep(value, currentSellerActions(value))).toEqual({ kind: "waiting", title: "Raffle cancelled", message: "Buyers can claim refunds of the membership price." });
  });
  it.each(["pending", "changed"] as const)("keeps cancellation secondary for an escrowed %s draft", status => {
    expect(sellerNextStep(draft(status), [cancel])).toMatchObject({ kind: "waiting", title: "Waiting for LABx review" });
  });
  it("uses eligible approval and escrow before opening", () => {
    const value = draft("pending");
    value.raffle.escrowed = false;
    const approve = { kind: "approvePrize", enabled: true, label: "Approve NFT", reason: "" } as const;
    const escrow = { kind: "escrow", enabled: true, label: "Lock NFT", reason: "" } as const;
    expect(sellerNextStep(value, [cancel, approve])).toEqual({ kind: "action", action: approve });
    expect(sellerNextStep(value, [cancel, { ...approve, enabled: false }, escrow])).toEqual({ kind: "action", action: escrow });
  });
  it("requires current approval, eligibility, an unpaused state and a future deadline to open", () => {
    const value = draft("approved");
    expect(sellerNextStep(value, [cancel, open])).toEqual({ kind: "action", action: open });
    expect(sellerNextStep(value, [cancel, { ...open, enabled: false, reason: "Owner trust changed" }])).toMatchObject({ kind: "waiting", message: "Owner trust changed" });
    expect(sellerNextStep({ ...value, paused: true }, [cancel, open])).toMatchObject({ kind: "waiting", title: "Listing paused" });
    expect(sellerNextStep({ ...value, block: { ...value.block, timestamp: value.raffle.salesEnd } }, [cancel, open])).toMatchObject({ kind: "waiting", title: "Sales deadline passed" });
  });
  it("does not promote refund or reveal controls while waiting for the deadline or randomness", () => {
    const actions = [cancel, { kind: "abortDrawing", enabled: true, label: "Enable refunds", reason: "" }, { kind: "reveal", enabled: true, label: "Confirm the draw", reason: "" }] as const;
    expect(sellerNextStep(snapshot({ id: 1n, phase: 1 }), actions)).toMatchObject({ kind: "waiting", title: "Your raffle is live" });
    const drawing = snapshot({ id: 1n, phase: 3 });
    drawing.raffle.vrfRequestedAt = drawing.block.timestamp;
    expect(sellerNextStep(drawing, actions)).toMatchObject({ kind: "waiting", title: "Drawing a winner" });
    expect(sellerNextStep(snapshot({ id: 1n, phase: 6 }), actions)).toMatchObject({ kind: "waiting", title: "Raffle cancelled" });
  });
});

describe("seller next step with the draw runner", () => {
  const DRAW = "LABx closes sales and starts the draw automatically. This usually takes a few minutes.";
  const SETTLE = "LABx finishes the raffle automatically after you confirm the draw.";
  function currentSellerActions(value: RaffleSnapshot) {
    return sellerPortalActions(availableActions(value, {
      account: SELLER, snapshot: value, principal: 0n, fee: 0n,
      usdcBalance: 0n, usdcAllowance: 0n, nftOwner: null, nftApproved: false
    }));
  }
  function sold(phase: number) {
    const value = snapshot({ id: 1n, phase });
    value.lotCount = 1n;
    value.block.timestamp = value.raffle.salesEnd;
    return value;
  }
  function drawn(revealed: boolean) {
    const value = snapshot({ id: 1n, phase: 4 });
    value.lotCount = 1n;
    value.raffle.revealed = revealed;
    value.raffle.drawnAt = value.block.timestamp;
    return value;
  }
  const counted = () => { const value = sold(2); value.raffle.snapshotted = true; value.raffle.snapshotTotal = 3n; return value; };

  it.each([
    { name: "close", value: () => sold(1), kind: "close", title: "Sales ended", message: DRAW },
    { name: "count", value: () => sold(2), kind: "snapshot", title: "Sales closed", message: DRAW },
    { name: "start", value: counted, kind: "requestRandomness", title: "Entries counted", message: DRAW },
    { name: "finish", value: () => drawn(true), kind: "settle", title: "Draw confirmed", message: SETTLE }
  ])("leaves the $name step to LABx and keeps it as a fallback", ({ value, kind, title, message }) => {
    const raffle = value();
    const actions = currentSellerActions(raffle);
    const manual = sellerNextStep(raffle, actions);
    expect(manual).toMatchObject({ kind: "action", action: { kind, enabled: true } });
    expect(sellerNextStep(raffle, actions, false)).toEqual(manual);
    const automatic = sellerNextStep(raffle, actions, true);
    expect(automatic).toEqual({ kind: "automatic", action: actions.find(item => item.kind === kind), title, message });
    // The fallback lives in Run it yourself, so Advanced does not repeat it.
    expect(sellerSecondaryActions(raffle, actions, automatic).map(item => item.kind)).not.toContain(kind);
  });

  it("finishes an unconfirmed draw after the reveal window without asking the seller to finish it", () => {
    const value = drawn(false);
    value.block.timestamp = value.raffle.drawnAt + value.revealGrace;
    const actions = currentSellerActions(value);
    expect(sellerNextStep(value, actions, true)).toMatchObject({ kind: "automatic", action: { kind: "settle" }, title: "Winner drawn", message: SETTLE });
    expect(sellerSecondaryActions(value, actions, sellerNextStep(value, actions, true)).map(item => item.kind)).toEqual(["reveal"]);
  });

  it("keeps confirming the draw, claims, cancellation, refunds and reclaim with the seller", () => {
    const reveal = drawn(false);
    expect(sellerNextStep(reveal, currentSellerActions(reveal), true)).toMatchObject({ kind: "action", action: { kind: "reveal", label: "Confirm the draw" } });
    const paid = snapshot({ id: 1n, phase: 5, principalEscrow: 1_000_000n });
    expect(sellerNextStep(paid, currentSellerActions(paid), true)).toMatchObject({ kind: "action", action: { kind: "claimProceeds" } });
    const empty = snapshot({ id: 1n, phase: 1 });
    empty.block.timestamp = empty.raffle.salesEnd;
    expect(sellerNextStep(empty, currentSellerActions(empty), true)).toMatchObject({ kind: "action", action: { kind: "cancel", label: "Cancel and get NFT back" } });
    const late = sold(2);
    late.block.timestamp = late.raffle.salesEnd + late.drawStartGrace;
    expect(sellerNextStep(late, currentSellerActions(late), true)).toMatchObject({ kind: "action", action: { kind: "cancel", label: "Enable refunds" } });
    const stuck = sold(3);
    stuck.raffle.vrfRequestedAt = stuck.raffle.salesEnd;
    stuck.block.timestamp = stuck.raffle.vrfRequestedAt + stuck.randomnessGrace;
    expect(sellerNextStep(stuck, currentSellerActions(stuck), true)).toMatchObject({ kind: "action", action: { kind: "abortDrawing" } });
    const cancelled = snapshot({ id: 1n, phase: 6 });
    expect(sellerNextStep(cancelled, currentSellerActions(cancelled), true)).toMatchObject({ kind: "action", action: { kind: "reclaimPrize" } });
  });

  const LATE = "LABx hasn’t run this step yet. You can run it yourself.";

  it.each([
    { name: "close", value: () => sold(1), kind: "close", due: (value: RaffleSnapshot) => value.raffle.salesEnd },
    { name: "count", value: () => sold(2), kind: "snapshot", due: (value: RaffleSnapshot) => value.raffle.salesEnd },
    { name: "start", value: counted, kind: "requestRandomness", due: (value: RaffleSnapshot) => value.raffle.salesEnd },
    { name: "finish", value: () => drawn(true), kind: "settle", due: (value: RaffleSnapshot) => value.raffle.drawnAt }
  ])("gives the $name step back to the seller once it is 30 minutes overdue by block time", ({ value, kind, due }) => {
    const raffle = value();
    raffle.block.timestamp = due(raffle) + 1_799n;
    expect(sellerNextStep(raffle, currentSellerActions(raffle), true)).toMatchObject({ kind: "automatic", action: { kind } });
    raffle.block.timestamp = due(raffle) + 1_800n;
    const actions = currentSellerActions(raffle);
    const late = sellerNextStep(raffle, actions, true);
    expect(late).toEqual({ kind: "action", action: actions.find(item => item.kind === kind), message: LATE });
    expect(sellerSecondaryActions(raffle, actions, late).map(item => item.kind)).not.toContain(kind);
    // Without the runner the same step is the plain manual step.
    expect(sellerNextStep(raffle, actions, false)).toEqual({ kind: "action", action: actions.find(item => item.kind === kind) });
  });

  it("times an unconfirmed draw's finish from the end of the confirmation window", () => {
    const value = drawn(false);
    value.block.timestamp = value.raffle.drawnAt + value.revealGrace + 1_799n;
    expect(sellerNextStep(value, currentSellerActions(value), true)).toMatchObject({ kind: "automatic", action: { kind: "settle" }, title: "Winner drawn" });
    value.block.timestamp = value.raffle.drawnAt + value.revealGrace + 1_800n;
    expect(sellerNextStep(value, currentSellerActions(value), true)).toMatchObject({ kind: "action", action: { kind: "settle" }, message: LATE });
  });

  it("leaves waiting states unchanged", () => {
    const live = snapshot({ id: 1n, phase: 1 });
    expect(sellerNextStep(live, currentSellerActions(live), true)).toEqual(sellerNextStep(live, currentSellerActions(live)));
    const drawing = sold(3);
    drawing.raffle.vrfRequestedAt = drawing.block.timestamp;
    expect(sellerNextStep(drawing, currentSellerActions(drawing), true)).toEqual({ kind: "waiting", title: "Drawing a winner", message: "This usually takes a few minutes. This page updates on its own." });
  });
});

describe("draw runner flag", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("is on only for exactly 1", () => {
    expect(drawRunnerEnabled("1")).toBe(true);
    for (const value of [undefined, "", "0", "true", "on", " 1", "1 "]) expect(drawRunnerEnabled(value)).toBe(false);
  });

  it("reads NEXT_PUBLIC_LABX_DRAW_RUNNER and is off when it is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_LABX_DRAW_RUNNER", undefined);
    expect(drawRunnerEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_LABX_DRAW_RUNNER", "1");
    expect(drawRunnerEnabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_LABX_DRAW_RUNNER", "0");
    expect(drawRunnerEnabled()).toBe(false);
  });
});

describe("raffle page wording", () => {
  const pack = (name: string, priceUsdc: bigint, sold = 0) => ({ name, priceUsdc, bonusEntries: 1, maxSupply: 10, sold, active: true });

  it("prices the cheapest available membership with its processing fee, as the catalog and raffle page show it", () => {
    const value = { ...snapshot({ id: 1n }), packs: [pack("Entry", 10_000_000n, 10), pack("Bronze", 25_000_000n), pack("Gold", 200_000_000n)] };
    expect(fromPriceLabel(value)).toBe("From 27.50 USDC incl. fee");
    expect(fromPriceLabel({ ...value, packs: [pack("Gold", 200_000_000n)] })).toBe("From 204.00 USDC incl. fee");
    expect(fromPriceLabel({ ...value, packs: [pack("Entry", 10_000_000n, 10)] })).toBeNull();
  });

  it("shows an approved draft as Approved and other drafts as Draft", () => {
    const pending = snapshot({ id: 1n, phase: 0 });
    expect(catalogAvailability(pending).label).toBe("Draft");
    expect(catalogAvailability({ ...pending, admission: { ...pending.admission, status: "approved", reviewHash: zeroHash } }).label).toBe("Approved");
  });

  it("describes each seller step in plain words and keeps the refund rule for cancellations with sales", () => {
    const open = snapshot({ id: 1n, phase: 1 });
    expect(sellerStepText(open, "close")).toBe("Sales have ended. Close sales so entries can be counted.");
    expect(sellerStepText(open, "snapshot")).toBe("Locks in every purchase for the draw.");
    expect(sellerStepText(open, "settle")).toBe("Finishes the raffle so you can claim your sales and the winner can claim the NFT.");
    expect(sellerStepText(open, "reveal")).toBe("Sign to load your saved draw setup, then confirm it. This lets you finish now instead of waiting 7 days.");
    expect(sellerStepText(open, "cancel")).toBe("Ends sales now. You can then reclaim your NFT.");
    expect(sellerStepText({ ...open, lotCount: 2n }, "cancel")).toBe("Enable refunds so buyers get their membership price back.");
    expect(sellerStepText(snapshot({ id: 1n, phase: 0 }), "cancel")).toBe("Cancels this draft. You can then reclaim your NFT.");
    expect(sellerStepText(open, "updateDraft")).toBe("");
  });
});
