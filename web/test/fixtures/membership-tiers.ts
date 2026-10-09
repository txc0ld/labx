import type { DraftInput } from "../../lib/chain/types";
import { STANDARD_MEMBERSHIP_TIERS, type MembershipTierName } from "../../lib/membership-tiers";
import type { Page } from "playwright";

type MembershipEconomics = Omit<DraftInput["packs"][number], "name">;

export function standardMembershipPacks(economics: (tier: MembershipTierName, index: number) => MembershipEconomics): DraftInput["packs"] {
  return STANDARD_MEMBERSHIP_TIERS.map((name, index) => ({ name, ...economics(name, index) }));
}

export async function fillStandardMembershipEconomics(page: Page, economics: (tier: MembershipTierName, index: number) => { price: string; bonusEntries: string; supply: string }): Promise<void> {
  for (const [index, tier] of STANDARD_MEMBERSHIP_TIERS.entries()) {
    const group = page.getByRole("group", { name: `Membership ${index + 1}: ${tier}`, exact: true });
    const values = economics(tier, index);
    await group.getByLabel("Price in USDC", { exact: true }).fill(values.price);
    await group.getByLabel("Bonus entries", { exact: true }).fill(values.bonusEntries);
    await group.getByLabel("Supply", { exact: true }).fill(values.supply);
  }
}
