import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { createTransactionOutcomes, transactionMeaning, type OutcomeStorage } from "../lib/chain/transaction-outcomes";
import type { CanonicalReceipt, Confirmation, OutcomeInspection, DeploymentManifest, PreparedAction, SubmittedAction, WalletSnapshot } from "../lib/chain/types";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";

const account = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const contract = "0x3333333333333333333333333333333333333333";
const hash: Hex = `0x${"ab".repeat(32)}`;
const manifest: DeploymentManifest = { chainId: 31337, address: contract, usdc: other, runtimeCodeHash: hash, deploymentBlock: 1n, version: 3 };
const submitted: SubmittedAction = { hash, account, chainId: 31337, to: contract, data: encodeFunctionData({ abi: raffleAbi, functionName: "refund", args: [1n] }), value: 0n };
const prepared: PreparedAction = { ...submitted, to: contract, action: { kind: "refund", id: 1n }, title: "Refund", amountUsdc: 1n, recipient: account, block: { number: 1n, hash, timestamp: 1n }, walletRevision: 1 };
const receipt = { ...submitted, nonce: 1, blockNumber: 2n, status: "success" as const };
const confirmed: Extract<Confirmation, { kind: "confirmed" }> = { kind: "confirmed", hash, blockNumber: 2n, replacedHash: null, receipt };
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred promise was not initialized."); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function memoryStorage() {
  const map = new Map<string, string>();
  const storage: OutcomeStorage = { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); } };
  return { storage, map };
}
function fixture() {
  let snapshot: WalletSnapshot = { kind: "connected", account, chainId: 31337, revision: 1 };
  const wallet: WalletSessionPort = {
    getSnapshot: () => snapshot, subscribe: () => () => {}, connect: async () => snapshot, refresh: async () => snapshot,
    disconnect: () => { snapshot = { kind: "disconnected", revision: snapshot.revision + 1 }; }, assertCurrent: async () => {},
    requestTransaction: async () => hash, signMessage: async () => hash
  };
  const confirm = vi.fn(async (input: Parameters<RaffleService["confirm"]>[0]): Promise<Confirmation> => { input.beforeJournalClear?.({ receipt, pending: null }); return confirmed; });
  const service = {
    captureOutcomeLineage: vi.fn((_input: Parameters<RaffleService["captureOutcomeLineage"]>[0]): ReturnType<RaffleService["captureOutcomeLineage"]> => null),
    retainOutcome: vi.fn(async (input: Parameters<RaffleService["retainOutcome"]>[0]) => { input.retain({ priorHash: null }); }),
    acknowledgeOutcome: vi.fn(async (input: Parameters<RaffleService["acknowledgeOutcome"]>[0]) => { input.acknowledge(); }),
    manifest, submit: vi.fn(async () => submitted),
    pending: vi.fn(async (): ReturnType<RaffleService["pending"]> => null),
    inspectOutcome: vi.fn(async (_input: Parameters<RaffleService["inspectOutcome"]>[0]): Promise<OutcomeInspection> => confirmed),
    resume: vi.fn(async (input: Parameters<RaffleService["resume"]>[0]) => { input.beforeJournalUpdate?.({ transaction: submitted, nonce: 1, pending: { id: "test-journal", hash, nonce: 1 } }); return submitted; }),
    confirm: async (input: Parameters<RaffleService["confirm"]>[0]): Promise<Confirmation> => {
      const pending = await service.pending();
      input.beforeJournalWatch?.({ transaction: { ...input.transaction, nonce: pending?.nonce ?? 1 }, pending: { id: "test-journal", hash: input.transaction.hash, nonce: pending?.nonce ?? 1 } });
      return confirm(input);
    }
  };
  const { storage, map } = memoryStorage();
  return { service, confirm, wallet, storage, map, switchWallet(next: WalletSnapshot) { snapshot = next; } };
}

