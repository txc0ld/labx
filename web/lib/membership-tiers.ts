export const STANDARD_MEMBERSHIP_TIERS = ["Entry", "Bronze", "Silver", "Gold", "Platinum"] as const;

export type MembershipTierName = typeof STANDARD_MEMBERSHIP_TIERS[number];

export function hasStandardMembershipTiers(packs: readonly { name: string }[]): boolean {
  return packs.length === STANDARD_MEMBERSHIP_TIERS.length
    && STANDARD_MEMBERSHIP_TIERS.every((name, index) => packs[index]?.name === name);
}

export function requireStandardMembershipTiers(packs: readonly { name: string }[]): void {
  if (!hasStandardMembershipTiers(packs)) {
    throw new Error("Standard raffles require Entry, Bronze, Silver, Gold and Platinum in that order.");
  }
}
