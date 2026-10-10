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
  | { kind: "action"; action: SellerActionAvailability; message?: string }
  | { kind: "waiting"; title: string; message: string };

const DRAW_KINDS = new Set<SellerActionKind>(["close", "snapshot", "requestRandomness", "reveal"]);

/** Why sales ended without any possible draw, or null while a draw can still happen. */
export function drawBlocker(snapshot: RaffleSnapshot): string | null {
  const { raffle, block } = snapshot;
  if (raffle.phase !== 1 && raffle.phase !== 2 || block.timestamp < raffle.salesEnd) return null;
  if (snapshot.lotCount === 0n) return "No memberships were sold.";
  if (raffle.snapshotted && raffle.snapshotTotal === 0n) return "No entries were frozen.";
  if (block.timestamp >= raffle.salesEnd + snapshot.drawStartGrace) return "The draw-start deadline has passed.";
  return null;
}

const REFUNDS = "Enable refunds so buyers can claim their principal.";

export function cancelGuidance(snapshot: RaffleSnapshot, blocker: string) {
  return `${blocker} ${snapshot.lotCount === 0n ? "Cancel the raffle, then reclaim your NFT." : REFUNDS}`;
}

export const RECLAIM_GUIDANCE = "The raffle is cancelled. Reclaim your NFT.";

export function sellerNextStep(snapshot: RaffleSnapshot, actions: readonly SellerActionAvailability[]): SellerNextStep {
  const { raffle, block } = snapshot;
  const waiting = (title: string, message: string): SellerNextStep => ({ kind: "waiting", title, message });
  const enabled = (kind: SellerActionKind) => actions.find(item => item.kind === kind && item.enabled);
  const next = (kinds: readonly SellerActionKind[], title: string, message: string): SellerNextStep => {
    for (const kind of kinds) {
      const action = enabled(kind);
      if (action) return { kind: "action", action };
    }
    const reason = kinds.map(kind => actions.find(item => item.kind === kind)?.reason).find(Boolean);
    return waiting(title, reason || message);
  };
  const blocker = drawBlocker(snapshot);
  if (blocker) {
    const cancel = enabled("cancel");
    return cancel ? { kind: "action", action: cancel, message: cancelGuidance(snapshot, blocker) } : waiting("Draw cannot start", blocker);
  }
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
    case 2:
      return next(raffle.snapshotted ? ["requestRandomness"] : ["snapshot"], "Draw not ready", "Review the draw status. Available recovery actions are under Advanced.");
    case 3: {
      const abort = block.timestamp >= raffle.vrfRequestedAt + snapshot.randomnessGrace ? enabled("abortDrawing") : undefined;
      if (abort) return { kind: "action", action: abort, message: `The randomness deadline passed without a result. ${REFUNDS}` };
      return waiting("Waiting for the draw", "The randomness request is pending. Refresh after fulfillment.");
    }
    case 4:
      return next(["settle", "reveal"], "Waiting for settlement", "Settlement becomes available after reveal or the published grace period.");
    case 5:
      if (raffle.principalEscrow === 0n) return waiting("Raffle settled", "There are no seller proceeds left to claim.");
      return next(["claimProceeds"], "Raffle settled", "There are no seller proceeds left to claim.");
    case 6: {
      const refundNote = snapshot.lotCount > 0n ? "Buyers can claim any remaining refundable principal." : "No memberships were purchased.";
      const reclaim = raffle.escrowed ? enabled("reclaimPrize") : undefined;
      if (reclaim) return { kind: "action", action: reclaim, message: snapshot.lotCount > 0n ? `${RECLAIM_GUIDANCE} ${refundNote}` : RECLAIM_GUIDANCE };
      return waiting("Raffle cancelled", refundNote);
    }
    default:
      return waiting("Raffle state unavailable", "Refresh the verified contract state before continuing.");
  }
}

/** Enabled seller actions other than the next step, in portal order. Draw controls are dropped once no draw can happen. */
export function sellerSecondaryActions(snapshot: RaffleSnapshot, actions: readonly SellerActionAvailability[], next: SellerNextStep): readonly SellerActionAvailability[] {
  const primary = next.kind === "action" ? next.action.kind : null;
  const blocked = drawBlocker(snapshot) !== null;
  return SELLER_ACTION_KINDS.flatMap(kind => {
    const item = actions.find(candidate => candidate.kind === kind && candidate.enabled);
    return item && kind !== "updateDraft" && kind !== primary && !(blocked && DRAW_KINDS.has(kind)) ? [item] : [];
  });
}
