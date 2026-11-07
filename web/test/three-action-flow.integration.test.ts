import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { encodeDraft, finishCreate, recoverCreateTransaction, type CreateRecord } from "../lib/chain/create-flow";
import type { DraftInput } from "../lib/chain/types";
import { memoryPendingJournal, transactionIntent } from "../lib/chain/pending-journal";
import { hash } from "../lib/chain/validation";
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
    return { wallet, draft, sent, execute, record: () => record, replaceRecord: (next: typeof record) => { record = next; } };
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
  it("retires an exact reverted NFT approval and resumes only after another activation", async () => {
    await c.write(c.nft, "setApprovalForAll", [c.operator, true], c.seller);
    const flow = await setup();
    const prepare = c.service.prepare;
    let currentStep = "", reverted = false;
    vi.spyOn(c.service, "prepare").mockImplementation(async input => { currentStep = input.action.kind; return prepare(input); });
    const request = flow.wallet.session.requestTransaction.bind(flow.wallet.session);
    vi.spyOn(flow.wallet.session, "requestTransaction").mockImplementation(async (session, tx, before, dispatched) => {
      if (currentStep !== "approvePrize" || reverted) return request(session, tx, before, dispatched);
      reverted = true;
      await before?.();
      await c.write(c.nft, "transferFrom", [c.seller, c.stranger, 1n]);
      dispatched?.();
      return hash(await c.rpc("eth_sendTransaction", [{ from: c.seller, to: tx.to, data: tx.data, value: "0x0", nonce: `0x${tx.nonce?.toString(16)}`, gas: "0x989680" }]));
    });
    await expect(flow.execute()).rejects.toThrow(/reverted or was cancelled/);
    expect(flow.record().pending).toBeNull();
    expect(flow.record().lastFailure?.step).toBe("approvePrize");
    expect(flow.sent).toEqual(["createDraft", "approvePrize"]);
    await c.write(c.nft, "transferFrom", [c.stranger, c.seller, 1n], c.stranger);
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(flow.sent).toEqual(["createDraft", "approvePrize", "approvePrize", "escrow"]);
  });
  it("adopts only the exact crash-gap journal and recovers a missing hash without another send", async () => {
    const journal = memoryPendingJournal(); c.service = createRaffleService(c.client, c.manifest, journal);
    const flow = await setup();
    const block = await c.client.getBlock();
    const data = encodeDraft(flow.draft);
    const checkpoint = { id: "crash-gap", nonce: 0, startedBlock: block.number.toString(), intentHash: transactionIntent({ to: c.manifest.address, data, value: 0n }) };
    journal.write(c.seller, { ...checkpoint, hash: null });
    await expect(flow.execute()).rejects.toThrow(/Advanced recovery/);
    expect(flow.record().pending?.checkpoint).toEqual(checkpoint);
    expect(flow.sent).toEqual([]);
    const txHash = hash(await c.rpc("eth_sendTransaction", [{ from: c.seller, to: c.manifest.address, data, gas: "0x989680" }]));
    await c.client.waitForTransactionReceipt({ hash: txHash }); await c.mine();
    await recoverCreateTransaction({ service: c.service, wallet: flow.wallet.session, record: flow.record(), save: flow.replaceRecord, assertIntent: () => {}, hash: txHash });
    expect(flow.record().id).toBe("1"); expect(flow.record().pending).toBeNull(); expect(flow.sent).toEqual([]);
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(flow.sent).toEqual(["approvePrize", "escrow"]);
  });
  it("blocks unrelated crash-gap journals without adopting them", async () => {
    const journal = memoryPendingJournal(); c.service = createRaffleService(c.client, c.manifest, journal);
    const flow = await setup();
    journal.write(c.seller, { id: "other", nonce: 0, startedBlock: "1", intentHash: keccak256("0x1234"), hash: null });
    await expect(flow.execute()).rejects.toThrow(/unrelated wallet transaction/);
    expect(flow.record().pending).toBeNull(); expect(flow.sent).toEqual([]);
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

  /**
   * A seller wallet whose request for `step` fails without a hash, as a WalletConnect error can. With `broadcast` it still sent
   * the request, as a wallet whose own RPC took it does. Every request it is asked for is counted by step.
   */
  async function lostStep(step: string, broadcast: boolean) {
    const journal = memoryPendingJournal(); c.service = createRaffleService(c.client, c.manifest, journal);
    const flow = await setup();
    const prepare = c.service.prepare;
    let currentStep = "", failed = false;
    const requested: string[] = [];
    vi.spyOn(c.service, "prepare").mockImplementation(async input => { currentStep = input.action.kind; return prepare(input); });
    const request = flow.wallet.session.requestTransaction.bind(flow.wallet.session);
    vi.spyOn(flow.wallet.session, "requestTransaction").mockImplementation(async (session, tx, before, dispatched) => {
      requested.push(currentStep);
      if (currentStep !== step || failed) return request(session, tx, before, dispatched);
      failed = true;
      await before?.();
      dispatched?.();
      if (broadcast) await c.rpc("eth_sendTransaction", [{ from: c.seller, to: tx.to, data: tx.data, value: "0x0", nonce: toHex(tx.nonce ?? 0), gas: "0x989680" }]);
      throw new Error("Request expired. Please try again.");
    });
    await expect(flow.execute()).rejects.toThrow(/uncertain/);
    const pending = await c.service.pending({ wallet: flow.wallet.session });
    if (!pending) throw new Error("The wallet's uncertain answer left no pending record.");
    expect(flow.record().pending).toMatchObject({ step, hash: null, checkpoint: { id: pending.id, nonce: pending.nonce } });
    return { flow, journal, pending, requested };
  }
  const raffles = async () => await c.client.readContract({ address: c.manifest.address, abi: raffleAbi, functionName: "nextId" }) - 1n;

  it("sends the draft again after Continue clears its unsent record on another page, and makes one draft", async () => {
    const { flow, pending, requested } = await lostStep("createDraft", false);
    // The dashboard's Continue clears the record; the creation record still points at it.
    expect(await c.service.settlePending({ wallet: flow.wallet.session, expected: pending, continueUnsent: true })).toEqual({ kind: "dropped" });
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(requested).toEqual(["createDraft", "createDraft", "approvePrize", "escrow"]);
    expect(await raffles()).toBe(1n);
    expect(flow.record()).toMatchObject({ id: "1", pending: null });
  });

  it("finds the draft a wallet sent despite its error, after the mined nonce clears the record, and makes no second draft", async () => {
    const { flow, pending, requested } = await lostStep("createDraft", true);
    await c.mine(); await c.mine();
    expect(await c.service.settlePending({ wallet: flow.wallet.session, expected: pending })).toEqual({ kind: "spent" });
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(requested).toEqual(["createDraft", "approvePrize", "escrow"]);
    expect(await raffles()).toBe(1n);
    expect(flow.record().creationHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("finds that draft when the seller comes back more than 20,000 blocks later, and makes no second draft", async () => {
    const { flow, pending, requested } = await lostStep("createDraft", true);
    await c.mine(); await c.mine();
    expect(await c.service.settlePending({ wallet: flow.wallet.session, expected: pending })).toEqual({ kind: "spent" });
    await c.rpc("anvil_mine", [toHex(20_001)]);
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(requested).toEqual(["createDraft", "approvePrize", "escrow"]);
    expect(await raffles()).toBe(1n);
  });

  it.each([true, false])("continues past an NFT approval whose record was cleared elsewhere, sending it again only if it never landed (landed: %s)", async landed => {
    const { flow, pending, requested } = await lostStep("approvePrize", landed);
    if (landed) { await c.mine(); await c.mine(); }
    expect(await c.service.settlePending({ wallet: flow.wallet.session, expected: pending, continueUnsent: !landed })).toEqual({ kind: landed ? "spent" : "dropped" });
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(requested).toEqual(landed ? ["createDraft", "approvePrize", "escrow"] : ["createDraft", "approvePrize", "approvePrize", "escrow"]);
  });

  it("waits while something is pending at a lost step's nonce, then finds the draft once it is mined", async () => {
    const { flow, pending, requested } = await lostStep("createDraft", false);
    expect(await c.service.settlePending({ wallet: flow.wallet.session, expected: pending, continueUnsent: true })).toEqual({ kind: "dropped" });
    await c.rpc("evm_setAutomine", [false]);
    try {
      // The person approves the old request after all; it waits to be mined.
      await c.rpc("eth_sendTransaction", [{ from: c.seller, to: c.manifest.address, data: flow.record().data, value: "0x0", nonce: toHex(pending.nonce), gas: "0x989680" }]);
      await expect(flow.execute()).rejects.toThrow("Creation stopped. Wait for canonical confirmation, then click Create to resume.");
      expect(flow.record().pending).toMatchObject({ step: "createDraft", hash: null });
      await c.mine(); await c.mine();
    } finally {
      await c.rpc("evm_setAutomine", [true]);
    }
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(requested).toEqual(["createDraft", "approvePrize", "escrow"]);
    expect(await raffles()).toBe(1n);
  });

  /**
   * A draft whose wallet hash was saved, then the page closed before its receipt. The wallet then drops that hash, and
   * `mode` says what lands at its nonce instead: a faster copy of the draft, a cancel, or nothing for 30 blocks. The
   * dashboard then clears the record, and the creation record still holds the hash the chain no longer knows.
   */
  async function lostHash(mode: "speedup" | "cancel" | "expired") {
    const journal = memoryPendingJournal(); c.service = createRaffleService(c.client, c.manifest, journal);
    const submit = c.service.submit;
    const flow = await setup();
    vi.mocked(c.service.submit).mockImplementationOnce(submit);
    vi.spyOn(c.service, "confirm").mockRejectedValueOnce(new Error("The page closed."));
    await c.rpc("evm_setAutomine", [false]);
    let pending;
    try {
      await expect(flow.execute()).rejects.toThrow("The page closed.");
      pending = journal.read(c.seller);
      if (!pending?.hash) throw new Error("The draft's wallet hash was not saved.");
      expect(flow.record().pending).toMatchObject({ step: "createDraft", hash: pending.hash });
      await c.rpc("anvil_dropTransaction", [pending.hash]);
    } finally {
      await c.rpc("evm_setAutomine", [true]);
    }
    if (mode === "speedup") await c.rpc("eth_sendTransaction", [{ from: c.seller, to: c.manifest.address, data: flow.record().data, value: "0x0", nonce: toHex(pending.nonce), gas: "0x989681" }]);
    if (mode === "cancel") await c.rpc("eth_sendTransaction", [{ from: c.seller, to: c.seller, value: "0x0", nonce: toHex(pending.nonce), gas: "0x5208" }]);
    if (mode === "expired") await c.rpc("anvil_mine", [toHex(30)]);
    else { await c.mine(); await c.mine(); }
    expect(await c.service.settlePending({ wallet: flow.wallet.session, expected: pending })).toEqual({ kind: mode === "expired" ? "dropped" : "spent" });
    expect(journal.read(c.seller)).toBeNull();
    return flow;
  }

  it("continues from the faster copy of a draft whose saved hash was replaced, and makes no second draft", async () => {
    const flow = await lostHash("speedup");
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(flow.sent).toEqual(["approvePrize", "escrow"]);
    expect(await raffles()).toBe(1n);
    expect(flow.record()).toMatchObject({ id: "1", pending: null });
  });

  it.each(["cancel", "expired"] as const)("sends the draft again once when its saved hash never landed (%s)", async mode => {
    const flow = await lostHash(mode);
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(flow.sent).toEqual(["createDraft", "approvePrize", "escrow"]);
    expect(await raffles()).toBe(1n);
    expect(flow.record()).toMatchObject({ id: "1", pending: null });
  });

  it("finishes a draft that a wallet sent at a nonce of its own", async () => {
    const journal = memoryPendingJournal(); c.service = createRaffleService(c.client, c.manifest, journal);
    const flow = await setup();
    const request = flow.wallet.session.requestTransaction.bind(flow.wallet.session);
    let first = true;
    vi.spyOn(flow.wallet.session, "requestTransaction").mockImplementation(async (session, tx, before, dispatched) => {
      if (!first) return request(session, tx, before, dispatched);
      first = false;
      // The wallet has a send of its own pending, so it puts this request at the next nonce.
      await c.rpc("eth_sendTransaction", [{ from: c.seller, to: c.seller, value: "0x0", nonce: toHex(tx.nonce ?? 0), gas: "0x5208" }]);
      return request(session, { ...tx, nonce: (tx.nonce ?? 0) + 1 }, before, dispatched);
    });
    expect((await flow.execute()).raffle.escrowed).toBe(true);
    expect(await raffles()).toBe(1n);
    expect(journal.read(c.seller)).toBeNull();
  });
});
