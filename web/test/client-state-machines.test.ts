import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, TransactionNotFoundError, type Hex, type PublicClient } from "viem";
import { encodeDraft, finishCreate, type CreateRecord } from "../lib/chain/create-flow";
import { memoryPendingJournal } from "../lib/chain/pending-journal";
import { createRaffleService } from "../lib/chain/service";
import { STANDARD_MEMBERSHIP_TIERS } from "../lib/membership-tiers";
import type { WalletSessionPort } from "../lib/chain/ports";
import type { DeploymentManifest, DraftInput, WalletSnapshot } from "../lib/chain/types";
import { fixtureTrust } from "./fixtures/deployment";

/** The sequences of docs/audits/state-machines.part-client.md that run without a browser or a local chain. */

const SELLER = "0x0dae6E01A88826b4E77d717d9639B64F749C0152";
const CONTRACT = "0x8b0332D0ca48908e174F42eA1b3123e63f3F4327";
const NFT = "0x4444444444444444444444444444444444444444";
const CODE = "0x6001";
const CREATION = `0x${"c1".repeat(32)}` as const;
const manifest: DeploymentManifest = { ...fixtureTrust, chainId: 11155111, version: 3, address: CONTRACT, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", runtimeCodeHash: keccak256(CODE), deploymentBlock: 1n };
const blockHash = (number: bigint): Hex => `0x${number.toString(16).padStart(64, "0")}`;

/**
 * A chain that answers the reads Create makes to prepare and send a draft, to settle a lost step from the seller's nonces
 * and to find the draft's RaffleCreated event. It has no receipts, so a found draft stops at its confirmation.
 */
function sellerChain() {
  const state = { block: 100n, latest: 7, pending: 7, created: null as { hash: Hex; nonce: number } | null };
  const client = {
    async getBlock({ blockNumber }: { blockNumber?: bigint } = {}) {
      const number = blockNumber ?? state.block;
      return { number, hash: blockHash(number), timestamp: 1_800_000_000n + number, baseFeePerGas: 1_000_000_000n };
    },
    async getBlockNumber() { return state.block; },
    async getChainId() { return manifest.chainId; },
    async getCode({ address }: { address: string }) { return address.toLowerCase() === CONTRACT.toLowerCase() ? CODE : undefined; },
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "contractVersion") return 3n;
      if (functionName === "usdc") return manifest.usdc;
      if (functionName === "ownerOf") return SELLER;
      throw new Error(`No ${functionName} read in this test.`);
    },
    async call() { return { data: "0x" }; },
    async estimateMaxPriorityFeePerGas() { return 1_000_000n; },
    async getBalance() { return 10n ** 18n; },
    async estimateGas() { return 300_000n; },
    async getTransactionCount({ blockTag, blockNumber }: { blockTag?: "latest" | "pending"; blockNumber?: bigint }) {
      return blockNumber !== undefined || blockTag === "latest" ? state.latest : state.pending;
    },
    async getLogs() { return state.created ? [{ removed: false, transactionHash: state.created.hash }] : []; },
    async getTransaction({ hash }: { hash: Hex }) {
      if (state.created?.hash !== hash) throw new TransactionNotFoundError({ hash });
      return { hash, from: SELLER, nonce: state.created.nonce, to: CONTRACT, value: 0n, blockNumber: state.block - 2n, blockHash: blockHash(state.block - 2n) };
    },
    async getTransactionReceipt() { throw new Error("This RPC has no receipts."); }
  } as unknown as PublicClient;
  return { client, state };
}

/** A seller wallet whose first transaction request fails with `failure` after the wallet was asked, and whose later ones are rejected. */
function sellerWallet(failure: unknown) {
  const snapshot: WalletSnapshot = { kind: "connected", account: SELLER, chainId: manifest.chainId, revision: 1 };
  const requests: { data: Hex; nonce: number | undefined }[] = [];
  const wallet: WalletSessionPort = {
    getSnapshot: () => snapshot, subscribe: () => () => {}, connect: async () => snapshot, refresh: async () => snapshot, disconnect: () => {},
    assertCurrent: async () => {}, signMessage: async () => { throw new Error("No signatures in this test."); },
    async requestTransaction(_expected, transaction, beforeRequest, onProviderRequest) {
      await beforeRequest?.();
      onProviderRequest?.();
      requests.push({ data: transaction.data, nonce: transaction.nonce });
      throw requests.length === 1 ? failure : Object.assign(new Error("User rejected the request."), { code: 4001 });
    }
  };
  return { wallet, requests };
}

