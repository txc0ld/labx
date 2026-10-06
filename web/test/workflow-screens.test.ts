import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copyPlaceholder } from "../components/DiscountCode";
import { isCurrentPath, isExactCurrentPath, PRIMARY_LINKS } from "../lib/nav";
import { PARTNER_OFFERS } from "../lib/offers";
import { initialStudioState, studioPreparation } from "../lib/studio-preparation";

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

describe("Studio preparation", () => {
  it("preserves entered details through review and edit, then clears them on reset", () => {
    let state = initialStudioState();
    state = studioPreparation(state, { kind: "change-title", value: "User piece" });
    state = studioPreparation(state, { kind: "change-artist", value: "User artist" });
    state = studioPreparation(state, { kind: "change-token-reference", value: "0xabc / 7" });
    state = studioPreparation(state, { kind: "change-proposed-close", value: "2027-02-03T14:00" });
    state = studioPreparation(state, { kind: "review" });
    expect(state).toEqual({ kind: "reviewing", draft: { title: "User piece", artist: "User artist", tokenReference: "0xabc / 7", proposedClose: "2027-02-03T14:00" } });
    state = studioPreparation(state, { kind: "edit" });
    expect(state.kind).toBe("editing");
    expect(state.draft.title).toBe("User piece");
    expect(studioPreparation(state, { kind: "reset" })).toEqual(initialStudioState());
  });

  it("keeps preparation session-only and excludes private commitment inputs", () => {
    const studio = read("components/StudioPreparation.tsx");
    expect(studio).toMatch(/current page session/);
    expect(studio).not.toMatch(/fetch\(|localStorage|sessionStorage/);
    expect(studio).not.toMatch(/type="file"/);
    expect(studio).toMatch(/Do not enter a private commitment/);
  });
});

describe("informational empty states", () => {
  it("does not claim eligibility or fabricate account records", () => {
    const eligibility = read("app/eligibility/page.tsx");
    const history = read("app/profile/history/page.tsx");
    const receipts = read("app/profile/receipts/page.tsx");
    expect(eligibility).toMatch(/does not save it or confirm that you are eligible/i);
    expect(history).toMatch(/History is unavailable/);
    expect(receipts).toMatch(/No receipt records available/);
    expect(`${history}\n${receipts}`).not.toMatch(/transaction hash|receipt #|purchased on/i);
  });
});
