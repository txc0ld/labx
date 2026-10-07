import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copyPlaceholder } from "../components/DiscountCode";
import { isCurrentPath, isExactCurrentPath, PRIMARY_LINKS } from "../lib/nav";
import { PARTNER_OFFERS } from "../lib/offers";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("workflow navigation", () => {
  it("includes the main membership and discount destinations", () => {
    expect(PRIMARY_LINKS.map((link) => link.href)).toEqual([
      "/", "/membership", "/discounts", "/fairness", "/seller", "/profile"
    ]);
    expect(isCurrentPath("/discounts/seatmap", "/discounts")).toBe(true);
    expect(isCurrentPath("/profile/history", "/profile")).toBe(true);
  });

  it("marks only the exact account destination as current", () => {
    expect(isExactCurrentPath("/profile/history", "/profile")).toBe(false);
    expect(isExactCurrentPath("/profile/history", "/profile/history")).toBe(true);
  });
});

describe("partner offers", () => {
  it("publishes only the two approved five-percent offers", () => {
    expect(PARTNER_OFFERS).toEqual([
      expect.objectContaining({ slug: "fantom-labs", benefit: "5% off any Fantom Labs service", website: "https://www.fantomlabs.io/" }),
      expect.objectContaining({ slug: "seatmap", benefit: "5% off SeatMap Pro membership", website: "https://seatmap.app/pro" })
    ]);
  });

  it("labels XXXX as a non-redeemable placeholder", () => {
    const detail = read("components/OfferDetail.tsx");
    const code = read("components/DiscountCode.tsx");
    expect(code).toContain('value="XXXX"');
    expect(code).toMatch(/placeholder and cannot redeem/i);
    expect(detail).toMatch(/Redemption is unavailable/);
    expect(detail).toMatch(/not applied automatically/);
    expect(detail).not.toMatch(/expires|minimum spend|verified member/i);
  });

  it("copies through an available clipboard and falls back cleanly on denial", async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(copyPlaceholder({ writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("XXXX");
    await expect(copyPlaceholder(undefined)).resolves.toBe(false);
    await expect(copyPlaceholder({ writeText: async () => { throw new Error("denied"); } })).resolves.toBe(false);
  });
});

describe("account data boundaries", () => {
  it("does not claim eligibility or fabricate account records", () => {
    const eligibility = read("app/eligibility/page.tsx");
    const history = read("app/profile/history/page.tsx");
    const receipts = read("app/profile/receipts/page.tsx");
    expect(eligibility).toMatch(/does not save it or confirm that you are eligible/i);
    expect(history).toMatch(/LiveAccountHistory/);
    expect(receipts).toMatch(/LivePrivateRecords/);
    expect(read("components/workflow/AccountHistory.tsx")).toMatch(/service\.history/);
    expect(read("components/workflow/PrivateRecordsPanel.tsx")).toMatch(/readRecords/);
    expect(`${history}\n${receipts}`).not.toMatch(/receipt #|purchased on/i);
  });
});
