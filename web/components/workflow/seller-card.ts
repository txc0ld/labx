import type { Address } from "viem";
import { CANCEL_AND_RECLAIM, drawBlocker, sellerNextStep, sellerPortalActions, type SellerActionKind } from "@/lib/chain/seller-actions";
import type { RaffleSnapshot } from "@/lib/chain/types";
import { availableActions } from "@/lib/chain/workflow";
import { drawRunnerEnabled } from "@/lib/draw-runner";
import { formatUsdcAmount } from "./usdc-amount";

export type CardStep = { label: string; status: string };

const CARD_STEPS: Partial<Record<SellerActionKind, (snapshot: RaffleSnapshot) => CardStep>> = {
  open: () => ({ label: "List", status: "Approved by LABx" }),
  close: () => ({ label: "Close sales", status: "Sales ended" }),
  snapshot: () => ({ label: "Count entries", status: "Sales closed" }),
  requestRandomness: () => ({ label: "Start draw", status: "Entries counted" }),
  reveal: () => ({ label: "Confirm the draw", status: "Winner drawn" }),
  settle: ({ raffle }) => ({ label: "Finish raffle", status: raffle.revealed ? "Draw confirmed" : "Winner drawn" }),
  claimProceeds: ({ raffle }) => ({ label: `Claim ${formatUsdcAmount(raffle.principalEscrow)} USDC`, status: "Raffle finished" }),
  // The card only offers cancellation once no draw can happen.
  cancel: snapshot => ({ label: snapshot.lotCount === 0n ? CANCEL_AND_RECLAIM : "Enable refunds", status: drawBlocker(snapshot) ?? "Sales ended" }),
  abortDrawing: () => ({ label: "Enable refunds", status: "The draw timed out" }),
  reclaimPrize: () => ({ label: "Reclaim NFT", status: "Raffle cancelled" })
};

/** The card's button and one-line status, from the same next step the raffle page shows. */
export function cardNextStep(snapshot: RaffleSnapshot, seller: Address, runner = drawRunnerEnabled()): CardStep {
  const { raffle, block } = snapshot;
  // Same order as sellerNextStep: an expired draft needs a new deadline before its NFT can be locked.
  if (raffle.phase === 0 && !raffle.escrowed && block.timestamp < raffle.salesEnd) return { label: "Finish creating", status: "Prize not locked yet" };
  // Portfolio reads carry no NFT ownership or approval; the raffle page reads both before any NFT step.
  const account = { account: seller, snapshot, principal: 0n, fee: 0n, usdcBalance: 0n, usdcAllowance: 0n, nftOwner: null, nftApproved: false };
  const next = sellerNextStep(snapshot, sellerPortalActions(availableActions(snapshot, account)), runner);
  if (next.kind === "waiting") return { label: "View", status: next.title };
  if (next.kind === "automatic") return { label: "View", status: next.message };
  return CARD_STEPS[next.action.kind]?.(snapshot) ?? { label: "View", status: next.action.label };
}
