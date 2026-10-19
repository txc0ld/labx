import type { ArtworkMetadata } from "./metadata";
import type { Address, Hex } from "viem";
import type {
  SubmissionCheckpoint, DraftInput, ExternalExecutionReference, ActionTrustInput, AdmissionReview, OwnerExecutionIntent, OwnerExecutionConfirmation, AccountRaffleState, BlockRef, CanonicalReceipt, ObservedTransaction, OutcomeInspection, OutcomeJournal, OutcomeLineage, Confirmation, DeploymentManifest, DeploymentStatus, HistoryItem, Lot,
  MembershipQuote, Page, PendingSettlement, PreparedAction, RafflePolicy, RaffleSnapshot, SubmittedAction, WalletSnapshot, WorkflowAction
} from "./types";
import type { SellerRaffleActivity } from "./seller-types";
import type { DrawFunding } from "./vrf-funding";
import type { OwnerExecutionDiscoveryCursor, OwnerExecutionDiscoveryPage } from "./owner-execution-discovery";

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
  /** maxFeePerGas and maxPriorityFeePerGas are the network's fee suggestion, which a wallet may use in place of its own. */
  requestTransaction(expected: Extract<WalletSnapshot, { kind: "connected" }>, transaction: { to: Address; data: Hex; value: bigint; nonce?: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }, beforeRequest?: () => Promise<void>, onProviderRequest?: () => void): Promise<Hex>;
  requestExternalExecution?(expected: Extract<WalletSnapshot, { kind: "connected" }>, transaction: { to: Address; data: Hex; value: bigint }, beforeRequest: () => Promise<void>, onProviderRequest: () => void): Promise<ExternalExecutionReference>;
  signMessage(input: { message: string; assertIntent?: () => void; expected: Extract<WalletSnapshot, { kind: "connected" }> }): Promise<Hex>;
}

export interface RaffleService {
  readonly manifest: DeploymentManifest;
  attest(): Promise<DeploymentStatus>;
  assertActionTrust(input: ActionTrustInput): Promise<void>;
  listRaffles(input?: { cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<RaffleSnapshot>>;
  listSellerRaffles(input: { seller: Address; cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<RaffleSnapshot>>;
  /** Newest first, ending at `cursor` (the latest block by default): 2,000-block windows back to the first with activity, at most 10 per call, ending at the raffle's creation. */
  listRaffleActivity(input: { id: bigint; cursor?: bigint; block?: BlockRef }): Promise<Page<SellerRaffleActivity>>;
  readOwner(input?: { block?: BlockRef }): Promise<{ owner: Address; block: BlockRef }>;
  readNftOwner(input: { nft: Address; tokenId: bigint }): Promise<{ owner: Address; block: BlockRef }>;
  listOwnerQueue(input?: { cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<RaffleSnapshot>>;
  readAdmission(input: { id: bigint; block?: BlockRef }): Promise<AdmissionReview>;
  resolveCreatedDraft(input: { receipt: CanonicalReceipt; draft: DraftInput }): Promise<RaffleSnapshot>;
  requestOwnerExecution(input: { prepared: PreparedAction; wallet: WalletSessionPort; beforeRequest: (intent: OwnerExecutionIntent) => Promise<void>; assertIntent: () => void }): Promise<ExternalExecutionReference>;
  exportOwnerExecution(input: { prepared: PreparedAction; wallet: WalletSessionPort }): Promise<OwnerExecutionIntent>;
  discoverOwnerExecutions(input: { intent: OwnerExecutionIntent; cursor?: OwnerExecutionDiscoveryCursor; timeoutMs?: number }): Promise<OwnerExecutionDiscoveryPage>;
  confirmOwnerExecution(input: { intent: OwnerExecutionIntent; hash: Hex; timeoutMs?: number }): Promise<OwnerExecutionConfirmation>;
  readRaffle(input: { id: bigint; block?: BlockRef }): Promise<RaffleSnapshot>;
  readArtwork(input: { id: bigint; block?: BlockRef }): Promise<ArtworkMetadata>;
  readAccount(input: { id: bigint; account: Address; block?: BlockRef }): Promise<AccountRaffleState>;
  listLots(input: { id: bigint; cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<Lot>>;
  /** Newest first: one 2,000-block page ending at `toBlock`, the latest block by default. */
  history(input: { account: Address; toBlock?: bigint; block?: BlockRef }): Promise<Page<HistoryItem>>;
  /** Block time of the raffle's Revealed event at or before `block`. Rejects when it cannot find or check one. */
  readRevealTime(input: { id: bigint; block: BlockRef }): Promise<bigint>;
  openingPolicy(input?: { block?: BlockRef }): Promise<{ policy: RafflePolicy; hash: Hex; block: BlockRef }>;
  /** The VRF subscription's native balance against what Chainlink needs before it answers a draw under `policy`. */
  drawFunding(input: { policy: RafflePolicy; block?: BlockRef }): Promise<DrawFunding>;
  quoteMembership(input: { id: bigint; packId: number; quantity: number; slippageBps?: number }): Promise<MembershipQuote>;
  prepare(input: { action: WorkflowAction; wallet: WalletSessionPort; expectedDraft?: DraftInput }): Promise<PreparedAction>;
  submit(input: { prepared: PreparedAction; wallet: WalletSessionPort; assertIntent?: () => void; beforeRequest?: (checkpoint: SubmissionCheckpoint) => void; onNotDispatched?: (checkpoint: SubmissionCheckpoint) => void }): Promise<SubmittedAction>;
  confirm(input: { transaction: SubmittedAction; timeoutMs?: number; beforeJournalWatch?: (input: { transaction: ObservedTransaction; pending: OutcomeJournal }) => void; beforeJournalClear?: (input: { receipt: CanonicalReceipt; pending: OutcomeJournal | null }) => void }): Promise<Confirmation>;
  inspectOutcome(input: { hash: Hex; account: Address; timeoutMs?: number }): Promise<OutcomeInspection>;
  captureOutcomeLineage(input: { account: Address; hash: Hex }): OutcomeLineage | null;
  retainOutcome(input: { receipt: CanonicalReceipt; lineage?: OutcomeLineage; retain: (input: { priorHash: Hex | null }) => void }): Promise<void>;
  acknowledgeOutcome(input: { receipt: CanonicalReceipt; acknowledge: () => void }): Promise<void>;
  pending(input: { wallet: WalletSessionPort; expectedIntent?: Hex }): Promise<OutcomeJournal | null>;
  resume(input: { hash: Hex; wallet: WalletSessionPort; expectedJournal?: OutcomeJournal; beforeJournalUpdate?: (input: { transaction: SubmittedAction; nonce: number; pending: OutcomeJournal }) => void }): Promise<SubmittedAction | null>;
  /** Reads the chain for `expected`, a pending record without a hash, and clears exactly that record when the chain shows its send can no longer be mined. continueUnsent also clears it when nothing is at its nonce. */
  settlePending(input: { wallet: WalletSessionPort; expected: OutcomeJournal; continueUnsent?: boolean }): Promise<PendingSettlement>;
}

export type BrowserService =
  | { kind: "configured"; service: RaffleService; wallet: WalletSessionPort }
  | { kind: "unavailable"; reason: string; wallet: WalletSessionPort };

// Implemented by browser.ts: configuredBrowserService(): BrowserService.
// Implemented by workflow.ts: availableActions(snapshot, accountState): readonly ActionAvailability[].
// Browser construction uses a reviewed deployment registry. Tests inject their isolated client and manifest.
