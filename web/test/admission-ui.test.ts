import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { admissionLabel, formatOwnerPayload, loadOwnerQueuePage } from "../components/review/OwnerReview";
import type { AdmissionStatus, OwnerExecutionIntent, RaffleSnapshot } from "../lib/chain/types";

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const RAFFLE: Address = "0x2222222222222222222222222222222222222222";
const DIGEST: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function snapshot(admission: AdmissionStatus): RaffleSnapshot {
  return {
    id: 7n,
    block: { number: 50n, hash: zeroHash, timestamp: 1_800_000_000n },
    raffle: {
      seller: zeroAddress,
      nft: zeroAddress,
      tokenId: 9n,
      salesEnd: 1_800_003_600n,
      createdAt: 1n,
      drawnAt: 0n,
      vrfRequestedAt: 0n,
      phase: 0,
      escrowed: true,
      snapshotted: false,
      revealed: false,
      reserveNonce: zeroHash,
      reserveCommit: zeroHash,
      publicHash: zeroHash,
      lotCursor: 0n,
      snapshotTotal: 0n,
      principalEscrow: 0n,
      feeEscrow: 0n,
      vrfRequestId: 0n,
      randomWord: 0n,
      winner: zeroAddress,
      packCount: 1,
      title: "Reviewed draft"
    },
    packs: [],
    policy: {
      coordinator: zeroAddress,
      treasury: zeroAddress,
      termsHash: zeroHash,
      keyHash: zeroHash,
      subscriptionId: 1n,
      callbackGasLimit: 500_000,
      requestConfirmations: 3,
      nativePayment: false,
      buyerFeeBps: 200,
      sellerFeeBps: 200,
      minBuyerFeeUsdc: 2_500_000n
    },
    admission,
    accounting: { grossPrincipal: 0n, buyerFees: 0n },
    lotCount: 0n,
    paused: false,
    owner: OWNER,
    ethEnabled: false,
    drawStartGrace: 604_800n,
    randomnessGrace: 604_800n,
    revealGrace: 604_800n
  };
}

describe("owner admission UI", () => {
  const draftCases: readonly (readonly ["pending" | "changed" | "approved", string])[] = [
    ["pending", "Pending review"],
    ["changed", "Changed since review"],
    ["approved", "Approved for current draft"]
  ];
  it.each(draftCases)("labels a draft in %s state without claiming authenticity", (status, expected) => {
    const record = { reviewRevision: 3n, approvedReviewHash: status === "pending" ? zeroHash : DIGEST, approvedBy: status === "pending" ? zeroAddress : OWNER, approvedAtOpening: false };
    const result = admissionLabel(snapshot({ status, reviewHash: DIGEST, record }));
    expect(result.label).toBe(expected);
    expect(result.detail).not.toMatch(/authentic|guarantee/i);
  });

  it("exports only the exact public zero-value call fields", () => {
    const intent: OwnerExecutionIntent = {
      action: { kind: "approveRaffle", id: 7n, expectedReviewHash: DIGEST, attestations: { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } },
      runtimeCodeHash: zeroHash,
      chainId: 11155111,
      from: OWNER,
      to: RAFFLE,
      value: 0n,
      data: "0x1234",
      reviewBlock: { number: 50n, hash: zeroHash, timestamp: 1_800_000_000n },
      ownerGeneration: 1n,
      openingPolicyGeneration: 2n,
      reviewRevision: 3n
    };
    expect(formatOwnerPayload(intent)).toBe(`{\n  "chainId": 11155111,\n  "from": "${OWNER}",\n  "to": "${RAFFLE}",\n  "value": 0,\n  "data": "0x1234"\n}`);
    expect(formatOwnerPayload(intent)).not.toMatch(/proposal|signature|private/i);
  });

  it("checks the pinned current owner before accepting an empty queue page", async () => {
    const block = { number: 50n, hash: zeroHash, timestamp: 1_800_000_000n };
    const calls: string[] = [];
    const service = {
      async readOwner(input: { block?: typeof block }) {
        calls.push(`owner:${input.block?.number.toString() ?? "latest"}`);
        return { owner: OWNER, block };
      },
      async listOwnerQueue(input?: { cursor?: bigint; limit?: number; block?: typeof block }) {
        calls.push(`queue:${input?.limit}:${input?.block?.number.toString()}`);
        return { items: [], nextCursor: 25n, block };
      }
    };
    await expect(loadOwnerQueuePage({ service, account: OWNER })).resolves.toMatchObject({ items: [], nextCursor: 25n });
    expect(calls).toEqual(["owner:latest", "queue:24:50"]);
    await expect(loadOwnerQueuePage({ service, account: RAFFLE })).rejects.toThrow(/current on-chain raffle owner/);
    expect(calls).toEqual(["owner:latest", "queue:24:50", "owner:latest"]);
  });

  it("keeps refund presentation principal-only and owner intent parsing authoritative", () => {
    const workspace = readFileSync(resolve(__dirname, "../components/workflow/RaffleWorkspace.tsx"), "utf8");
    const review = readFileSync(resolve(__dirname, "../components/review/OwnerReview.tsx"), "utf8");
    expect(workspace).toContain("Your refundable principal");
    expect(workspace).toContain("Cancellation refunds principal only");
    expect(workspace).not.toContain("account.principal + account.fee");
    expect(review).toContain("serializeOwnerExecutionIntent(intent)");
    expect(review).toContain("parseOwnerExecutionIntent(raw, service.manifest, owner)");
    expect(review).toContain("A Safe transaction proposal hash is not an executed Ethereum transaction hash");
    expect(review).toContain("has not reached two canonical confirmations");
    expect(review).toContain("Download approval file");
    expect(review).toContain("Connect the Safe to LABx");
    expect(review).toContain("discoverOwnerExecutions");
    expect(review).not.toContain("matching event has not been finalized");
  });
});
