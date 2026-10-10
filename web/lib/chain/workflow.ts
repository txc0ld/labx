import type { AccountRaffleState, ActionAvailability, ActionKind, RaffleSnapshot } from "./types";
import { sameAddress } from "./validation";
export function availableActions(snapshot: RaffleSnapshot, account: AccountRaffleState | null, trustReason: string | null = null): readonly ActionAvailability[] {
  const r = snapshot.raffle, now = snapshot.block.timestamp;
  const seller = !!account && sameAddress(account.account, r.seller);
  const winner = !!account && sameAddress(account.account, r.winner);
  const operator = !!account && sameAddress(account.account, snapshot.owner);
  const actions: ActionAvailability[] = [];
  const add = (kind: ActionKind, label: string, permitted: boolean, reason: string) => actions.push({ kind, label, enabled: !!account && permitted, reason: !account ? "Connect your wallet." : permitted ? "" : reason });
  if (r.phase === 0) {
    add("approveRaffle", "Review prize and draw funding", operator && r.escrowed && now < r.salesEnd, "The current LABx owner can review an escrowed draft before its deadline.");
    add("revokeRaffleApproval", "Revoke draft approval", operator && snapshot.admission.record.approvedReviewHash !== "0x" + "0".repeat(64), "Only the current LABx owner can revoke an existing draft approval.");
    add("updateDraft", "Edit draft", seller, "Only the seller can edit this draft.");
    if (!r.escrowed) {
      add("approvePrize", "Approve NFT", seller && !!account?.nftOwner && sameAddress(account.nftOwner, r.seller) && !account.nftApproved, "The seller must own this NFT; an existing approval needs no repeat.");
      add("escrow", "Lock NFT", seller && !!account?.nftApproved, "Approve the NFT before locking it.");
    } else add("open", "List", seller && snapshot.admission.status === "approved" && !snapshot.paused && now < r.salesEnd, "LABx must approve this draft before you can list it.");
    add("cancel", "Cancel draft", seller || operator, "Only the seller or operator can cancel a draft.");
  }
  if (r.phase === 1) {
    add("approveUsdc", "Approve exact USDC", !snapshot.paused && now < r.salesEnd && snapshot.packs.some(p => p.active && p.sold < p.maxSupply), "Membership sales are paused, ended or sold out.");
    add("buyMembership", "Choose membership", !snapshot.paused && now < r.salesEnd && snapshot.packs.some(p => p.active && p.sold < p.maxSupply), "Membership sales are paused, ended or sold out.");
    add("close", "Close sales", now >= r.salesEnd, "Sales can close once the deadline passes.");
  }
  if (r.phase === 2) {
    if (!r.snapshotted) add("snapshot", "Count entries", true, "");
    else add("requestRandomness", "Start draw", r.snapshotTotal > 0n && now < r.salesEnd + snapshot.drawStartGrace, "The draw can start after entries are counted, before the draw-start deadline.");
  }
  if (r.phase === 1 || r.phase === 2) add("cancel", snapshot.lotCount === 0n ? "Cancel raffle" : "Enable refunds", now >= r.salesEnd + snapshot.drawStartGrace || (seller || operator) && (snapshot.lotCount === 0n || r.phase === 2 && r.snapshotted && r.snapshotTotal === 0n), "Memberships have been sold, so the raffle can’t be cancelled now. Refunds open if the draw hasn’t started by its deadline.");
  if (r.phase === 3) add("abortDrawing", "Enable refunds", now >= r.vrfRequestedAt + snapshot.randomnessGrace, "Refunds open if the draw result doesn’t arrive by its deadline.");
  if (r.phase >= 1 && r.phase <= 4 && !r.revealed) add("reveal", "Confirm the draw", seller || operator, "Only the seller or LABx can confirm the draw.");
  if (r.phase === 4) add("settle", "Finish raffle", r.revealed || now >= r.drawnAt + snapshot.revealGrace, "The raffle can finish once the seller confirms the draw, or 7 days after the draw.");
  if (r.phase === 5) {
    add("claimPrize", "Claim your NFT", winner && r.escrowed, "Only the winner can claim the NFT.");
    add("claimProceeds", "Claim USDC", seller && r.principalEscrow > 0n, "Only the seller can claim the sales.");
    add("claimFee", "Send LABx fees", r.feeEscrow > 0n, "LABx fees have already been sent.");
  }
  if (r.phase === 6) {
    add("claimFee", "Send LABx fees", r.feeEscrow > 0n, "LABx fees have already been sent.");
    add("refund", "Claim refund", !!account && account.principal > 0n, "This wallet has no remaining refund.");
    add("reclaimPrize", "Reclaim NFT", seller && r.escrowed, "Only the seller can reclaim the NFT.");
  }
  return actions.map(action => trustReason && ["approveRaffle", "open", "approveUsdc", "buyMembership"].includes(action.kind)
    ? { ...action, enabled: false, reason: trustReason } : action);
}
