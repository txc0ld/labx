import { fixtureTrust } from "./fixtures/deployment";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex, zeroAddress, zeroHash } from "viem";
import { BUYER_FEE_BPS, MAX_MEMBERSHIP_TOTAL_USDC, SELLER_FEE_BPS, buyerFee, sellerAccounting } from "../lib/chain/fees";
import { localDevelopmentManifest } from "../lib/chain/browser";
import { serverWorkflow } from "../lib/chain/server";
import { APPROVED_DEPLOYMENTS } from "../lib/chain/deployment";
import type { RaffleSnapshot } from "../lib/chain/types";
import { PUBLISHED_TERMS_CONTENT, PUBLISHED_TERMS_HASH, TERMS_VERSION, publishedTermsByHash, requirePublishedTerms } from "../lib/published-terms";

function snapshot(phase: number, principalEscrow: bigint, feeEscrow: bigint): RaffleSnapshot {
  return {
    id: 1n, block: { number: 1n, hash: zeroHash, timestamp: 1n },
    raffle: { seller: zeroAddress, nft: zeroAddress, tokenId: 1n, salesEnd: 2n, createdAt: 1n, drawnAt: 0n, vrfRequestedAt: 0n,
      phase, escrowed: true, snapshotted: false, revealed: false, reserveNonce: zeroHash, reserveCommit: zeroHash,
      publicHash: zeroHash, lotCursor: 0n, snapshotTotal: 0n, principalEscrow, feeEscrow, vrfRequestId: 0n,
      randomWord: 0n, winner: zeroAddress, packCount: 1, title: "Fees" },
    packs: [], policy: { coordinator: zeroAddress, treasury: zeroAddress, termsHash: PUBLISHED_TERMS_HASH,
      keyHash: zeroHash, subscriptionId: 1n, callbackGasLimit: 500_000, requestConfirmations: 3,
      nativePayment: false, buyerFeeBps: 200, sellerFeeBps: 200, minBuyerFeeUsdc: 2_500_000n },
    admission: { status: "opened", reviewHash: null, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: zeroAddress, approvedAtOpening: true } },
    accounting: { grossPrincipal: 247n, buyerFees: 2n }, lotCount: 4n, paused: false, owner: zeroAddress,
    ethEnabled: false, drawStartGrace: 604800n, randomnessGrace: 604800n, revealGrace: 604800n
  };
}

describe("percentage fee arithmetic and seller accounting", () => {
  it.each([
    [1n, 1, 0n], [1n, 20, 0n], [49n, 1, 0n], [49n, 2, 1n], [49n, 20, 19n],
    [50n, 1, 1n], [50n, 20, 20n], [51n, 1, 1n], [51n, 20, 20n],
    [124_999_999n, 1, 2_500_000n], [125_000_000n, 1, 2_500_000n], [125_000_049n, 1, 2_500_000n], [125_000_050n, 1, 2_500_001n], [200_000_000n, 1, 4_000_000n],
    [1_000_000_000_000n, 20, 400_000_000_000n]
  ])("price %s and quantity %s apply the per-call fee to %s", (price, quantity, fee) => {
    expect(buyerFee(price * BigInt(quantity), BUYER_FEE_BPS, 2_500_000n)).toBe(fee < 2_500_000n ? 2_500_000n : fee);
  });
  it("keeps split-purchase fees separate and the maximum approval exact", () => {
    expect(buyerFee(49n, 200, 2_500_000n) * 2n).toBe(5_000_000n);
    expect(buyerFee(98n, 200, 2_500_000n)).toBe(2_500_000n);
    expect(20_000_000_000_000n + buyerFee(20_000_000_000_000n, 200, 2_500_000n)).toBe(MAX_MEMBERSHIP_TOTAL_USDC);
    expect(SELLER_FEE_BPS).toBe(200);
    expect(() => buyerFee(-1n, 200, 2_500_000n)).toThrow();
    for (const bps of [-1, 0.5, NaN, Infinity, 65536]) expect(() => buyerFee(1n, bps, 2_500_000n)).toThrow();
  });
  it.each([1, 2, 3, 4])("does not book revenue during phase %s", phase => {
    expect(sellerAccounting(snapshot(phase, 247n, 2n))).toMatchObject({
      grossPrincipal: 247n, buyerFees: 2n, sellerCommission: 0n, netProceeds: 0n,
      claimableProceeds: 0n, paidProceeds: 0n, escrowHeld: 249n, pendingPrincipal: 247n,
      refundLiability: 0n, refundedPrincipal: 0n, refundedBuyerFees: 0n
    });
  });
  it("keeps net revenue after either escrow has been claimed", () => {
    for (const fee of [6n, 0n]) {
      expect(sellerAccounting(snapshot(5, 243n, fee))).toMatchObject({ sellerCommission: 4n, buyerFees: 2n,
        netProceeds: 243n, claimableProceeds: 243n, paidProceeds: 0n, pendingPrincipal: 0n, refundLiability: 0n });
      expect(sellerAccounting(snapshot(5, 0n, fee))).toMatchObject({ netProceeds: 243n, claimableProceeds: 0n,
        paidProceeds: 243n, escrowHeld: fee, buyerFees: 2n, grossPrincipal: 247n });
    }
  });
  it("distinguishes pending refunds, partial refunds and full refunds from revenue", () => {
    expect(sellerAccounting(snapshot(6, 247n, 2n))).toMatchObject({ netProceeds: 0n, sellerCommission: 0n,
      refundLiability: 247n, refundedPrincipal: 0n, refundedBuyerFees: 0n, pendingPrincipal: 0n });
    expect(sellerAccounting(snapshot(6, 196n, 1n))).toMatchObject({ refundLiability: 196n,
      refundedPrincipal: 51n, refundedBuyerFees: 0n, protocolFeesPaid: 1n, netProceeds: 0n, sellerCommission: 0n });
    expect(sellerAccounting(snapshot(6, 0n, 0n))).toMatchObject({ refundLiability: 0n,
      refundedPrincipal: 247n, refundedBuyerFees: 0n, protocolFeesPaid: 2n, netProceeds: 0n, sellerCommission: 0n });
  });
});

