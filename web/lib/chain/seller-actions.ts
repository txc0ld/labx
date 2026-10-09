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

export type SellerNextStep =
  | { kind: "action"; action: SellerActionAvailability }
  | { kind: "waiting"; title: string; message: string };

export function sellerNextStep(snapshot: RaffleSnapshot, actions: readonly SellerActionAvailability[]): SellerNextStep {
  const { raffle, block } = snapshot;
  const waiting = (title: string, message: string): SellerNextStep => ({ kind: "waiting", title, message });
  const next = (kinds: readonly SellerActionKind[], title: string, message: string): SellerNextStep => {
    for (const kind of kinds) {
      const action = actions.find(item => item.kind === kind && item.enabled);
      if (action) return { kind: "action", action };
    }
    const reason = kinds.map(kind => actions.find(item => item.kind === kind)?.reason).find(Boolean);
    return waiting(title, reason || message);
  };
  switch (raffle.phase) {
    case 0:
      if (block.timestamp >= raffle.salesEnd) return waiting("Sales deadline passed", "Edit the draft deadline before continuing. LABx must review the updated draft.");
      if (!raffle.escrowed) return next(["approvePrize", "escrow"], "NFT escrow unavailable", "Refresh the NFT ownership and approval state before continuing.");
      if (snapshot.admission.status !== "approved") return waiting("Awaiting LABx review", snapshot.admission.status === "changed" ? "Your NFT is escrowed. LABx must review the changed draft before you can open memberships." : "Your NFT is escrowed. Once LABx approves this draft, you can open memberships here.");
      if (snapshot.paused) return waiting("Opening paused", "This draft is approved. Memberships can open after LABx resumes admissions.");
      return next(["open"], "Opening unavailable", "Refresh the current opening requirements before continuing.");
    case 1:
      if (block.timestamp < raffle.salesEnd) return waiting(snapshot.paused ? "Membership sales paused" : "Memberships are open", "Sales can close at the published deadline. Refresh the raffle then to continue the draw.");
      return next(["close"], "Sales deadline reached", "Refresh the raffle to close sales.");
    case 2: {
      const blocker = raffle.snapshotted && raffle.snapshotTotal === 0n
        ? "No entries were frozen."
        : block.timestamp >= raffle.salesEnd + snapshot.drawStartGrace ? "The draw-start deadline has passed." : null;
      if (blocker) return waiting("Draw cannot start", `${blocker}${actions.some(item => item.kind === "cancel" && item.enabled) ? " Use Enable refunds under Advanced." : ""}`);
      return next(raffle.snapshotted ? ["requestRandomness"] : ["snapshot"], "Draw not ready", "Review the draw status. Available recovery actions are under Advanced.");
    }
    case 3:
      return waiting("Waiting for the draw", "The randomness request is pending. Refresh after fulfillment. Available recovery actions are under Advanced.");
    case 4:
      return next(["settle", "reveal"], "Waiting for settlement", "Settlement becomes available after reveal or the published grace period.");
    case 5:
      if (raffle.principalEscrow === 0n) return waiting("Raffle settled", "There are no seller proceeds left to claim.");
      return next(["claimProceeds"], "Raffle settled", "There are no seller proceeds left to claim.");
    case 6:
      return waiting("Raffle cancelled", `${raffle.escrowed && actions.some(item => item.kind === "reclaimPrize" && item.enabled) ? "Reclaim the NFT under Advanced. " : ""}Buyers can claim their refundable principal.`);
    default:
      return waiting("Raffle state unavailable", "Refresh the verified contract state before continuing.");
  }
}
