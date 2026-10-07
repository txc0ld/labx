import type { Address } from "viem";
import { sellerAccounting } from "./fees";
import type { RaffleService } from "./ports";
import type { BlockRef, RaffleSnapshot } from "./types";

type SellerPortfolioSource = Pick<RaffleService, "listSellerRaffles">;

export type SellerPortfolioScan =
  | { kind: "complete"; raffles: readonly RaffleSnapshot[]; block: BlockRef }
  | { kind: "incomplete"; raffles: readonly RaffleSnapshot[]; block: BlockRef | null; message: string }
  | { kind: "stale" };

export async function scanSellerPortfolio({ service, seller, isCurrent, onProgress }: {
  service: SellerPortfolioSource;
  seller: Address;
  isCurrent: () => boolean;
  onProgress?: (raffles: readonly RaffleSnapshot[], block: BlockRef, nextCursor: bigint | null) => void;
}): Promise<SellerPortfolioScan> {
  let cursor: bigint | undefined;
  let block: BlockRef | undefined;
  let raffles: readonly RaffleSnapshot[] = [];

  try {
    do {
      const page = await service.listSellerRaffles({ seller, cursor, limit: 24, block });
      if (!isCurrent()) return { kind: "stale" };
      if (block && page.block.hash !== block.hash) throw new Error("Chain state changed during the seller scan.");
      block ??= page.block;
      raffles = [...raffles, ...page.items];
      onProgress?.(raffles, block, page.nextCursor);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  } catch (error) {
    if (!isCurrent()) return { kind: "stale" };
    return {
      kind: "incomplete",
      raffles,
      block: block ?? null,
      message: error instanceof Error ? error.message : "The seller portfolio scan could not be completed."
    };
  }

  if (!block) throw new Error("Seller scan completed without a pinned block.");
  return { kind: "complete", raffles, block };
}

export function sellerPortfolioTotals(raffles: readonly RaffleSnapshot[]) {
  return raffles.reduce((totals, snapshot) => {
    const accounting = sellerAccounting(snapshot);
    return {
      grossPrincipal: totals.grossPrincipal + accounting.grossPrincipal,
      buyerFees: totals.buyerFees + accounting.buyerFees,
      earnedNetProceeds: totals.earnedNetProceeds + accounting.netProceeds,
      claimableProceeds: totals.claimableProceeds + accounting.claimableProceeds,
      paidProceeds: totals.paidProceeds + accounting.paidProceeds,
      pendingPrincipal: totals.pendingPrincipal + accounting.pendingPrincipal,
      refundLiability: totals.refundLiability + accounting.refundLiability,
      escrowHeld: totals.escrowHeld + accounting.escrowHeld
    };
  }, {
    grossPrincipal: 0n,
    buyerFees: 0n,
    earnedNetProceeds: 0n,
    claimableProceeds: 0n,
    paidProceeds: 0n,
    pendingPrincipal: 0n,
    refundLiability: 0n,
    escrowHeld: 0n
  });
}