describe("current and historical fee terms", () => {
  const oldHash = "0xb3c83a96bc5e11afd2758d8b515bd495d83294a24d44c15c42b9aa970f4a75d1";
  it("preserves the exact prior JSON hash and version as a read-only publication", () => {
    const archived = publishedTermsByHash(oldHash);
    expect(archived.version).toBe("labx-membership-2026-10-06-v2");
    expect(Buffer.byteLength(archived.content)).toBe(2959);
    expect(keccak256(stringToHex(archived.content))).toBe(oldHash);
    expect(archived.content).toContain("The lab fee is 5 USDC per pack");
    expect(() => requirePublishedTerms(oldHash)).toThrow(/do not match/);
    expect(() => publishedTermsByHash(zeroHash)).toThrow(/Unknown/);
  });
  it("binds new writes to new content and documents actual rounding and refunds", () => {
    expect(TERMS_VERSION).toBe("labx-membership-2026-10-07-v3");
    expect(PUBLISHED_TERMS_HASH).not.toBe(oldHash);
    expect(publishedTermsByHash(PUBLISHED_TERMS_HASH).content).toBe(PUBLISHED_TERMS_CONTENT);
    expect(() => requirePublishedTerms(PUBLISHED_TERMS_HASH)).not.toThrow();
    expect(PUBLISHED_TERMS_CONTENT).toContain("round the 2% amount down");
    expect(PUBLISHED_TERMS_CONTENT).toContain("2% seller commission");
    expect(PUBLISHED_TERMS_CONTENT).toContain("No seller commission is charged on cancellation");
  });
});

describe("local v3 deployment parsing", () => {
  afterEach(() => vi.unstubAllEnvs());
  const manifest = { chainId: 31337, version: 3, address: "0x1111111111111111111111111111111111111111", usdc: "0x2222222222222222222222222222222222222222",
    ...fixtureTrust, expectedPolicy: { ...fixtureTrust.expectedPolicy, subscriptionId: "1", minBuyerFeeUsdc: "2500000" }, runtimeCodeHash: zeroHash, deploymentBlock: "1" };
  it("retains the empty approval registry and only enables local v3 fixtures", () => {
    expect(APPROVED_DEPLOYMENTS).toEqual([]);
    vi.stubEnv("NODE_ENV", "development");
    expect(localDevelopmentManifest(JSON.stringify(manifest))?.version).toBe(3);
    vi.stubEnv("NODE_ENV", "production");
    expect(localDevelopmentManifest(JSON.stringify(manifest))).toBeNull();
  });
  it.each([undefined, null, 1, 2, 4, "3"])("rejects supplied version %s in both parsers", async version => {
    vi.stubEnv("NODE_ENV", "development");
    const raw = JSON.stringify({ ...manifest, version });
    expect(() => localDevelopmentManifest(raw)).toThrow(/Invalid/);
    vi.stubEnv("NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST", raw);
    await expect(serverWorkflow()).rejects.toThrow(/configuration is invalid/);
  });
});
