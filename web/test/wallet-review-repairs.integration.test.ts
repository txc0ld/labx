import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { createRaffleService } from "../lib/chain/service";
import { memoryPendingJournal, transactionIntent } from "../lib/chain/pending-journal";
import { parseOwnerExecutionIntent, serializeOwnerExecutionIntent } from "../lib/chain/owner-execution";
import { hash } from "../lib/chain/validation";
import type { OwnerExecutionIntent } from "../lib/chain/types";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
const upperHash = (value: Hex) => hash(`0x${value.slice(2).toUpperCase()}`);
run("wallet review repairs", () => {
  let c: LocalChain;
  beforeAll(async () => {
    c = await localChain();
    const digest = keccak256("0x1234");
    await c.write(c.nft, "mint", [c.seller, 1n]);
    await c.write(c.raffle, "createRaffle", [c.nft.address, 1n, (await c.client.getBlock()).timestamp + 86400n, digest, digest, "Recovery", [{ name: "Member", priceUsdc: 25000000n, bonusEntries: 1, maxSupply: 20 }]], c.seller);
  }, 30000);
  let checkpoint: unknown;
  beforeEach(async () => { checkpoint = await c.rpc("evm_snapshot"); });
  afterEach(async () => { vi.restoreAllMocks(); await c.rpc("evm_revert", [checkpoint]); });
  afterAll(() => c?.close());

  it.each([4001, 5000])("clears definite numeric rejection %s and permits a fresh action", async code => {
    const journal = memoryPendingJournal(), service = createRaffleService(c.client, c.manifest, journal);
    const wallet = c.wallet(c.seller).session; await wallet.connect();
    const reject = Object.assign(new Error("User rejected"), { code });
    const send = vi.spyOn(wallet, "requestTransaction").mockImplementationOnce(async (_expected, _tx, before, started) => { await before?.(); started?.(); throw reject; });
    const prepared = await service.prepare({ action: { kind: "approvePrize", id: 1n }, wallet });
    await expect(service.submit({ prepared, wallet })).rejects.toBe(reject);
    expect(journal.read(c.seller)).toBeNull();
    send.mockRestore();
    const transaction = await service.submit({ prepared: await service.prepare({ action: { kind: "approvePrize", id: 1n }, wallet }), wallet });
    await c.client.waitForTransactionReceipt({ hash: transaction.hash }); await c.mine();
    expect((await service.confirm({ transaction, timeoutMs: 2000 })).kind).toBe("confirmed");
  });

  it.each([new Error("user rejected"), { code: "4001" }, { cause: { code: 4001 } }, { code: -32603, data: { code: 5000 } }])("retains uncertain responses %j", async failure => {
    const journal = memoryPendingJournal(), service = createRaffleService(c.client, c.manifest, journal);
    const wallet = c.wallet(c.seller).session; await wallet.connect();
    vi.spyOn(wallet, "requestTransaction").mockImplementationOnce(async (_expected, _tx, before, started) => { await before?.(); started?.(); throw failure; });
    await expect(service.submit({ prepared: await service.prepare({ action: { kind: "approvePrize", id: 1n }, wallet }), wallet })).rejects.toThrow(/uncertain/);
    expect(journal.read(c.seller)?.hash).toBeNull();
    await expect(service.submit({ prepared: await service.prepare({ action: { kind: "approvePrize", id: 1n }, wallet }), wallet })).rejects.toThrow(/unresolved/);
  });

  it.each([4001, 5000].flatMap(code => ["other intent", "recorded hash", "returned hash"].map(mode => ({ code, mode }))))("does not remove recovery for $mode on rejection code $code", async ({ code, mode }) => {
    const journal = memoryPendingJournal(), service = createRaffleService(c.client, c.manifest, journal);
    const wallet = c.wallet(c.seller).session; await wallet.connect();
    const reject = Object.assign(new Error("User rejected"), { code });
    vi.spyOn(wallet, "requestTransaction").mockImplementationOnce(async (_expected, _tx, before, started) => {
      await before?.(); started?.();
      const current = journal.read(c.seller); if (!current) throw new Error("Missing intent");
      if (mode === "other intent") journal.write(c.seller, { ...current, id: "other" });
      if (mode === "recorded hash") journal.write(c.seller, { ...current, hash: keccak256("0x5678") });
      if (mode === "returned hash") {
        vi.spyOn(journal, "write").mockImplementationOnce(() => { throw reject; });
        return keccak256("0x5678");
      }
      throw reject;
    });
    await expect(service.submit({ prepared: await service.prepare({ action: { kind: "approvePrize", id: 1n }, wallet }), wallet })).rejects.toThrow();
    expect(journal.read(c.seller)).not.toBeNull();
    if (mode === "other intent") expect(journal.read(c.seller)?.id).toBe("other");
  });

  it("accepts equivalent uppercase owner hash/data while rejecting different bytes", async () => {
    await c.write(c.nft, "approve", [c.raffle.address, 1n], c.seller);
    await c.write(c.raffle, "escrow", [1n], c.seller);
    const wallet = c.wallet(c.operator).session; await wallet.connect();
    const review = await c.service.readAdmission({ id: 1n });
    if (review.snapshot.admission.reviewHash === null) throw new Error("Expected draft");
    const prepared = await c.service.prepare({ action: { kind: "approveRaffle", id: 1n, expectedReviewHash: review.snapshot.admission.reviewHash, attestations: { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } }, wallet });
    const intent = await c.service.exportOwnerExecution({ prepared, wallet });
    const uppercase: OwnerExecutionIntent = { ...intent, runtimeCodeHash: upperHash(intent.runtimeCodeHash), data: `0x${intent.data.slice(2).toUpperCase()}`, action: { ...intent.action, expectedReviewHash: upperHash(intent.action.expectedReviewHash) }, reviewBlock: { ...intent.reviewBlock, hash: upperHash(intent.reviewBlock.hash) } };
    const stored = parseOwnerExecutionIntent(serializeOwnerExecutionIntent(uppercase), c.manifest, c.operator);
    const receipt = await c.write(c.raffle, "approveRaffle", [1n, intent.action.expectedReviewHash]); await c.mine();
    expect(await c.service.confirmOwnerExecution({ intent: uppercase, hash: upperHash(receipt.transactionHash), timeoutMs: 2000 })).toMatchObject({ kind: "executed", state: "approved" });
    expect(await c.service.confirmOwnerExecution({ intent: stored, hash: receipt.transactionHash, timeoutMs: 2000 })).toMatchObject({ kind: "executed", state: "approved" });
    const wrongReceipt = vi.spyOn(c.client, "waitForTransactionReceipt").mockResolvedValueOnce({ ...receipt, transactionHash: keccak256("0x5678") });
    await expect(c.service.confirmOwnerExecution({ intent, hash: upperHash(receipt.transactionHash), timeoutMs: 2000 })).rejects.toThrow(/No successful/);
    wrongReceipt.mockRestore();
    expect(() => parseOwnerExecutionIntent(serializeOwnerExecutionIntent({ ...intent, data: "0xgg" }), c.manifest, c.operator)).toThrow();
    expect(() => parseOwnerExecutionIntent(serializeOwnerExecutionIntent({ ...intent, runtimeCodeHash: keccak256("0x5678") }), c.manifest, c.operator)).toThrow();
  });


  it("inspects historical NFT approval without a seller catalog scan or journal mutation", async () => {
    const receipt = await c.write(c.nft, "approve", [c.raffle.address, 1n], c.seller);
    const template = (await c.service.readRaffle({ id: 1n })).raffle;
    const read = c.client.readContract.bind(c.client);
    const spy = vi.spyOn(c.client, "readContract").mockImplementation(async input => {
      if (input.functionName === "nextId") return 482n;
      if (input.functionName === "getRaffle") return { ...template, seller: input.args?.[0] === 480n ? c.seller : c.stranger };
      if (input.args?.length) return read({ ...input, args: [1n, ...input.args.slice(1)] });
      return read(input);
    });
    const journal = memoryPendingJournal(), service = createRaffleService(c.client, c.manifest, journal);
    const wallet = c.wallet(c.seller).session; await wallet.connect();
    await c.mine();
    expect(await service.inspectOutcome({ hash: receipt.transactionHash, account: c.seller })).toMatchObject({ kind: "confirmed", receipt: { hash: receipt.transactionHash } });
    expect(journal.read(c.seller)).toBeNull();
    expect(spy.mock.calls.some(([call]) => ["nextId", "getRaffle", "getPack"].includes(call.functionName))).toBe(false);
  });

  it("keeps historical NFT inspection separate from exact pending-journal recovery", async () => {
    await c.write(c.nft, "mint", [c.seller, 2n]);
    const receipt = await c.write(c.nft, "approve", [c.raffle.address, 2n], c.seller);
    const tx = await c.client.getTransaction({ hash: receipt.transactionHash });
    const template = (await c.service.readRaffle({ id: 1n })).raffle;
    const read = c.client.readContract.bind(c.client);
    const spy = vi.spyOn(c.client, "readContract").mockImplementation(async input => {
      if (input.functionName === "nextId") return 482n;
      if (input.functionName === "getRaffle") return { ...template, seller: c.stranger, tokenId: 2n };
      if (input.args?.length) return read({ ...input, args: [1n, ...input.args.slice(1)] });
      return read(input);
    });
    const journal = memoryPendingJournal(), service = createRaffleService(c.client, c.manifest, journal);
    const wallet = c.wallet(c.seller).session; await wallet.connect();
    expect(await service.resume({ hash: tx.hash, wallet })).toBeNull();
    expect(journal.read(c.seller)).toBeNull();
    expect(spy.mock.calls.filter(([call]) => call.functionName === "getRaffle")).toHaveLength(0);
    expect(spy.mock.calls.some(([call]) => ["getPack", "getRaffleAdmission", "getRafflePolicy"].includes(call.functionName))).toBe(false);
    spy.mockClear();
    journal.write(c.seller, { id: "existing", nonce: tx.nonce, startedBlock: receipt.blockNumber.toString(), hash: null, intentHash: transactionIntent({ to: c.nft.address, data: tx.input, value: tx.value }) });
    expect(await service.resume({ hash: tx.hash, wallet })).toMatchObject({ hash: tx.hash });
    expect(spy.mock.calls.some(([call]) => call.functionName === "nextId" || call.functionName === "getRaffle")).toBe(false);
  });
});
