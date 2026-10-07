import type { Address } from "viem";
import type { ActionAvailability, ActionKind, RaffleSnapshot } from "./types";
import { sameAddress } from "./validation";

export const SELLER_ACTION_KINDS = [
  "updateDraft",
  "approvePrize",
  "escrow",
  "open",
  "close",
  "snapshot",
  "requestRandomness",
  "reveal",
  "settle",
  "claimProceeds",
  "cancel",
  "abortDrawing",
  "reclaimPrize"
] as const satisfies readonly ActionKind[];
export type SellerActionKind = typeof SELLER_ACTION_KINDS[number];
export type SellerActionAvailability = ActionAvailability & { kind: SellerActionKind };

const SELLER_ACTIONS = new Set<ActionKind>(SELLER_ACTION_KINDS);

export function parseSellerRaffleId(value: string): bigint | null {
  if (!/^[1-9]\d{0,77}$/.test(value)) return null;
  const id = BigInt(value);
  return id < 2n ** 256n ? id : null;
}

export function sellerPortalActions(actions: readonly ActionAvailability[]): readonly SellerActionAvailability[] {
  return actions.filter((action): action is SellerActionAvailability => SELLER_ACTIONS.has(action.kind));
}

export function sellerOwnsRaffle(account: Address, snapshot: RaffleSnapshot): boolean {
  return sameAddress(account, snapshot.raffle.seller);
}
