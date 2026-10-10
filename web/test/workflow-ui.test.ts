import { describe, expect, it } from "vitest";
import { formatDate, formatShortDate, formatUsdc, formatUsdcAmount, lowerFirst, parseUsdc, phaseLabel } from "../components/workflow/format";

describe("workflow value presentation", () => {
  it("formats atomic USDC exactly without floating-point rounding", () => {
    expect(formatUsdc(0n)).toBe("0");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(1_250_000n)).toBe("1.25");
    expect(formatUsdc(9_007_199_254_740_993_123_456n)).toBe("9,007,199,254,740,993.123456");
  });

  it("shows USDC amounts to people with at least two decimals and no lost precision", () => {
    expect(formatUsdcAmount(0n)).toBe("0.00");
    expect(formatUsdcAmount(12_500_000n)).toBe("12.50");
    expect(formatUsdcAmount(78_400_000n)).toBe("78.40");
    expect(formatUsdcAmount(1_000_000_000_000n)).toBe("1,000,000.00");
    expect(formatUsdcAmount(1_250_000n)).toBe("1.25");
    expect(formatUsdcAmount(1n)).toBe("0.000001");
  });

  it("parses human USDC without accepting rounding or scientific notation", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("1.000001")).toBe(1_000_001n);
    expect(() => parseUsdc("1.0000001")).toThrow(/6 decimal/);
    expect(() => parseUsdc("1e3")).toThrow(/USDC/);
    expect(() => parseUsdc("0")).toThrow(/greater than zero/);
  });

  it("labels every contract phase and does not invent unknown states", () => {
    expect(Array.from({ length: 7 }, (_, phase) => phaseLabel(phase))).toEqual([
      "Draft", "Open", "Closed", "Drawing", "Drawn", "Settled", "Cancelled"
    ]);
    expect(phaseLabel(99)).toBe("Unknown");
  });

  it("lowers only the first letter of an action label so acronyms survive", () => {
    expect(`Confirm ${lowerFirst("Approve exact USDC")}`).toBe("Confirm approve exact USDC");
    expect(`Confirm ${lowerFirst("Reclaim NFT")}`).toBe("Confirm reclaim NFT");
    expect(lowerFirst("")).toBe("");
  });

  it("renders contract timestamps explicitly in UTC", () => {
    expect(formatDate(1_798_761_600n)).toMatch(/1 Jan 2027.*12:00 am/i);
    expect(formatShortDate(1_798_761_600n)).toMatch(/^1 Jan, 12:00 am UTC$/i);
  });
});