describe("operation ownership beyond transaction controls", () => {
  it("owns a fresh broadcast in memory before RPC observation and survives detached UI notification", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const observed = deferred<void>(), confirm = f.service.confirm;
    f.service.confirm = async input => { await observed.promise; return confirm(input); };
    const notification = vi.fn((transaction: SubmittedAction) => { expect(Object.isFrozen(transaction)).toBe(true); throw new Error("UI detached"); });
    const watching = owner.submit(prepared, f.wallet, notification);
    await vi.waitFor(() => expect(notification).toHaveBeenCalledWith(submitted));
    expect(owner.getSnapshot(account)).toMatchObject([{ kind: "checking", submitted: { hash } }]);
    expect(f.map.size).toBe(0);
    observed.resolve();
    expect(await watching).toMatchObject({ kind: "terminal" });
    expect([...f.map.values()]).toEqual([hash]);
  });

  it.each([false, true])("settles a pointer mismatch scan and retries its fork only on a new synchronization (captured lineage: %s)", async captured => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const replacement: Hex = `0x${"cd".repeat(32)}`;
    const token = Object.freeze({ hash });
    f.service.captureOutcomeLineage.mockImplementation(input => captured && input.hash === hash ? token : null);
    const key = `labx:outcome:v1:31337:${contract}:${hash}:${account}:${hash}`;
    f.map.set(key, hash);
    owner.hydrate(account);
    expect(f.service.captureOutcomeLineage).toHaveBeenCalledWith({ account, hash });
    expect(f.service.inspectOutcome).not.toHaveBeenCalled();
    f.map.set(key, replacement);
    f.service.inspectOutcome.mockImplementation(async input => input.hash === hash
      ? { kind: "unknown", hash, reason: "Transaction unavailable" }
      : { kind: "pending", hash: replacement, reason: "confirmations", transaction: { ...submitted, hash: replacement, nonce: 1 } });
    await owner.recover(account);
    expect(f.service.inspectOutcome).toHaveBeenCalledTimes(2);
    expect(owner.getSnapshot(account).every(item => item.kind === "unverified")).toBe(true);
    await owner.recover(account);
    expect(f.service.inspectOutcome).toHaveBeenCalledTimes(2);
    f.service.inspectOutcome.mockResolvedValue({ ...confirmed, hash: replacement, receipt: { ...receipt, hash: replacement } });
    f.service.retainOutcome.mockImplementation(async input => { input.retain({ priorHash: captured && input.lineage === token ? hash : null }); });
    await owner.synchronize(account);
    expect(f.service.inspectOutcome).toHaveBeenCalledTimes(3);
    expect(owner.getSnapshot(account).filter(item => item.kind === "terminal")).toHaveLength(1);
    expect(owner.getSnapshot(account).filter(item => item.kind === "unverified")).toHaveLength(captured ? 0 : 1);
  });

  it("continues submission and confirmation after every subscriber detaches, isolating A from B and restoring A", async () => {
    const f = fixture(), send = deferred<SubmittedAction>(), receipt = deferred<Confirmation>();
    f.service.submit.mockImplementation(() => send.promise);
    f.confirm.mockImplementation(() => receipt.promise);
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    const listener = vi.fn(), unsubscribe = owner.subscribe(listener);
    const run = owner.submit(prepared, f.wallet);
    expect(owner.getSnapshot(account)[0].kind).toBe("submitting");
    unsubscribe();
    f.switchWallet({ kind: "connected", account: other, chainId: 31337, revision: 2 });
    send.resolve(submitted);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(1));
    expect(f.map.size).toBe(1);
    expect(owner.getSnapshot(other)).toEqual([]);
    receipt.resolve(confirmed);
    const result = await run;
    f.switchWallet({ kind: "connected", account, chainId: 31337, revision: 3 });
    expect(result.kind).toBe("terminal");
    expect(owner.getSnapshot(account)).toEqual([result]);
    expect(owner.getSnapshot(account)).toBe(owner.getSnapshot(account));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("deduplicates simultaneous confirmation and refresh claims", async () => {
    const f = fixture(), receipt = deferred<Confirmation>();
    f.confirm.mockImplementation(() => receipt.promise);
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    const first = owner.submit(prepared, f.wallet);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(1));
    f.service.pending.mockResolvedValue({ id: "test-journal", hash, nonce: 1 });
    const second = owner.resume(hash, f.wallet);
    receipt.resolve(confirmed);
    expect(await first).toBe(await second);
    expect(owner.claimRefresh("raffle-1:A:revision-1:hash")).toBe(true);
    expect(owner.claimRefresh("raffle-1:A:revision-1:hash")).toBe(false);
    expect(owner.claimRefresh("raffle-2:A:revision-1:hash")).toBe(true);
  });

  it.each(["pending", "reverted", "replaced"] as const)("retains the canonical %s outcome without claiming a purchase", async kind => {
    const f = fixture();
    f.confirm.mockResolvedValue(kind === "pending" ? { kind, hash } : { kind, hash, reason: "Canonical result", receipt });
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    const result = await owner.submit(prepared, f.wallet);
    expect(result).toMatchObject(kind === "pending" ? { kind: "pending" } : { kind: "terminal", confirmation: { kind } });
    expect(f.map.size).toBe(1);
  });

  it("leaves the service journal untouched when checkpoint storage fails", async () => {
    const f = fixture();
    const owner = createTransactionOutcomes(f.service, () => ({ ...f.storage, setItem() { throw new Error("Storage denied"); } }));
    const result = await owner.submit(prepared, f.wallet);
    expect(result).toMatchObject({ kind: "error", submitted, message: "Storage denied" });
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("hydrates only unverified hashes, survives owner recreation and requires service revalidation", async () => {
    const f = fixture();
    await createTransactionOutcomes(f.service, () => f.storage).submit(prepared, f.wallet);
    f.confirm.mockClear();
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    owner.hydrate(other);
    expect(owner.getSnapshot(other)).toEqual([]);
    owner.hydrate(account);
    expect(owner.getSnapshot(account)).toEqual([{ kind: "recovery", id: hash, account, hash }]);
    expect(f.confirm).not.toHaveBeenCalled();
    await owner.resume(hash, f.wallet);
    expect(f.service.resume).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.service.inspectOutcome).toHaveBeenCalledTimes(1);
    expect([...f.map.values()]).toEqual([hash]);
  });

  it("rejects malformed or oversized checkpoint storage without treating any record as success", () => {
    const f = fixture();
    f.map.set(`labx:outcome:v1:31337:${contract}:${hash}:${account}:${hash}`, JSON.stringify({ hash, confirmed: true }));
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    owner.hydrate(account);
    expect(owner.getSnapshot(account)).toMatchObject([{ kind: "error", message: expect.stringMatching(/invalid/) }]);
    const large = createTransactionOutcomes(f.service, () => ({ ...f.storage, length: 10_001 }));
    large.hydrate(account);
    expect(large.getSnapshot(account)).toMatchObject([{ kind: "error", message: expect.stringMatching(/too large/) }]);
  });

  it("acknowledges only the exact current terminal record and preserves unknown and nonterminal hints", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    f.confirm.mockResolvedValueOnce({ kind: "pending", hash });
    const pending = await owner.submit(prepared, f.wallet);
    await owner.acknowledge(pending);
    expect(f.map.size).toBe(1);
    const terminal = await owner.submit(prepared, f.wallet);
    await owner.acknowledge({ ...terminal });
    expect(f.map.size).toBe(1);
    await owner.acknowledge(terminal);
    expect(f.map.size).toBe(0);
    expect(owner.getSnapshot(account)).toEqual([]);
  });

  it("does not recreate a nonce journal when rechecking an already owned terminal outcome", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const terminal = await owner.submit(prepared, f.wallet);
    expect(await owner.resume(hash, f.wallet)).toBe(terminal);
    expect(await owner.resume(`0x${"AB".repeat(32)}`, f.wallet)).toBe(terminal);
    expect(f.service.resume).not.toHaveBeenCalled();
  });

  it.each([4001, 5000])("preserves a direct numeric %s rejection without inventing a submitted hash", async code => {
    const f = fixture();
    f.service.submit.mockRejectedValue({ code });
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    expect(await owner.submit(prepared, f.wallet)).toMatchObject({ kind: "rejected" });
    expect(f.map.size).toBe(0);
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it.each([{ code: "4001" }, { cause: { code: 4001 } }, new Error("The wallet response is uncertain")])("retains uncertain failures instead of claiming rejection", async error => {
    const f = fixture();
    f.service.submit.mockRejectedValue(error);
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    expect(await owner.submit(prepared, f.wallet)).toMatchObject({ kind: "error" });
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("links distinct same-nonce hashes, keeps one canonical hint and automatically recovers cancellation after reload", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const replacementHash: Hex = `0x${"cd".repeat(32)}`;
    const replacement: SubmittedAction = { ...submitted, hash: replacementHash, to: account, data: "0x" as const };
    const cancelled = { ...replacement, nonce: 1, blockNumber: 3n, status: "success" as const };
    f.confirm.mockResolvedValueOnce({ kind: "pending", hash });
    await owner.submit(prepared, f.wallet);
    f.service.pending.mockResolvedValue({ id: "test-journal", hash, nonce: 1 });
    f.service.resume.mockImplementation(async input => {
      input.beforeJournalUpdate?.({ transaction: replacement, nonce: 1, pending: { id: "nonce-1", hash, nonce: 1 } });
      return replacement;
    });
    f.confirm.mockImplementation(async input => {
      input.beforeJournalClear?.({ receipt: cancelled, pending: { id: "nonce-1", hash: replacementHash, nonce: 1 } });
      f.service.pending.mockResolvedValue(null);
      return { kind: "replaced", hash: replacementHash, reason: "Cancelled", receipt: cancelled };
    });
    const result = await owner.resume(replacementHash, f.wallet);
    expect(result).toMatchObject({ kind: "terminal", id: hash, submitted: replacement, confirmation: { kind: "replaced" } });
    expect(owner.getSnapshot(account)).toEqual([result]);
    expect([...f.map.values()]).toEqual([replacementHash]);
    f.service.inspectOutcome.mockResolvedValue({ kind: "confirmed", hash: replacementHash, blockNumber: 3n, replacedHash: null, receipt: cancelled });
    const reloaded = createTransactionOutcomes(f.service, () => f.storage);
    await Promise.all([reloaded.recover(account), reloaded.recover(account)]);
    expect(reloaded.getSnapshot(account)).toMatchObject([{ id: hash, kind: "terminal", submitted: replacement }]);
    expect(f.service.inspectOutcome).toHaveBeenCalledTimes(1);
    expect(f.service.resume).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "error"] as const)("does not resurrect an acknowledged operation when an old attempt returns %s", async kind => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage), late = deferred<Confirmation>();
    const secondHash: Hex = `0x${"cd".repeat(32)}`;
    const second = { ...submitted, hash: secondHash }, canonical = { ...receipt, hash: secondHash };
    f.confirm.mockImplementationOnce(() => late.promise.then(value => { if (kind === "error") throw new Error("Old watcher failed"); return value; }));
    const first = owner.submit(prepared, f.wallet);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(1));
    f.service.pending.mockResolvedValue({ id: "test-journal", hash, nonce: 1 });
    f.service.resume.mockImplementation(async input => { input.beforeJournalUpdate?.({ transaction: second, nonce: 1, pending: { id: "nonce-1", hash, nonce: 1 } }); return second; });
    f.confirm.mockImplementation(async input => { input.beforeJournalClear?.({ receipt: canonical, pending: null }); return { kind: "confirmed", hash: secondHash, blockNumber: 2n, replacedHash: hash, receipt: canonical }; });
    const terminal = await owner.resume(secondHash, f.wallet);
    await owner.acknowledge(terminal);
    late.resolve({ kind: "pending", hash });
    await first;
    expect(owner.getSnapshot(account)).toEqual([]);
    expect(f.map.size).toBe(0);
  });

  it("persists actual H3 and its semantics even when the journal was already cleared", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const thirdHash: Hex = `0x${"ef".repeat(32)}`;
    const canonical = { ...receipt, hash: thirdHash, data: encodeFunctionData({ abi: raffleAbi, functionName: "buyPack", args: [3n, 0, 1, hash] }) };
    f.confirm.mockImplementation(async input => { input.beforeJournalClear?.({ receipt: canonical, pending: null }); return { kind: "confirmed", hash: thirdHash, blockNumber: 2n, replacedHash: hash, receipt: canonical }; });
    const result = await owner.submit(prepared, f.wallet);
    expect([...f.map.values()]).toEqual([thirdHash]);
    expect(result.kind === "terminal" && transactionMeaning(f.service, result.submitted)).toMatchObject({ purchase: true, raffleId: 3n });
  });

  it("automatically inspects old receipts without reading or rewriting a newer journal", async () => {
    const f = fixture();
    await createTransactionOutcomes(f.service, () => f.storage).submit(prepared, f.wallet);
    f.service.pending.mockResolvedValue({ id: "test-journal", hash: null, nonce: 9 });
    f.service.pending.mockClear(); f.service.resume.mockClear(); f.confirm.mockClear();
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    await owner.recover(account);
    expect(owner.getSnapshot(account)).toMatchObject([{ kind: "terminal" }]);
    expect(f.service.pending).not.toHaveBeenCalled();
    expect(f.service.resume).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("does not use a cold alias key as proof that another nonce's transaction was reconciled", async () => {
    const f = fixture();
    await createTransactionOutcomes(f.service, () => f.storage).submit(prepared, f.wallet);
    const otherHash: Hex = `0x${"cd".repeat(32)}`;
    for (const key of f.map.keys()) f.map.set(key, otherHash);
    const historical = { ...receipt, hash: otherHash, nonce: 7 };
    f.service.inspectOutcome.mockResolvedValue({ kind: "confirmed", hash: otherHash, blockNumber: 2n, replacedHash: null, receipt: historical });
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    await owner.recover(account);
    f.service.pending.mockResolvedValue({ id: "test-journal", hash, nonce: 1 });
    f.service.resume.mockImplementation(async input => { input.beforeJournalUpdate?.({ transaction: submitted, nonce: 1, pending: { id: "different-nonce", hash, nonce: 1 } }); return submitted; });
    await owner.resume(hash, f.wallet);
    expect(owner.getSnapshot(account)).toHaveLength(2);
    expect(new Set([...f.map.values()])).toEqual(new Set([hash, otherHash]));
  });

  it("preserves a verified historical nonce when a different nonce names the same prior hint", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const first = await owner.submit(prepared, f.wallet);
    const nextHash: Hex = `0x${"cd".repeat(32)}`, next = { ...submitted, hash: nextHash }, canonical = { ...receipt, hash: nextHash, nonce: 9 };
    f.service.pending.mockResolvedValue({ id: "test-journal", hash, nonce: 9 });
    f.service.resume.mockImplementation(async input => { input.beforeJournalUpdate?.({ transaction: next, nonce: 9, pending: { id: "different-nonce", hash, nonce: 9 } }); return next; });
    f.confirm.mockImplementation(async input => { input.beforeJournalClear?.({ receipt: canonical, pending: { id: "different-nonce", hash: nextHash, nonce: 9 } }); return { kind: "confirmed", hash: nextHash, blockNumber: 2n, replacedHash: null, receipt: canonical }; });
    await owner.resume(nextHash, f.wallet);
    expect(owner.getSnapshot(account)).toContain(first);
    expect(owner.getSnapshot(account)).toHaveLength(2);
    expect(new Set(f.map.values())).toEqual(new Set([hash, nextHash]));
  });

  it("classifies actual targets and calldata instead of current control labels", () => {
    const buy = { ...submitted, data: encodeFunctionData({ abi: raffleAbi, functionName: "buyPack", args: [2n, 0, 1, hash] }) };
    expect(transactionMeaning({ manifest }, buy)).toMatchObject({ purchase: true, raffleId: 2n });
    expect(transactionMeaning({ manifest }, submitted)).toMatchObject({ purchase: false, raffleId: 1n });
    expect(transactionMeaning({ manifest }, { ...buy, to: other })).toBeNull();
    expect(transactionMeaning({ manifest }, { ...buy, chainId: 1 })).toBeNull();
    expect(transactionMeaning({ manifest }, { ...submitted, to: other, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract, 100n] }) })).toBeNull();
  });
  it.each([false, true])("does not resume after the pending read changes wallet session (return to A: %s)", async backToA => {
    const f = fixture(), pending = deferred<Awaited<ReturnType<RaffleService["pending"]>>>();
    f.service.pending.mockImplementation(() => pending.promise);
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    const run = owner.resume(hash, f.wallet);
    f.switchWallet({ kind: "connected", account: other, chainId: 31337, revision: 2 });
    if (backToA) f.switchWallet({ kind: "connected", account, chainId: 31337, revision: 3 });
    pending.resolve(null);
    await expect(run).rejects.toThrow(/Wallet changed/);
    expect(f.service.resume).not.toHaveBeenCalled();
    expect(f.map.size).toBe(0);
  });

  it("rejects mismatched resume metadata before the callback can retain a checkpoint", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    f.service.pending.mockResolvedValue({ id: "test-journal", hash, nonce: 1 });
    f.service.resume.mockImplementation(async input => {
      const transaction: SubmittedAction = { ...submitted, account: other };
      input.beforeJournalUpdate?.({ transaction, nonce: 1, pending: { id: "test-journal", hash, nonce: 1 } });
      return transaction;
    });
    await expect(owner.resume(hash, f.wallet)).rejects.toThrow(/original wallet/);
    expect(f.map.size).toBe(0);
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("blocks overflow hints and makes progress to a hidden purchase through verified acknowledgment", async () => {
    const f = fixture();
    for (let index = 1; index <= 101; index++) {
      const hint = `0x${index.toString(16).padStart(64, "0")}`;
      f.map.set(`labx:outcome:v1:31337:${contract}:${hash}:${account}:${hint}`, hint);
    }
    f.service.inspectOutcome.mockImplementation(async ({ hash: hint }) => ({ ...confirmed, hash: hint, receipt: { ...receipt, hash: hint } }));
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    await owner.recover(account);
    expect(f.service.inspectOutcome).toHaveBeenCalledTimes(100);
    expect(owner.getSnapshot(account).some(item => item.kind === "overflow")).toBe(true);
    const first = owner.getSnapshot(account).find(item => item.kind === "terminal");
    if (!first) throw new Error("No canonical receipt");
    await owner.acknowledge(first);
    await vi.waitFor(() => expect(f.service.inspectOutcome).toHaveBeenCalledTimes(101));
    expect(owner.getSnapshot(account).some(item => item.kind === "overflow")).toBe(false);
    expect(owner.getSnapshot(account).some(item => "submitted" in item && item.submitted?.hash === `0x${(101).toString(16).padStart(64, "0")}`)).toBe(true);
  });

  it("does not acknowledge or reset a checkpoint after an async wallet session change", async () => {
    const f = fixture(), guard = deferred<void>(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const terminal = await owner.submit(prepared, f.wallet);
    f.service.acknowledgeOutcome.mockImplementation(async input => { await guard.promise; input.acknowledge(); });
    const run = owner.acknowledge(terminal, f.wallet);
    f.switchWallet({ kind: "connected", account, chainId: 31337, revision: 3 });
    guard.resolve();
    await expect(run).rejects.toThrow(/Wallet changed/);
    expect(owner.getSnapshot(account)).toEqual([terminal]);
    expect(f.map.size).toBe(1);
  });

  it("synchronizes another tab's canonical replacement and ignores the old watcher's late result", async () => {
    const f = fixture(), late = deferred<Confirmation>();
    const tabA = createTransactionOutcomes(f.service, () => f.storage), tabB = createTransactionOutcomes(f.service, () => f.storage);
    tabB.hydrate(account);
    f.confirm.mockImplementationOnce(() => late.promise);
    const original = tabA.submit(prepared, f.wallet);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(1));
    const replacementHash: Hex = `0x${"cd".repeat(32)}`, replacement = { ...submitted, hash: replacementHash }, canonical = { ...receipt, hash: replacementHash };
    f.service.pending.mockResolvedValue({ id: "test-journal", hash, nonce: 1 });
    f.service.resume.mockImplementation(async input => { input.beforeJournalUpdate?.({ transaction: replacement, nonce: 1, pending: { id: "shared", hash, nonce: 1 } }); return replacement; });
    f.confirm.mockImplementation(async input => { input.beforeJournalClear?.({ receipt: canonical, pending: { id: "shared", hash: replacementHash, nonce: 1 } }); f.service.pending.mockResolvedValue(null); return { ...confirmed, hash: replacementHash, receipt: canonical }; });
    await tabB.resume(replacementHash, f.wallet);
    f.service.inspectOutcome.mockResolvedValue({ ...confirmed, hash: replacementHash, receipt: canonical });
    await tabA.synchronize(account);
    late.resolve({ kind: "pending", hash });
    await original;
    expect(tabA.getSnapshot(account)).toMatchObject([{ kind: "terminal", submitted: { hash: replacementHash } }]);
    expect(await tabA.resume(hash, f.wallet)).toMatchObject({ kind: "terminal", submitted: { hash: replacementHash } });
    expect([...f.map.values()]).toEqual([replacementHash]);
  });

  it("retains local terminal receipts after remote acknowledgment until an explicit local acknowledgment", async () => {
    const f = fixture(), tabA = createTransactionOutcomes(f.service, () => f.storage), tabB = createTransactionOutcomes(f.service, () => f.storage);
    const local = await tabA.submit(prepared, f.wallet);
    await tabB.recover(account);
    await tabB.acknowledge(tabB.getSnapshot(account)[0], f.wallet);
    await tabA.synchronize(account);
    expect(tabA.getSnapshot(account)).toEqual([local]);
    expect(f.map.size).toBe(0);
    await tabA.acknowledge(local, f.wallet);
    expect(tabA.getSnapshot(account)).toEqual([]);
  });

  it("does not infer replacement lineage from a storage pointer to another verified nonce", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    f.confirm.mockResolvedValueOnce({ kind: "pending", hash });
    await owner.submit(prepared, f.wallet);
    const unrelated: Hex = `0x${"cd".repeat(32)}`;
    for (const key of f.map.keys()) f.map.set(key, unrelated);
    f.service.inspectOutcome.mockResolvedValue({ ...confirmed, hash: unrelated, receipt: { ...receipt, hash: unrelated, nonce: 9 } });
    await owner.synchronize(account);
    expect(owner.getSnapshot(account)).toMatchObject([{ kind: "unverified", message: expect.stringMatching(/verified nonce/) }]);
    expect([...f.map.values()]).toEqual([unrelated]);
  });

  it("keeps deleted unknown saved activity blocking and never persists unowned unknown input", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    f.service.inspectOutcome.mockResolvedValue({ kind: "unknown", hash, reason: "RPC unavailable" });
    expect(await owner.resume(hash, f.wallet)).toMatchObject({ kind: "unverified" });
    expect(f.map.size).toBe(0);
    expect(owner.getSnapshot(account)).toEqual([]);
    const key = `labx:outcome:v1:31337:${contract}:${hash}:${account}:${hash}`;
    f.map.set(key, hash);
    await owner.synchronize(account);
    f.map.delete(key);
    await owner.synchronize(account);
    expect(owner.getSnapshot(account)).toMatchObject([{ kind: "unverified", hash }]);
  });

  it("does not silently ignore a different saved hash reusing an acknowledged storage key", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const terminal = await owner.submit(prepared, f.wallet);
    const key = [...f.map.keys()][0];
    await owner.acknowledge(terminal, f.wallet);
    f.map.set(key, `0x${"cd".repeat(32)}`);
    await owner.synchronize(account);
    expect(owner.getSnapshot(account)).toMatchObject([{ kind: "error", id: "storage-error" }]);
    expect(f.map.size).toBe(1);
  });

  it("recovers a cold tab's observed pending nonce from canonical storage events even after remote deletion", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const key = `labx:outcome:v1:31337:${contract}:${hash}:${account}:${hash}`;
    f.map.set(key, hash);
    f.service.inspectOutcome.mockResolvedValue({ kind: "pending", hash, reason: "unmined", transaction: { ...submitted, nonce: 1 } });
    const events = Object.assign(new EventTarget(), { localStorage: f.storage });
    vi.stubGlobal("window", events);
    const stop = owner.observe(account);
    try {
      await owner.recover(account);
      expect(owner.getSnapshot(account)).toMatchObject([{ kind: "unverified", hash }]);
      const replacementHash: Hex = `0x${"cd".repeat(32)}`;
      f.service.inspectOutcome.mockResolvedValue({ ...confirmed, hash: replacementHash, receipt: { ...receipt, hash: replacementHash } });
      f.map.delete(key);
      events.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: replacementHash, storageArea: f.storage }));
      events.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: null, storageArea: f.storage }));
      await vi.waitFor(() => expect(owner.getSnapshot(account)).toMatchObject([{ kind: "terminal", submitted: { hash: replacementHash } }]));
      expect(owner.getSnapshot(account)).toHaveLength(1);
    } finally { stop(); vi.unstubAllGlobals(); }
  });

  it("keeps a late terminal watch local after another tab acknowledges its checkpoint", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const held = deferred<Confirmation>();
    f.confirm.mockImplementation(async input => {
      const result = await held.promise;
      input.beforeJournalClear?.({ receipt, pending: null });
      return result;
    });
    const watching = owner.submit(prepared, f.wallet);
    await vi.waitFor(() => expect(f.map.size).toBe(1));
    f.map.clear();
    held.resolve(confirmed);
    expect(await watching).toMatchObject({ kind: "terminal", submitted: { hash } });
    expect(f.map.size).toBe(0);
    expect(owner.getSnapshot(account)).toHaveLength(1);
  });

  it("does not persist automatic historical completion after remote deletion, while explicit new history may persist", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const key = `labx:outcome:v1:31337:${contract}:${hash}:${account}:${hash}`;
    f.map.set(key, hash);
    const held = deferred<OutcomeInspection>();
    f.service.inspectOutcome.mockImplementationOnce(() => held.promise);
    const recovery = owner.recover(account);
    await vi.waitFor(() => expect(f.service.inspectOutcome).toHaveBeenCalledOnce());
    f.map.clear();
    held.resolve(confirmed);
    await recovery;
    expect(owner.getSnapshot(account)).toMatchObject([{ kind: "terminal", submitted: { hash } }]);
    expect(f.map.size).toBe(0);
    await owner.resume(hash, f.wallet);
    expect(f.map.size).toBe(0);
    const separate = createTransactionOutcomes(f.service, () => f.storage);
    expect(await separate.resume(hash, f.wallet)).toMatchObject({ kind: "terminal" });
    expect([...f.map.values()]).toEqual([hash]);
  });

  it.each(["pending", "unknown", "error"] as const)("keeps queued H2 after remote acknowledgment despite a late H1 %s", async completion => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const key = `labx:outcome:v1:31337:${contract}:${hash}:${account}:${hash}`;
    const replacementHash: Hex = `0x${"cd".repeat(32)}`;
    const pending: OutcomeInspection = { kind: "pending", hash, reason: "unmined", transaction: { ...submitted, nonce: 1 } };
    f.map.set(key, hash);
    f.service.inspectOutcome.mockResolvedValue(pending);
    const events = Object.assign(new EventTarget(), { localStorage: f.storage });
    vi.stubGlobal("window", events);
    const stop = owner.observe(account);
    try {
      await owner.recover(account);
      const held = deferred<OutcomeInspection>();
      f.service.inspectOutcome.mockImplementationOnce(() => held.promise.then(result => {
        if (completion === "error") throw new Error("Delayed RPC failure");
        return result;
      }));
      const rescanning = owner.synchronize(account);
      await vi.waitFor(() => expect(f.service.inspectOutcome).toHaveBeenCalledTimes(2));
      f.service.inspectOutcome.mockResolvedValue({ ...confirmed, hash: replacementHash, receipt: { ...receipt, hash: replacementHash } });
      f.map.delete(key);
      events.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: replacementHash, storageArea: f.storage }));
      events.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: null, storageArea: f.storage }));
      expect(owner.getSnapshot(account)).toMatchObject([{ kind: "recovery", hash: replacementHash }]);
      held.resolve(completion === "unknown" ? { kind: "unknown", hash, reason: "Receipt unavailable" } : pending);
      await rescanning;
      expect(owner.getSnapshot(account)).toMatchObject([{ kind: "terminal", submitted: { hash: replacementHash } }]);
      expect(owner.getSnapshot(account)).toHaveLength(1);
      expect(f.service.inspectOutcome).toHaveBeenCalledWith(expect.objectContaining({ hash: replacementHash }));
    } finally { stop(); vi.unstubAllGlobals(); }
  });

  it.each([false, true])("preserves observed original intent across another tab's canonical receipt (same intent: %s)", async repriced => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    f.confirm.mockResolvedValueOnce({ kind: "pending", hash });
    await owner.submit(prepared, f.wallet);
    const replacementHash: Hex = `0x${"cd".repeat(32)}`;
    const canonical: CanonicalReceipt = { ...receipt, hash: replacementHash, ...(repriced ? {} : { to: account, data: "0x" as const }) };
    for (const key of f.map.keys()) f.map.set(key, replacementHash);
    f.service.inspectOutcome.mockResolvedValue({ ...confirmed, hash: replacementHash, receipt: canonical });
    await owner.synchronize(account);
    expect(await owner.resume(hash, f.wallet)).toMatchObject({ kind: "terminal", confirmation: { kind: repriced ? "confirmed" : "replaced" }, submitted: { hash: replacementHash } });
    const separate = memoryStorage(), unowned = createTransactionOutcomes(f.service, () => separate.storage);
    expect(await unowned.resume(replacementHash, f.wallet)).toMatchObject({ kind: "terminal", confirmation: { kind: "confirmed" } });
  });

});
