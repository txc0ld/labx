import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { createTransactionOutcomes, transactionMeaning, type OutcomeStorage } from "../lib/chain/transaction-outcomes";
import type { Confirmation, DeploymentManifest, PreparedAction, SubmittedAction, WalletSnapshot } from "../lib/chain/types";
import type { WalletSessionPort } from "../lib/chain/ports";

const account = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const contract = "0x3333333333333333333333333333333333333333";
const hash: Hex = `0x${"ab".repeat(32)}`;
const manifest: DeploymentManifest = { chainId: 31337, address: contract, usdc: other, runtimeCodeHash: hash, deploymentBlock: 1n, version: 3 };
const submitted: SubmittedAction = { hash, account, chainId: 31337, to: contract, data: encodeFunctionData({ abi: raffleAbi, functionName: "refund", args: [1n] }), value: 0n };
const prepared: PreparedAction = { ...submitted, action: { kind: "refund", id: 1n }, title: "Refund", amountUsdc: 1n, recipient: account, block: { number: 1n, hash, timestamp: 1n }, walletRevision: 1 };
const confirmed: Confirmation = { kind: "confirmed", hash, blockNumber: 2n, replacedHash: null };
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
  const service = { manifest, submit: vi.fn(async () => submitted), resume: vi.fn(async () => submitted), confirm: vi.fn(async (): Promise<Confirmation> => confirmed) };
  const { storage, map } = memoryStorage();
  return { service, wallet, storage, map, switchWallet(next: WalletSnapshot) { snapshot = next; } };
}

describe("operation ownership beyond transaction controls", () => {
  it("continues submission and confirmation after every subscriber detaches, isolating A from B and restoring A", async () => {
    const f = fixture(), send = deferred<SubmittedAction>(), receipt = deferred<Confirmation>();
    f.service.submit.mockImplementation(() => send.promise);
    f.service.confirm.mockImplementation(() => receipt.promise);
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    const listener = vi.fn(), unsubscribe = owner.subscribe(listener);
    const run = owner.submit(prepared, f.wallet);
    expect(owner.getSnapshot(account)[0].kind).toBe("submitting");
    unsubscribe();
    f.switchWallet({ kind: "connected", account: other, chainId: 31337, revision: 2 });
    send.resolve(submitted);
    await vi.waitFor(() => expect(f.service.confirm).toHaveBeenCalledTimes(1));
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
    f.service.confirm.mockImplementation(() => receipt.promise);
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    const first = owner.confirm(submitted), second = owner.confirm(submitted);
    expect(f.service.confirm).toHaveBeenCalledTimes(1);
    receipt.resolve(confirmed);
    expect(await first).toBe(await second);
    expect(owner.claimRefresh("raffle-1:A:revision-1:hash")).toBe(true);
    expect(owner.claimRefresh("raffle-1:A:revision-1:hash")).toBe(false);
    expect(owner.claimRefresh("raffle-2:A:revision-1:hash")).toBe(true);
  });

  it.each(["pending", "reverted", "replaced"] as const)("retains the canonical %s outcome without claiming a purchase", async kind => {
    const f = fixture();
    f.service.confirm.mockResolvedValue(kind === "pending" ? { kind, hash } : { kind, hash, reason: "Canonical result" });
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
    expect(f.service.confirm).not.toHaveBeenCalled();
  });

  it("hydrates only unverified hashes, survives owner recreation and requires service revalidation", async () => {
    const f = fixture();
    await createTransactionOutcomes(f.service, () => f.storage).confirm(submitted);
    f.service.confirm.mockClear();
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    owner.hydrate(other);
    expect(owner.getSnapshot(other)).toEqual([]);
    owner.hydrate(account);
    expect(owner.getSnapshot(account)).toEqual([{ kind: "recovery", id: hash, account, hash }]);
    expect(f.service.confirm).not.toHaveBeenCalled();
    await owner.resume(hash, f.wallet);
    expect(f.service.resume).toHaveBeenCalledTimes(1);
    expect(f.service.confirm).toHaveBeenCalledTimes(1);
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
    f.service.confirm.mockResolvedValueOnce({ kind: "pending", hash });
    const pending = await owner.confirm(submitted);
    owner.acknowledge(pending);
    expect(f.map.size).toBe(1);
    const terminal = await owner.confirm(submitted);
    owner.acknowledge({ ...terminal });
    expect(f.map.size).toBe(1);
    owner.acknowledge(terminal);
    expect(f.map.size).toBe(0);
    expect(owner.getSnapshot(account)).toEqual([]);
  });

  it("does not recreate a nonce journal when rechecking an already owned terminal outcome", async () => {
    const f = fixture(), owner = createTransactionOutcomes(f.service, () => f.storage);
    const terminal = await owner.confirm(submitted);
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
    expect(f.service.confirm).not.toHaveBeenCalled();
  });

  it.each([{ code: "4001" }, { cause: { code: 4001 } }, new Error("The wallet response is uncertain")])("retains uncertain failures instead of claiming rejection", async error => {
    const f = fixture();
    f.service.submit.mockRejectedValue(error);
    const owner = createTransactionOutcomes(f.service, () => f.storage);
    expect(await owner.submit(prepared, f.wallet)).toMatchObject({ kind: "error" });
    expect(f.service.confirm).not.toHaveBeenCalled();
  });

  it("classifies actual targets and calldata instead of current control labels", () => {
    const buy = { ...submitted, data: encodeFunctionData({ abi: raffleAbi, functionName: "buyPack", args: [2n, 0, 1, hash] }) };
    expect(transactionMeaning({ manifest }, buy)).toMatchObject({ purchase: true, raffleId: 2n });
    expect(transactionMeaning({ manifest }, submitted)).toMatchObject({ purchase: false, raffleId: 1n });
    expect(transactionMeaning({ manifest }, { ...buy, to: other })).toBeNull();
    expect(transactionMeaning({ manifest }, { ...buy, chainId: 1 })).toBeNull();
    expect(transactionMeaning({ manifest }, { ...submitted, to: other, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract, 100n] }) })).toBeNull();
  });
});
