import { describe, expect, it } from "vitest";
import { formatDate, formatUsdc, phaseLabel } from "../components/workflow/format";

describe("workflow value presentation", () => {
  it("formats atomic USDC exactly without floating-point rounding", () => {
    expect(formatUsdc(0n)).toBe("0");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(1_250_000n)).toBe("1.25");
    expect(formatUsdc(9_007_199_254_740_993_123_456n)).toBe("9,007,199,254,740,993.123456");
  });

  it("labels every contract phase and does not invent unknown states", () => {
    expect(Array.from({ length: 7 }, (_, phase) => phaseLabel(phase))).toEqual([
      "Draft", "Open", "Closed", "Drawing", "Drawn", "Settled", "Cancelled"
    ]);
    expect(phaseLabel(99)).toBe("Unknown");
  });

  it("renders contract timestamps explicitly in UTC", () => {
    expect(formatDate(1_798_761_600n)).toMatch(/1 Jan 2027.*12:00 am/i);
  });
});
