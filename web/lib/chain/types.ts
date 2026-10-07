import type { Address, Hex, ContractFunctionReturnType } from "viem";
import type { raffleAbi } from "./abi";

export type Raffle = ContractFunctionReturnType<typeof raffleAbi, "view", "getRaffle">;
export type RaffleAccounting = ContractFunctionReturnType<typeof raffleAbi, "view", "getRaffleAccounting">;
export type Pack = ContractFunctionReturnType<typeof raffleAbi, "view", "getPack">;
export type RaffleAdmissionRecord = ContractFunctionReturnType<typeof raffleAbi, "view", "getRaffleAdmission">;
export type AdmissionStatus =
  | { status: "pending" | "changed" | "approved"; reviewHash: Hex; record: RaffleAdmissionRecord }
  | { status: "opened" | "not-opened"; reviewHash: null; record: RaffleAdmissionRecord };
export type OwnerReviewAttestations = { canonicalProvenance: true; transferRestrictions: true; drawFunding: true };
export type OwnerAction =
  | { kind: "approveRaffle"; id: bigint; expectedReviewHash: Hex; attestations: OwnerReviewAttestations }
  | { kind: "revokeRaffleApproval"; id: bigint; expectedReviewHash: Hex };
export type AdmissionReview = {
  snapshot: RaffleSnapshot; policy: RafflePolicy; policyHash: Hex | null;
  ownerGeneration: bigint; openingPolicyGeneration: bigint;
  nftCodeHash: Hex | null;
  custody: { kind: "held" | "not-held"; owner: Address } | { kind: "unknown" };
};
export type OwnerExecutionIntent = {
  action: OwnerAction; chainId: number; from: Address; to: Address; value: 0n; data: Hex;
  reviewBlock: BlockRef; ownerGeneration: bigint; openingPolicyGeneration: bigint; reviewRevision: bigint;
};
export type OwnerExecutionConfirmation =
  | { kind: "pending"; hash: Hex }
  | { kind: "executed"; hash: Hex; blockNumber: bigint; state: "approved" | "revoked" | "stale"; review: AdmissionReview };
export type RafflePolicy = ContractFunctionReturnType<typeof raffleAbi, "view", "getRafflePolicy">;
export type Lot = ContractFunctionReturnType<typeof raffleAbi, "view", "lotAt">;
export type BlockRef = { number: bigint; hash: Hex; timestamp: bigint };
export type DeploymentManifest = {
  chainId: 11155111 | 31337;
  address: Address;
  runtimeCodeHash: Hex;
  version: 3;
  deploymentBlock: bigint;
  usdc: Address;
};
export type DeploymentStatus =
  | { kind: "verified"; manifest: DeploymentManifest; block: BlockRef }
  | { kind: "unavailable" | "legacy" | "mismatch"; reason: string };
export type RaffleSnapshot = {
  id: bigint; block: BlockRef; raffle: Raffle; packs: readonly Pack[]; policy: RafflePolicy;
  lotCount: bigint; paused: boolean; owner: Address; ethEnabled: boolean;
  admission: AdmissionStatus;
  accounting: RaffleAccounting; drawStartGrace: bigint; randomnessGrace: bigint; revealGrace: bigint;
};
export type Page<T, Cursor = bigint> = { items: readonly T[]; nextCursor: Cursor | null; block: BlockRef };
export type AccountRaffleState = {
  account: Address; snapshot: RaffleSnapshot; principal: bigint; fee: bigint;
  usdcBalance: bigint; usdcAllowance: bigint; nftOwner: Address | null; nftApproved: boolean;
};
export type HistoryItem = {
  raffleId: bigint; event: "PackPurchased" | "PrizeClaimed" | "ProceedsClaimed" | "FeeClaimed" | "Refunded" | "PrizeReclaimed";
  transactionHash: Hex; logIndex: number; blockNumber: bigint; account: Address;
  principal: bigint; fee: bigint; quantity: number; bonusEntries: number;
};
export type DraftInput = {
  nft: Address; tokenId: bigint; salesEnd: bigint; reserveNonce: Hex; reserveCommit: Hex; title: string;
  packs: readonly { name: string; priceUsdc: bigint; bonusEntries: number; maxSupply: number }[];
};
export type WorkflowAction =
  | OwnerAction
  | { kind: "createDraft"; draft: DraftInput }
  | { kind: "updateDraft"; id: bigint; draft: DraftInput }
  | { kind: "approvePrize" | "escrow" | "close" | "requestRandomness" | "settle" | "claimPrize" | "claimProceeds" | "claimFee" | "cancel" | "abortDrawing" | "reclaimPrize" | "refund"; id: bigint }
  | { kind: "open"; id: bigint; expectedPolicyHash: Hex }
  | { kind: "snapshot"; id: bigint; maxSteps: bigint }
  | { kind: "reveal"; id: bigint; publicHash: Hex; privateHash: Hex; salt: Hex }
  | { kind: "approveUsdc"; id: bigint; packId: number; quantity: number }
  | { kind: "buyMembership"; id: bigint; packId: number; quantity: number; acceptedTerms: Hex;
      agreements: { terms: true; rules: true; age: true };
      payment: { kind: "usdc" } | { kind: "eth"; maxEth: bigint; slippageBps: number; deadline: bigint } };
export type ActionKind = WorkflowAction["kind"];
export type ActionAvailability = { kind: ActionKind; label: string; enabled: boolean; reason: string };
export type MembershipQuote = {
  principal: bigint; fee: bigint; totalUsdc: bigint; bonusEntries: bigint; block: BlockRef;
  eth: { kind: "available"; requiredEth: bigint; maxEth: bigint; slippageBps: number; deadline: bigint } | { kind: "unavailable"; reason: string };
};
export type WalletSnapshot =
  | { kind: "disconnected"; revision: number }
  | { kind: "connected"; account: Address; chainId: number; revision: number };
export type PreparedAction = {
  readonly action: WorkflowAction; readonly account: Address; readonly chainId: number;
  readonly to: Address; readonly value: bigint; readonly data: Hex;
  readonly title: string; readonly amountUsdc: bigint; readonly recipient: Address;
  readonly block: BlockRef; readonly walletRevision: number;
};
export type SubmittedAction = { hash: Hex; account: Address; chainId: number; to: Address; data: Hex; value: bigint };
export type Confirmation =
  | { kind: "pending"; hash: Hex }
  | { kind: "reverted" | "replaced"; hash: Hex; reason: string }
  | { kind: "confirmed"; hash: Hex; blockNumber: bigint; replacedHash: Hex | null };
export type WalletProvider = {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

export const CATALOG_PAGE_LIMIT = 24;
