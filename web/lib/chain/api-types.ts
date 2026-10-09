import type { Address, Hex } from "viem";
import type { PublicReserve, ReserveRecord } from "../reserve";
export type WorkflowContext = { origin: string; chainId: 11155111 | 31337; contract: Address; termsHash: Hex; termsVersion: string };
export type CommitmentInput = { nft: Address; tokenId: string; publicSummary: string; privateCommitment: string };
export type PreparationRecoveryInput = { requestIdentity: Hex; nft: Address; tokenId: string };
export type AgreementResult = { recorded: true; key: string; termsHash: Hex; version: string };
export type ReceiptInput = { transactionHash: Hex; logIndex: number; to: string };
export type ReceiptResult = { delivered: boolean; repeated?: boolean; reason?: string };
export type RecordsInput = { raffleIds: string[]; purchases: { transactionHash: Hex; logIndex: number }[] };
export type PrivateRecords = {
  agreements: { raffleId: string; recorded: boolean; at: string | null }[];
  receipts: { transactionHash: Hex; logIndex: number; status: "missing" | "pending" | "delivered" }[];
};
export type { PublicReserve, ReserveRecord };
