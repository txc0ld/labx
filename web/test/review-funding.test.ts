import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { drawFundingMessage, readAdmissionFrom } from "../components/review/OwnerReview";
import type { AdmissionReview } from "../lib/chain/types";

describe("review page draw funding", () => {
  const required = 334_118_000_000_000_000n;
  it("warns when the subscription holds less than Chainlink needs, as it did for raffle 3", () => {
    expect(drawFundingMessage({ nativeBalance: parseEther("0.1"), required, consumer: true })).toEqual({
      tone: "warning",
      text: "Draw funding is short. The VRF subscription holds 0.1 ETH, and Chainlink answers this raffle’s draw only once it holds at least 0.335 ETH. Top it up before sales end."
    });
  });
  it("states the balance and the need when the subscription is funded", () => {
    expect(drawFundingMessage({ nativeBalance: parseEther("0.35"), required, consumer: true })).toEqual({
      tone: "info", text: "Draw funding: the VRF subscription holds 0.35 ETH. This raffle’s draw needs at least 0.335 ETH."
    });
  });
  it("warns when the raffle contract is not a consumer, whatever the balance", () => {
    expect(drawFundingMessage({ nativeBalance: parseEther("9"), required, consumer: false }).tone).toBe("warning");
  });
  it("warns when the funding cannot be read", () => {
    expect(drawFundingMessage("error").tone).toBe("warning");
  });
});

describe("review page refresh after an approval", () => {
  const at = (number: bigint) => ({ snapshot: { block: { number } } }) as unknown as AdmissionReview;
  it("reads again until the review is at least as new as the approval's block", async () => {
    const blocks = [99n, 99n, 100n];
    const waits: number[] = [];
    const review = await readAdmissionFrom({ readAdmission: async () => at(blocks.shift()!) }, 3n, 100n, async ms => { waits.push(ms); });
    expect(review.snapshot.block.number).toBe(100n);
    expect(waits).toEqual([2_000, 2_000]);
  });
  it("reads once without a minimum block, and gives up after five tries", async () => {
    let reads = 0;
    await readAdmissionFrom({ readAdmission: async () => { reads++; return at(1n); } }, 3n);
    expect(reads).toBe(1);
    reads = 0;
    const review = await readAdmissionFrom({ readAdmission: async () => { reads++; return at(1n); } }, 3n, 100n, async () => {});
    expect([reads, review.snapshot.block.number]).toEqual([5, 1n]);
  });
});
