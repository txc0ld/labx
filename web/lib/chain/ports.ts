import type { ArtworkMetadata } from "./metadata";
import type { Address, Hex } from "viem";
import type {
  ActionTrustInput, AdmissionReview, OwnerExecutionIntent, OwnerExecutionConfirmation, AccountRaffleState, BlockRef, CanonicalReceipt, ObservedTransaction, OutcomeInspection, OutcomeJournal, OutcomeLineage, Confirmation, DeploymentManifest, DeploymentStatus, HistoryItem, Lot,
  MembershipQuote, Page, PreparedAction, RafflePolicy, RaffleSnapshot, SubmittedAction, WalletSnapshot, WorkflowAction
} from "./types";
import type { SellerRaffleActivity } from "./seller-types";

import type { ConnectionOption, ConnectionStatus, WalletConnectOptions } from "./wallet-connectors";

export interface WalletSessionPort {
  readonly connectionOptions?: readonly ConnectionOption[];
  getConnectionStatus?(): ConnectionStatus;
  getSnapshot(): WalletSnapshot;
  subscribe(listener: () => void): () => void;
  connect(options?: WalletConnectOptions): Promise<WalletSnapshot>;
  cancelConnection?(owner: object): void;
  refresh(): Promise<WalletSnapshot>;
  disconnect(): void;
  assertCurrent(expected: Extract<WalletSnapshot, { kind: "connected" }>): Promise<void>;
  requestTransaction(expected: Extract<WalletSnapshot, { kind: "connected" }>, transaction: { to: Address; data: Hex; value: bigint; nonce?: number }, beforeRequest?: () => Promise<void>, onProviderRequest?: () => void): Promise<Hex>;
  signMessage(input: { message: string; expected: Extract<WalletSnapshot, { kind: "connected" }> }): Promise<Hex>;
}

export interface RaffleService {
  readonly manifest: DeploymentManifest;
  attest(): Promise<DeploymentStatus>;
  assertActionTrust(input: ActionTrustInput): Promise<void>;
  listRaffles(input?: { cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<RaffleSnapshot>>;
  listSellerRaffles(input: { seller: Address; cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<RaffleSnapshot>>;
  listRaffleActivity(input: { id: bigint; cursor?: bigint; block?: BlockRef }): Promise<Page<SellerRaffleActivity>>;
  readOwner(input?: { block?: BlockRef }): Promise<{ owner: Address; block: BlockRef }>;
  listOwnerQueue(input?: { cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<RaffleSnapshot>>;
  readAdmission(input: { id: bigint; block?: BlockRef }): Promise<AdmissionReview>;
  exportOwnerExecution(input: { prepared: PreparedAction; wallet: WalletSessionPort }): Promise<OwnerExecutionIntent>;
  confirmOwnerExecution(input: { intent: OwnerExecutionIntent; hash: Hex; timeoutMs?: number }): Promise<OwnerExecutionConfirmation>;
  readRaffle(input: { id: bigint; block?: BlockRef }): Promise<RaffleSnapshot>;
  readArtwork(input: { id: bigint; block?: BlockRef }): Promise<ArtworkMetadata>;
  readAccount(input: { id: bigint; account: Address; block?: BlockRef }): Promise<AccountRaffleState>;
  listLots(input: { id: bigint; cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<Lot>>;
  history(input: { account: Address; fromBlock?: bigint; block?: BlockRef }): Promise<Page<HistoryItem>>;
  openingPolicy(input?: { block?: BlockRef }): Promise<{ policy: RafflePolicy; hash: Hex; block: BlockRef }>;
  quoteMembership(input: { id: bigint; packId: number; quantity: number; slippageBps?: number }): Promise<MembershipQuote>;
  prepare(input: { action: WorkflowAction; wallet: WalletSessionPort }): Promise<PreparedAction>;
  submit(input: { prepared: PreparedAction; wallet: WalletSessionPort }): Promise<SubmittedAction>;
  confirm(input: { transaction: SubmittedAction; timeoutMs?: number; beforeJournalWatch?: (input: { transaction: ObservedTransaction; pending: OutcomeJournal }) => void; beforeJournalClear?: (input: { receipt: CanonicalReceipt; pending: OutcomeJournal | null }) => void }): Promise<Confirmation>;
  inspectOutcome(input: { hash: Hex; account: Address; timeoutMs?: number }): Promise<OutcomeInspection>;
  captureOutcomeLineage(input: { account: Address; hash: Hex }): OutcomeLineage | null;
  retainOutcome(input: { receipt: CanonicalReceipt; lineage?: OutcomeLineage; retain: (input: { priorHash: Hex | null }) => void }): Promise<void>;
  acknowledgeOutcome(input: { receipt: CanonicalReceipt; acknowledge: () => void }): Promise<void>;
  pending(input: { wallet: WalletSessionPort }): Promise<OutcomeJournal | null>;
  resume(input: { hash: Hex; wallet: WalletSessionPort; expectedJournal?: OutcomeJournal; beforeJournalUpdate?: (input: { transaction: SubmittedAction; nonce: number; pending: OutcomeJournal }) => void }): Promise<SubmittedAction | null>;
}

export type BrowserService =
  | { kind: "configured"; service: RaffleService; wallet: WalletSessionPort }
  | { kind: "unavailable"; reason: string; wallet: WalletSessionPort };

// Implemented by browser.ts: configuredBrowserService(): BrowserService.
// Implemented by workflow.ts: availableActions(snapshot, accountState): readonly ActionAvailability[].
// Browser construction uses a reviewed deployment registry. Tests inject their isolated client and manifest.
