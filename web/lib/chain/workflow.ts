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
      add("escrow", "Escrow NFT", seller && !!account?.nftApproved, "Approve the NFT before escrow.");
    } else add("open", "Open memberships", seller && snapshot.admission.status === "approved" && !snapshot.paused && now < r.salesEnd, "LABx must approve the current draft before the seller opens sales.");
    add("cancel", "Cancel draft", seller || operator, "Only the seller or operator can cancel a draft.");
  }
  if (r.phase === 1) {
    add("approveUsdc", "Approve exact USDC", !snapshot.paused && now < r.salesEnd && snapshot.packs.some(p => p.active && p.sold < p.maxSupply), "Membership sales are paused, ended or sold out.");
    add("buyMembership", "Choose membership", !snapshot.paused && now < r.salesEnd && snapshot.packs.some(p => p.active && p.sold < p.maxSupply), "Membership sales are paused, ended or sold out.");
    add("close", "Close sales", now >= r.salesEnd, "Sales close at the published deadline.");
  }
  if (r.phase === 2) {
    if (!r.snapshotted) add("snapshot", "Freeze next entries", true, "");
    else add("requestRandomness", "Start draw", r.snapshotTotal > 0n && now < r.salesEnd + snapshot.drawStartGrace, "Anyone can start a completed nonempty draw before its deadline.");
  }
  if (r.phase === 1 || r.phase === 2) add("cancel", "Enable refunds", now >= r.salesEnd + snapshot.drawStartGrace || (seller || operator) && (snapshot.lotCount === 0n || r.phase === 2 && r.snapshotted && r.snapshotTotal === 0n), "Purchased memberships prevent discretionary cancellation. Timed recovery becomes available after the draw-start deadline.");
  if (r.phase === 3) add("abortDrawing", "Enable refunds", now >= r.vrfRequestedAt + snapshot.randomnessGrace, "Wait until the fixed randomness deadline.");
  if (r.phase >= 1 && r.phase <= 4 && !r.revealed) add("reveal", "Reveal commitment", seller || operator, "Only the seller or operator can reveal a matching commitment.");
  if (r.phase === 4) add("settle", "Settle raffle", r.revealed || now >= r.drawnAt + snapshot.revealGrace, "Settlement is available after reveal or the seven-day grace.");
  if (r.phase === 5) {
    add("claimPrize", "Claim NFT", winner && r.escrowed, "Only the recorded winner can claim an unclaimed NFT.");
    add("claimProceeds", "Claim proceeds", seller && r.principalEscrow > 0n, "Only the seller can claim remaining membership proceeds.");
    add("claimFee", "Send protocol fees", r.feeEscrow > 0n, "The protocol fees have already been claimed.");
  }
  if (r.phase === 6) {
    add("claimFee", "Send retained processing fees", r.feeEscrow > 0n, "The processing fees have already been claimed.");
    add("refund", "Claim refund", !!account && account.principal > 0n, "This wallet has no remaining refund.");
    add("reclaimPrize", "Reclaim NFT", seller && r.escrowed, "Only the seller can reclaim an unclaimed NFT.");
  }
  return actions.map(action => trustReason && ["approveRaffle", "open", "approveUsdc", "buyMembership"].includes(action.kind)
    ? { ...action, enabled: false, reason: trustReason } : action);
}
