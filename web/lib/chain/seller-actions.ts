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
  if (raffle.snapshotted && raffle.snapshotTotal === 0n) return "No entries were counted.";
  if (block.timestamp >= raffle.salesEnd + snapshot.drawStartGrace) return "The draw didn’t start in time.";
  return null;
}

const REFUNDS = "Enable refunds so buyers get their membership price back.";

export function cancelGuidance(snapshot: RaffleSnapshot, blocker: string, forSeller = true) {
  if (snapshot.lotCount > 0n) return `${blocker} ${REFUNDS}`;
  return `${blocker} ${forSeller ? "Cancel the raffle, then reclaim your NFT." : "Cancel the raffle so the seller can reclaim the NFT."}`;
}

export const RECLAIM_GUIDANCE = "The raffle is cancelled. Reclaim your NFT.";

/** What a seller step does, in the words its card uses. */
export function sellerStepText(snapshot: RaffleSnapshot, kind: SellerActionKind): string {
  switch (kind) {
    case "close": return "Sales have ended. Close sales to start the draw.";
    case "snapshot": return "Locks in every purchase for the draw.";
    case "requestRandomness": return "Picks a random winner. The result usually takes a few minutes.";
    case "reveal": return "Sign to load your saved draw setup, then confirm it. This lets you finish now instead of waiting 7 days.";
    case "settle": return "Pays out the sales and lets the winner claim the NFT.";
    case "claimProceeds": return "The raffle is complete. Your share of the sales is ready.";
    case "cancel":
      if (snapshot.raffle.phase === 0) return snapshot.raffle.escrowed ? "Cancels this draft. You can then reclaim your NFT." : "Cancels this draft.";
      return snapshot.lotCount === 0n ? "Ends sales now. You can then reclaim your NFT." : REFUNDS;
    case "abortDrawing": return REFUNDS;
    case "reclaimPrize": return RECLAIM_GUIDANCE;
    default: return "";
  }
}

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
      if (block.timestamp >= raffle.salesEnd) return waiting("Sales deadline passed", "Set a new deadline in Edit draft. LABx will review the change.");
      if (!raffle.escrowed) return next(["approvePrize", "escrow"], "NFT not locked yet", "Refresh to check the NFT in your wallet.");
      if (snapshot.admission.status !== "approved") return waiting("Waiting for LABx review", snapshot.admission.status === "changed" ? "Your NFT is locked in. LABx needs to review your changes before you can list it." : "Your NFT is locked in. Once LABx approves, you can list it here.");
      if (snapshot.paused) return waiting("Listing paused", "Your raffle is approved. You can list it when LABx resumes listings.");
      return next(["open"], "Listing unavailable", "Refresh to check the listing requirements.");
    case 1:
      if (block.timestamp < raffle.salesEnd) return snapshot.paused ? waiting("Sales paused", "LABx has paused new sales for now.") : waiting("Your raffle is live", "Buyers can join until sales end. This page moves to the next step when they do.");
      return next(["close"], "Sales have ended", "Refresh to close sales.");
    case 2:
      return next(raffle.snapshotted ? ["requestRandomness"] : ["snapshot"], "Draw not ready", "Check Draw details. Other options are under Advanced.");
    case 3: {
      const abort = block.timestamp >= raffle.vrfRequestedAt + snapshot.randomnessGrace ? enabled("abortDrawing") : undefined;
      if (abort) return { kind: "action", action: abort, message: `The draw didn’t return a result in time. ${REFUNDS}` };
      return waiting("Drawing a winner", "This usually takes a few minutes. This page updates on its own.");
    }
    case 4:
      return next(["settle", "reveal"], "Waiting to finish", "You can finish the raffle after confirming the draw, or 7 days after the draw.");
    case 5:
      if (raffle.principalEscrow === 0n) return waiting("Raffle complete", "Your sales have been paid to your wallet.");
      return next(["claimProceeds"], "Raffle complete", "Your sales have been paid to your wallet.");
    case 6: {
      const refundNote = snapshot.lotCount > 0n ? "Buyers can claim refunds of the membership price." : "No memberships were sold.";
      const reclaim = raffle.escrowed ? enabled("reclaimPrize") : undefined;
      if (reclaim) return { kind: "action", action: reclaim, message: snapshot.lotCount > 0n ? `${RECLAIM_GUIDANCE} ${refundNote}` : RECLAIM_GUIDANCE };
      return waiting("Raffle cancelled", refundNote);
    }
    default:
      return waiting("Raffle state unavailable", "Refresh to load the raffle.");
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
