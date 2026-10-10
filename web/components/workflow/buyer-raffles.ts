import type { AccountRaffleState, HistoryItem } from "@/lib/chain/types";
import { sameAddress } from "@/lib/chain/validation";
import { availableActions } from "@/lib/chain/workflow";
import { catalogAvailability, formatUsdcAmount } from "./format";

export type BuyerRaffleRow = { id: bigint; title: string; status: string; memberships: string; entries: number; action: string | null };

/** "Gold × 2 · Entry × 1". A purchase names its tier only when exactly one pack has its price and bonus entries. */
function membershipSummary(purchases: readonly HistoryItem[], account: AccountRaffleState) {
  const counts = new Map<string, number>();
  for (const purchase of purchases) {
    const quantity = BigInt(purchase.quantity);
    const matches = account.snapshot.packs.filter(pack => pack.priceUsdc * quantity === purchase.principal && BigInt(pack.bonusEntries) * quantity === BigInt(purchase.bonusEntries));
    const name = matches.length === 1 ? matches[0].name : "Membership";
    counts.set(name, (counts.get(name) ?? 0) + purchase.quantity);
  }
  return [...counts].map(([name, quantity]) => `${name} × ${quantity}`).join(" · ");
}

export function buyerRaffleRow(purchases: readonly HistoryItem[], account: AccountRaffleState): BuyerRaffleRow {
  const { snapshot } = account;
  const actions = availableActions(snapshot, account);
  const enabled = (kind: "claimPrize" | "refund") => actions.some(action => action.kind === kind && action.enabled);
  const won = snapshot.raffle.phase >= 4 && sameAddress(snapshot.raffle.winner, account.account);
  return {
    id: snapshot.id,
    title: snapshot.raffle.title,
    status: won ? "You won" : catalogAvailability(snapshot).label,
    memberships: membershipSummary(purchases, account),
    entries: purchases.reduce((sum, purchase) => sum + purchase.bonusEntries, 0),
    action: enabled("claimPrize") ? "Claim your NFT" : enabled("refund") ? `Claim ${formatUsdcAmount(account.principal)} USDC refund` : null
  };
}
