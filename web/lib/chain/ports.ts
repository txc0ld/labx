import type { ArtworkMetadata } from "./metadata";
import type { Address, Hex } from "viem";
import type {
  AccountRaffleState, BlockRef, Confirmation, DeploymentManifest, DeploymentStatus, HistoryItem, Lot,
  MembershipQuote, Page, PreparedAction, RafflePolicy, RaffleSnapshot, SubmittedAction, WalletSnapshot, WorkflowAction
} from "./types";

export interface WalletSessionPort {
  getSnapshot(): WalletSnapshot;
  subscribe(listener: () => void): () => void;
  connect(): Promise<WalletSnapshot>;
  refresh(): Promise<WalletSnapshot>;
  disconnect(): void;
  assertCurrent(expected: Extract<WalletSnapshot, { kind: "connected" }>): Promise<void>;
  requestTransaction(expected: Extract<WalletSnapshot, { kind: "connected" }>, transaction: { to: Address; data: Hex; value: bigint }): Promise<Hex>;
  signMessage(input: { message: string; expected: Extract<WalletSnapshot, { kind: "connected" }> }): Promise<Hex>;
}

export interface RaffleService {
  readonly manifest: DeploymentManifest;
  attest(): Promise<DeploymentStatus>;
  listRaffles(input?: { cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<RaffleSnapshot>>;
  readRaffle(input: { id: bigint; block?: BlockRef }): Promise<RaffleSnapshot>;
  readArtwork(input: { id: bigint; block?: BlockRef }): Promise<ArtworkMetadata>;
  readAccount(input: { id: bigint; account: Address; block?: BlockRef }): Promise<AccountRaffleState>;
  listLots(input: { id: bigint; cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<Lot>>;
  history(input: { account: Address; fromBlock?: bigint; block?: BlockRef }): Promise<Page<HistoryItem>>;
  openingPolicy(input?: { block?: BlockRef }): Promise<{ policy: RafflePolicy; hash: Hex; block: BlockRef }>;
  quoteMembership(input: { id: bigint; packId: number; quantity: number; slippageBps?: number }): Promise<MembershipQuote>;
  prepare(input: { action: WorkflowAction; wallet: WalletSessionPort }): Promise<PreparedAction>;
  submit(input: { prepared: PreparedAction; wallet: WalletSessionPort }): Promise<SubmittedAction>;
  confirm(input: { transaction: SubmittedAction; timeoutMs?: number }): Promise<Confirmation>;
  resume(input: { hash: Hex; wallet: WalletSessionPort }): Promise<SubmittedAction>;
}

export type BrowserService =
  | { kind: "configured"; service: RaffleService; wallet: WalletSessionPort }
  | { kind: "unavailable"; reason: string; wallet: WalletSessionPort };

// Implemented by browser.ts: configuredBrowserService(): BrowserService.
// Implemented by workflow.ts: availableActions(snapshot, accountState): readonly ActionAvailability[].
// Browser construction uses a reviewed deployment registry. Tests inject their isolated client and manifest.