function creation(failure: unknown) {
  const chain = sellerChain(), journal = memoryPendingJournal(), { wallet, requests } = sellerWallet(failure);
  const service = createRaffleService(chain.client, manifest, journal);
  const draft: DraftInput = { nft: NFT, tokenId: 1n, salesEnd: 1_800_000_000n + 86_400n, reserveNonce: keccak256("0x12"), reserveCommit: keccak256("0x34"), title: "One create intent",
    packs: STANDARD_MEMBERSHIP_TIERS.map(name => ({ name, priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 })) };
  let record: Extract<CreateRecord, { kind: "draft" }> = { kind: "draft", data: encodeDraft(draft), creationHash: null, id: null, pending: null };
  const press = () => finishCreate({ service, wallet, draft, record, save: next => { record = next; }, assertIntent: () => {}, onStep: () => {} });
  return { ...chain, journal, requests, press, record: () => record };
}

describe("Create after a wallet failure that sent nothing LABx could see", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("keeps the draft step's nonce after a bare -32603 error, so Create finds the draft the wallet sent and never asks for a second one", async () => {
    vi.useFakeTimers();
    const flow = creation({ code: -32603, message: "Internal JSON-RPC error." });
    const first = expect(flow.press()).rejects.toThrow("Your wallet couldn't send this transaction. Nothing was sent.");
    // The seller's nonces show nothing at nonce 7 for the four seconds the service keeps reading them.
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    expect(flow.journal.read(SELLER)).toBeNull();
    expect(flow.journal.readCleared(SELLER)).toEqual({ nonce: 7, startedBlock: "100" });
    expect(flow.record().pending).toMatchObject({ step: "createDraft", hash: null, checkpoint: { nonce: 7, startedBlock: "100" } });
    // The wallet's own RPC had taken the send. It is mined, and LABx's RPC now shows it.
    Object.assign(flow.state, { block: 104n, latest: 8, pending: 8, created: { hash: CREATION, nonce: 7 } });
    for (let click = 0; click < 3; click++) await expect(flow.press()).rejects.toThrow("Creation stopped. Wait for canonical confirmation, then click Create to resume.");
    expect(flow.requests.map(request => request.nonce)).toEqual([7]);
    expect(flow.record().pending).toMatchObject({ step: "createDraft", hash: CREATION });
    expect(flow.journal.readCleared(SELLER)).toBeNull();
  });

  it("sends the draft again at the same nonce when nothing landed there after a bare -32603 error", async () => {
    vi.useFakeTimers();
    const flow = creation({ code: -32603, message: "Internal JSON-RPC error." });
    const first = expect(flow.press()).rejects.toThrow("Your wallet couldn't send this transaction. Nothing was sent.");
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    await expect(flow.press()).rejects.toMatchObject({ code: 4001 });
    expect(flow.requests.map(request => request.nonce)).toEqual([7, 7]);
    expect(flow.requests[1].data).toBe(flow.requests[0].data);
    expect(flow.record().pending).toBeNull();
  });

  it("still retires the draft step at once when the wallet's own message says it sent nothing", async () => {
    const flow = creation({ code: -32603, message: "Internal JSON-RPC error.", data: { code: -32000, message: "insufficient funds for gas * price + value" } });
    await expect(flow.press()).rejects.toThrow("Your wallet doesn't have enough Sepolia ETH for its network fee. Nothing was sent.");
    expect(flow.journal.read(SELLER)).toBeNull();
    expect(flow.journal.readCleared(SELLER)).toBeNull();
    expect(flow.record().pending).toBeNull();
  });
});
