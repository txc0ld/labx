import { describe, expect, it } from "vitest";
import { zeroAddress, zeroHash } from "viem";
import { availableActions } from "../lib/chain/workflow";
import type { AccountRaffleState, RaffleSnapshot } from "../lib/chain/types";

function fixture(): AccountRaffleState {
  const snapshot: RaffleSnapshot = {
    id: 1n, block: { number: 1n, hash: zeroHash, timestamp: 1000n },
    raffle: {
      seller: "0x1111111111111111111111111111111111111111", nft: "0x2222222222222222222222222222222222222222", tokenId: 1n,
      salesEnd: 1000n, createdAt: 1n, drawnAt: 0n, vrfRequestedAt: 0n, phase: 2, escrowed: true, snapshotted: true, revealed: false,
      reserveNonce: zeroHash, reserveCommit: zeroHash, publicHash: zeroHash, lotCursor: 2n, snapshotTotal: 2n,
      principalEscrow: 2_000_000n, feeEscrow: 40_000n, vrfRequestId: 0n, randomWord: 0n, winner: zeroAddress, packCount: 1, title: "Fixture"
    },
    admission: { status: "opened", reviewHash: null, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: zeroAddress, approvedAtOpening: true } },
    packs: [], policy: {
      treasury: zeroAddress, termsHash: zeroHash, coordinator: zeroAddress, keyHash: zeroHash,
      subscriptionId: 1n, callbackGasLimit: 500_000, requestConfirmations: 3, nativePayment: true, buyerFeeBps: 200, sellerFeeBps: 200, minBuyerFeeUsdc: 2_500_000n
    },
    lotCount: 2n, paused: false, owner: "0x3333333333333333333333333333333333333333", ethEnabled: false,
    accounting: { grossPrincipal: 2_000_000n, buyerFees: 40_000n }, drawStartGrace: 604800n, randomnessGrace: 604800n, revealGrace: 604800n
  };
  return { account: "0x4444444444444444444444444444444444444444", snapshot, principal: 0n, fee: 0n, usdcBalance: 0n, usdcAllowance: 0n, nftOwner: null, nftApproved: false };
}
function canStart(account: AccountRaffleState) {
  return availableActions(account.snapshot, account).some(action => action.kind === "requestRandomness" && action.enabled);
}

describe("permissionless draw action availability", () => {
  it.each([false, true])("allows unrelated wallets while paused=%s without granting reveal", paused => {
    const account = fixture(); account.snapshot.paused = paused;
    expect(canStart(account)).toBe(true);
    expect(availableActions(account.snapshot, account).find(action => action.kind === "reveal")?.enabled).toBe(false);
    expect(availableActions(account.snapshot, null).find(action => action.kind === "requestRandomness")?.enabled).toBe(false);
  });
  it.each([0, 1, 3, 4, 5, 6])("does not offer a new draw in phase %s", phase => {
    const account = fixture(); account.snapshot.raffle.phase = phase;
    expect(canStart(account)).toBe(false);
  });
  it("requires a complete nonempty snapshot", () => {
    const account = fixture(); account.snapshot.raffle.snapshotted = false;
    expect(canStart(account)).toBe(false);
    account.snapshot.raffle.snapshotted = true; account.snapshot.raffle.snapshotTotal = 0n;
    expect(canStart(account)).toBe(false);
  });
  it("switches from starting the draw to refunds at the exact fixed cutoff", () => {
    const account = fixture();
    account.snapshot.block.timestamp = account.snapshot.raffle.salesEnd + 604799n;
    expect(canStart(account)).toBe(true);
    expect(availableActions(account.snapshot, account).find(action => action.kind === "cancel")?.enabled).toBe(false);
    account.snapshot.block.timestamp++;
    expect(canStart(account)).toBe(false);
    expect(availableActions(account.snapshot, account).find(action => action.kind === "cancel")?.enabled).toBe(true);
  });
});
