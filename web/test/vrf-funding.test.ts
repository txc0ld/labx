import { describe, expect, it } from "vitest";
import { parseEther, zeroHash, type Address } from "viem";
import { readDrawFunding, vrfMinimumNativeBalance } from "../lib/chain/vrf-funding";
import type { RafflePolicy } from "../lib/chain/types";

const RAFFLE: Address = "0x8b0332D0ca48908e174F42eA1b3123e63f3F4327";
const OTHER: Address = "0x1111111111111111111111111111111111111111";
/** The live Sepolia policy and coordinator settings read on 18 Oct 2026. */
const policy = {
  coordinator: "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B", keyHash: zeroHash, subscriptionId: 87872268328198099397228888276383491550742527734296569403303774370612241641662n,
  callbackGasLimit: 500000, nativePayment: true
} as unknown as RafflePolicy;
const sepolia = { gasAfterPaymentCalculation: 38_900, flatFeePpm: 0, premium: 24, maxGas: 500_000_000_000n };

function coordinator(nativeBalance: bigint, consumers: readonly Address[], exists = true) {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "getSubscription") return [0n, nativeBalance, 0n, OTHER, consumers];
      if (functionName === "s_config") return [3, 2_500_000, false, 172_800, sepolia.gasAfterPaymentCalculation, sepolia.flatFeePpm, 0, sepolia.premium, 20];
      if (functionName === "s_provingKeys") return [exists, sepolia.maxGas];
      throw new Error(functionName);
    }
  } as unknown as Parameters<typeof readDrawFunding>[0];
}

describe("VRF draw funding", () => {
  it("needs 0.334118 ETH for 500,000 callback gas on Sepolia's 500 gwei lane", () => {
    expect(vrfMinimumNativeBalance({ callbackGasLimit: 500_000n, gasAfterPaymentCalculation: 38_900n, maxGasPrice: 500_000_000_000n, premiumPercentage: 24n, flatFeePpm: 0n })).toBe(334_118_000_000_000_000n);
  });

  it("adds the flat native fee, a millionth of a token per ppm", () => {
    expect(vrfMinimumNativeBalance({ callbackGasLimit: 0n, gasAfterPaymentCalculation: 0n, maxGasPrice: 0n, premiumPercentage: 0n, flatFeePpm: 5n })).toBe(5_000_000_000_000n);
  });

  it("reports the 0.1 ETH subscription that stalled raffle 3 as short, and the topped-up one as enough", async () => {
    const short = await readDrawFunding(coordinator(parseEther("0.1"), [RAFFLE]), policy, RAFFLE, 1n);
    expect(short).toEqual({ nativeBalance: parseEther("0.1"), required: 334_118_000_000_000_000n, consumer: true });
    const funded = await readDrawFunding(coordinator(parseEther("0.35"), [RAFFLE]), policy, RAFFLE, 1n);
    expect(funded.nativeBalance >= funded.required!).toBe(true);
  });

  it("reports a raffle contract missing from the subscription's consumers", async () => {
    expect((await readDrawFunding(coordinator(parseEther("1"), [OTHER]), policy, RAFFLE, 1n)).consumer).toBe(false);
  });

  it("does not price LINK billing", async () => {
    expect((await readDrawFunding(coordinator(parseEther("1"), [RAFFLE]), { ...policy, nativePayment: false }, RAFFLE, 1n)).required).toBeNull();
  });

  it("refuses a key hash the coordinator does not know", async () => {
    await expect(readDrawFunding(coordinator(parseEther("1"), [RAFFLE], false), policy, RAFFLE, 1n)).rejects.toThrow(/key hash/);
  });
});
