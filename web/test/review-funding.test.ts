import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { drawFundingMessage, etherPair, readAdmissionFrom } from "../components/review/OwnerReview";
import type { AdmissionReview } from "../lib/chain/types";

describe("review page draw funding", () => {
  const required = 434_000_000_000_000_000n;
  it("warns when the subscription holds less than Chainlink's estimate, as it did for raffle 3", () => {
    expect(drawFundingMessage({ nativeBalance: parseEther("0.1"), required, consumer: true })).toEqual({
      tone: "warning",
      text: "Draw funding looks short. The VRF subscription holds 0.1 ETH, below Chainlink’s estimated 0.434 ETH for this raffle’s draw, so the draw may wait. Top it up before sales end."
    });
  });
  it("states the balance against the estimate when the subscription is funded", () => {
    expect(drawFundingMessage({ nativeBalance: parseEther("0.5"), required, consumer: true })).toEqual({
      tone: "info", text: "Draw funding: the VRF subscription holds 0.5 ETH, at least Chainlink’s estimated 0.434 ETH for this raffle’s draw."
    });
  });
  it("never shows a funded balance as smaller than the estimate", () => {
    expect(etherPair(334_118_000_000_000_000n, 334_118_000_000_000_000n)).toEqual(["0.334118", "0.334118"]);
    expect(etherPair(433_950_000_000_000_000n, 433_901_000_000_000_000n)).toEqual(["0.43395", "0.43391"]);
    expect(etherPair(parseEther("0.1"), required)).toEqual(["0.1", "0.434"]);
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
  it("reads once without a minimum block", async () => {
    let reads = 0;
    await readAdmissionFrom({ readAdmission: async () => { reads++; return at(1n); } }, 3n);
    expect(reads).toBe(1);
  });
  it("refuses to show a review older than the approval after five reads, so the stale header never returns", async () => {
    let reads = 0;
    await expect(readAdmissionFrom({ readAdmission: async () => { reads++; return at(99n); } }, 3n, 100n, async () => {})).rejects.toThrow(/caught up with the recorded approval/);
    expect(reads).toBe(5);
  });
});
