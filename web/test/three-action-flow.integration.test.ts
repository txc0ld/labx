import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { encodeDraft, finishCreate, type CreateRecord } from "../lib/chain/create-flow";
import type { DraftInput } from "../lib/chain/types";
import { createRaffleService } from "../lib/chain/service";
import { STANDARD_MEMBERSHIP_TIERS } from "../lib/membership-tiers";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
run("one-intent creation and capability-owned owner requests", () => {
  let c: LocalChain, checkpoint: unknown;
  beforeAll(async () => { c = await localChain(); await c.write(c.nft, "mint", [c.seller, 1n]); }, 30_000);
  beforeEach(async () => { checkpoint = await c.rpc("evm_snapshot"); c.service = createRaffleService(c.client, c.manifest); });
  afterEach(async () => { vi.restoreAllMocks(); await c.rpc("evm_revert", [checkpoint]); });
  afterAll(() => c?.close());
  async function setup() {
    const wallet = c.wallet(c.seller); await wallet.session.connect();
    const draft: DraftInput = { nft: c.nft.address, tokenId: 1n, salesEnd: (await c.client.getBlock()).timestamp + 86400n, reserveNonce: keccak256("0x12"), reserveCommit: keccak256("0x34"), title: "One create intent", packs: STANDARD_MEMBERSHIP_TIERS.map(name => ({ name, priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 })) };
    let record: Extract<CreateRecord, { kind: "draft" }> = { kind: "draft", data: encodeDraft(draft), creationHash: null, id: null, pending: null };
    const original = c.service.submit;
    const sent: string[] = [];
    vi.spyOn(c.service, "submit").mockImplementation(async input => {
      const tx = await original(input);
      sent.push(input.prepared.action.kind);
      await c.client.waitForTransactionReceipt({ hash: tx.hash }); await c.mine();
      return tx;
    });
    const execute = (assertIntent = () => {}) => finishCreate({ service: c.service, wallet: wallet.session, draft, record, save: next => { record = next; }, assertIntent, onStep: () => {} });
    return { wallet, draft, sent, execute, record: () => record };
  }
  it("creates, approves the exact token and escrows once, then resumes without duplicate sends", async () => {
    const flow = await setup();
    const result = await flow.execute();
    expect(result.raffle.escrowed).toBe(true);
    expect(result.id).toBe(1n);
    expect(flow.sent).toEqual(["createDraft", "approvePrize", "escrow"]);
    await flow.execute();
    expect(flow.sent).toHaveLength(3);
  });
  it("stops at rejected NFT approval and resumes the original canonical draft", async () => {
    const flow = await setup();
    const prepare = c.service.prepare;
    vi.spyOn(c.service, "prepare").mockImplementation(async input => {
      if (input.action.kind === "approvePrize") flow.wallet.reject(true);
      return prepare(input);
    });
    await expect(flow.execute()).rejects.toThrow(/rejected/);
    expect(flow.sent).toEqual(["createDraft"]);
    expect(flow.record().pending).toBeNull();
    vi.mocked(c.service.prepare).mockRestore();
    flow.wallet.reject(false);
    await flow.execute();
    expect(flow.sent).toEqual(["createDraft", "approvePrize", "escrow"]);
  });
  it("allows an explicit retry after proven pre-provider validation failure", async () => {
    const flow = await setup();
    const original = c.client.getCode.bind(c.client);
    let failed = false;
    vi.spyOn(c.client, "getCode").mockImplementation(async input => {
      if (!failed && input.address.toLowerCase() === c.seller.toLowerCase()) { failed = true; throw new Error("pre-provider RPC failure"); }
      return original(input);
    });
    await expect(flow.execute()).rejects.toThrow("pre-provider RPC failure");
    expect(flow.sent).toEqual([]);
    expect(flow.record().pending).toBeNull();
    await flow.execute();
    expect(flow.sent).toEqual(["createDraft", "approvePrize", "escrow"]);
  });
  it("does not submit after intent retirement or recovery-storage failure", async () => {
    const flow = await setup();
    await expect(flow.execute(() => { throw new Error("retired"); })).rejects.toThrow("retired");
    expect(flow.sent).toEqual([]);
    await expect(finishCreate({ service: c.service, wallet: flow.wallet.session, draft: flow.draft, record: flow.record(), save: () => { throw new Error("storage offline"); }, assertIntent: () => {}, onStep: () => {} })).rejects.toThrow("storage offline");
    expect(flow.sent).toEqual([]);
  });
  it.each(["createDraft", "approvePrize", "escrow"])("retires a canonically cancelled %s and waits for an explicit retry", async step => {
    const flow = await setup();
    const originalPrepare = c.service.prepare;
    let currentStep = "", cancelled = false;
    vi.spyOn(c.service, "prepare").mockImplementation(async input => { currentStep = input.action.kind; return originalPrepare(input); });
    const request = flow.wallet.session.requestTransaction.bind(flow.wallet.session);
    vi.spyOn(flow.wallet.session, "requestTransaction").mockImplementation((session, tx, before, dispatched) => {
      if (currentStep === step && !cancelled) { cancelled = true; return request(session, { ...tx, to: c.seller, data: "0x" }, before, dispatched); }
      return request(session, tx, before, dispatched);
    });
    await expect(flow.execute()).rejects.toThrow(/reverted or was cancelled/);
    expect(flow.record().pending).toBeNull();
    expect(flow.record().lastFailure?.step).toBe(step);
    expect(await c.service.pending({ wallet: flow.wallet.session })).toBeNull();
    const beforeRetry = flow.sent.length;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(flow.sent).toHaveLength(beforeRetry);
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(flow.sent.filter(sent => sent === step)).toHaveLength(2);
  });
  it("cleans both creation and journal when its pre-dispatch checkpoint callback fails", async () => {
    const flow = await setup();
    const send = vi.spyOn(flow.wallet.session, "requestTransaction");
    let saved = flow.record(), refused = false;
    await expect(finishCreate({ service: c.service, wallet: flow.wallet.session, draft: flow.draft, record: saved,
      save: next => { saved = next; if (next.pending && !refused) { refused = true; throw new Error("checkpoint readback failed"); } }, assertIntent: () => {}, onStep: () => {} })).rejects.toThrow("checkpoint readback failed");
    expect(send).toHaveBeenCalledOnce();
    expect(saved.pending).toBeNull();
    expect(await c.service.pending({ wallet: flow.wallet.session })).toBeNull();
    expect(await c.client.getTransactionCount({ address: c.seller })).toBe(0);
  });
  it("dispatches the exact owner capability once and treats the response only as a wallet reference", async () => {
    const flow = await setup(); await flow.execute();
    const wallet = c.wallet(c.operator).session; await wallet.connect();
    const review = await c.service.readAdmission({ id: 1n });
    if (!review.snapshot.admission.reviewHash) throw new Error("missing review");
    const prepared = await c.service.prepare({ action: { kind: "approveRaffle", id: 1n, expectedReviewHash: review.snapshot.admission.reviewHash, attestations: { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } }, wallet });
    const proposal = keccak256("0xabcd");
    const dispatch = vi.spyOn(wallet, "requestExternalExecution").mockImplementation(async (_session, transaction, before, onRequest) => {
      await before(); onRequest();
      expect(transaction).toEqual({ to: c.manifest.address, data: prepared.data, value: 0n });
      return { kind: "wallet-reference", reference: proposal };
    });
    const nonce = vi.spyOn(c.client, "getTransactionCount");
    const receipt = vi.spyOn(c.client, "getTransactionReceipt");
    const beforeRequest = vi.fn(async () => {});
    expect(await c.service.requestOwnerExecution({ prepared, wallet, beforeRequest, assertIntent: () => {} })).toEqual({ kind: "wallet-reference", reference: proposal });
    expect(beforeRequest).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledOnce();
    expect(nonce).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
    await expect(c.service.requestOwnerExecution({ prepared, wallet, beforeRequest, assertIntent: () => {} })).rejects.toThrow(/Review an owner/);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
