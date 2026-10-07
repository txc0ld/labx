import type { ContractEventArgsFromTopics, Hex } from "viem";
import type { raffleAbi } from "./abi";

export type SellerFinancialEventName = "PackPurchased" | "ProceedsClaimed" | "FeeClaimed" | "Refunded";

type SellerRaffleActivityByName = {
  [Name in SellerFinancialEventName]: {
    eventName: Name;
    args: ContractEventArgsFromTopics<typeof raffleAbi, Name, true>;
    transactionHash: Hex;
    logIndex: number;
    blockNumber: bigint;
  }
};

export type SellerRaffleActivity = SellerRaffleActivityByName[SellerFinancialEventName];

export function mergeSellerActivityPage(
  previousKind: "loading" | "ready" | "error",
  previous: readonly SellerRaffleActivity[],
  next: readonly SellerRaffleActivity[],
  cursor?: bigint
): readonly SellerRaffleActivity[] {
  return cursor !== undefined && previousKind !== "loading" ? [...previous, ...next] : next;
}
