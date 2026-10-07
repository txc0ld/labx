import type { RaffleSnapshot } from "./types";

export const BUYER_FEE_BPS = 200;
export const SELLER_FEE_BPS = 200;
export const FEE_DENOMINATOR = 10_000n;
export const MAX_MEMBERSHIP_TOTAL_USDC = 20_400_000_000_000n;

// Round once on the whole purchase, after multiplying price by quantity.
export function buyerFee(principal: bigint, buyerFeeBps: number): bigint {
  if (principal < 0n || !Number.isInteger(buyerFeeBps) || buyerFeeBps < 0 || buyerFeeBps > 65_535) throw new Error("Invalid fee inputs.");
  return principal * BigInt(buyerFeeBps) / FEE_DENOMINATOR;
}

export function sellerAccounting(snapshot: RaffleSnapshot) {
  const { grossPrincipal, buyerFees } = snapshot.accounting;
  const { principalEscrow, feeEscrow, phase } = snapshot.raffle;
  const settled = phase === 5, cancelled = phase === 6;
  const sellerCommission = settled ? grossPrincipal * BigInt(snapshot.policy.sellerFeeBps) / FEE_DENOMINATOR : 0n;
  const netProceeds = settled ? grossPrincipal - sellerCommission : 0n;
  return {
    grossPrincipal, buyerFees, sellerCommission, netProceeds,
    claimableProceeds: settled ? principalEscrow : 0n,
    paidProceeds: settled ? netProceeds - principalEscrow : 0n,
    escrowHeld: principalEscrow + feeEscrow,
    pendingPrincipal: phase >= 1 && phase <= 4 ? principalEscrow : 0n,
    refundLiability: cancelled ? principalEscrow + feeEscrow : 0n,
    refundedPrincipal: cancelled ? grossPrincipal - principalEscrow : 0n,
    refundedBuyerFees: cancelled ? buyerFees - feeEscrow : 0n
  };
}
