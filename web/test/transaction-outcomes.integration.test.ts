import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, keccak256, toBytes, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { createRaffleService } from "../lib/chain/service";
import { memoryPendingJournal, transactionIntent } from "../lib/chain/pending-journal";
import { createTransactionOutcomes, type OutcomeStorage } from "../lib/chain/transaction-outcomes";
import { hash } from "../lib/chain/validation";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import { localChain, type LocalChain } from "./fixtures/local-chain";
const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
function memoryStorage() {
  const map = new Map<string, string>();
  const storage: OutcomeStorage = { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); } };
  return { map, storage };
}
run("canonical outcome recovery on isolated Anvil", () => {
  let chain: LocalChain, service: RaffleService, wallet: WalletSessionPort;
  const journal = memoryPendingJournal();
  beforeAll(async () => { chain = await localChain(); service = createRaffleService(chain.client, chain.manifest, journal); wallet = chain.wallet(chain.buyer).session; await wallet.connect(); }, 30_000);
  afterAll(() => chain?.close());
  afterEach(() => { if (chain) journal.remove(chain.buyer); });
  const send = async (to: string | null, data: Hex = "0x", extra: Record<string, string> = {}) => hash(await chain.rpc("eth_sendTransaction", [{ from: chain.buyer, ...(to ? { to } : {}), data, value: "0x0", gas: "0x186a0", ...extra }]));
  async function depth() { await chain.mine(); await chain.mine(); }
  const approvalData = () => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [chain.raffle.address, 100n] });

  it("inspects canonical cancellation and contract creation without touching a newer journal", async () => {
    const cancel = await send(chain.buyer), creation = await send(null, "0x60006000f3");
    await depth();
    const newer = { id: "newer", hash: null, nonce: 999, startedBlock: "1", intentHash: transactionIntent({ to: chain.usdc.address, data: approvalData(), value: 0n }) };
    journal.write(chain.buyer, newer);
    expect(await service.inspectOutcome({ hash: cancel, account: chain.buyer })).toMatchObject({ kind: "confirmed", receipt: { hash: cancel, to: chain.buyer.toLowerCase(), data: "0x" } });
    expect(await service.inspectOutcome({ hash: creation, account: chain.buyer })).toMatchObject({ kind: "confirmed", receipt: { hash: creation, to: null } });
    expect(journal.read(chain.buyer)).toEqual(newer);
    journal.remove(chain.buyer);
    await expect(service.resume({ hash: creation, wallet })).rejects.toThrow(/supported LABx/);
  });

  it("keeps the journal on pre-clear persistence failure and recovers both crash boundaries", async () => {
    const txHash = await send(chain.usdc.address, approvalData()); await depth();
    const submitted = await service.resume({ hash: txHash, wallet });
    const before = journal.read(chain.buyer);
    const { map, storage } = memoryStorage();
    const key = `labx:outcome:v1:31337:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${chain.buyer.toLowerCase()}:${txHash}`;
    await expect(service.confirm({ transaction: submitted, beforeJournalClear({ receipt }) { storage.setItem(key, receipt.hash); throw new Error("Crash after canonical persistence"); } })).rejects.toThrow(/Crash after canonical/);
    expect(journal.read(chain.buyer)).toEqual(before);
    const restored = createTransactionOutcomes(service, () => storage);
    await restored.recover(chain.buyer);
    expect(restored.getSnapshot(chain.buyer)).toMatchObject([{ kind: "terminal" }]);
    expect(journal.read(chain.buyer)).toEqual(before);
    const terminal = restored.getSnapshot(chain.buyer)[0];
    await expect(restored.acknowledge(terminal, wallet)).rejects.toThrow(/Reconcile pending/);
    expect([...map.values()]).toEqual([txHash]);
    await restored.resume(txHash, wallet);
    expect(journal.read(chain.buyer)).toBeNull();
    // The same durable checkpoint also survives losing the owner after journal clearance.
    const afterClear = createTransactionOutcomes(service, () => storage);
    await afterClear.recover(chain.buyer);
    expect(afterClear.getSnapshot(chain.buyer)).toMatchObject([{ kind: "terminal", submitted: { hash: txHash } }]);
    expect([...map.values()]).toEqual([txHash]);
  });

  it("retains the prior journal hash when pre-update persistence fails", async () => {
    const txHash = await send(chain.usdc.address, approvalData()); await depth();
    const transaction = await chain.client.getTransaction({ hash: txHash });
    const before = { id: "pre-update", hash: null, nonce: transaction.nonce, startedBlock: "1", intentHash: transactionIntent({ to: chain.usdc.address, data: approvalData(), value: 0n }) };
    journal.write(chain.buyer, before);
    await expect(service.resume({ hash: txHash, wallet, beforeJournalUpdate() { throw new Error("Storage denied"); } })).rejects.toThrow(/Storage denied/);
    expect(journal.read(chain.buyer)).toEqual(before);
    journal.remove(chain.buyer);
  });

  it("reconciles H1 to same-nonce H2 cancellation, removes the stale blocker and recovers H2 after reload", async () => {
    const { storage, map } = memoryStorage();
    const owner = createTransactionOutcomes({ ...service, confirm: input => service.confirm({ ...input, timeoutMs: 1000 }) }, () => storage);
    await chain.rpc("evm_setAutomine", [false]);
    try {
      const nonce = await chain.client.getTransactionCount({ address: chain.buyer, blockTag: "pending" });
      const first = await send(chain.usdc.address, approvalData(), { nonce: `0x${nonce.toString(16)}`, gasPrice: "0x77359400" });
      journal.write(chain.buyer, { id: "replacement", hash: first, nonce, startedBlock: (await chain.client.getBlockNumber()).toString(), intentHash: transactionIntent({ to: chain.usdc.address, data: approvalData(), value: 0n }) });
      const original = { hash: first, account: chain.buyer, chainId: 31337, to: chain.usdc.address, data: approvalData(), value: 0n };
      expect(await owner.confirm(original)).toMatchObject({ kind: "pending" });
      const second = await send(chain.buyer, "0x", { nonce: `0x${nonce.toString(16)}`, gasPrice: "0xb2d05e00" });
      await depth();
      const terminal = await owner.resume(second, wallet);
      expect(terminal).toMatchObject({ kind: "terminal", id: first, confirmation: { kind: "replaced" }, submitted: { hash: second, to: chain.buyer.toLowerCase() } });
      expect(owner.getSnapshot(chain.buyer)).toEqual([terminal]);
      expect(journal.read(chain.buyer)).toBeNull();
      expect([...map.values()]).toEqual([second]);
      const reloaded = createTransactionOutcomes(service, () => storage);
      await reloaded.recover(chain.buyer);
      expect(reloaded.getSnapshot(chain.buyer)).toMatchObject([{ kind: "terminal", submitted: { hash: second, to: chain.buyer.toLowerCase() } }]);
    } finally { await chain.rpc("evm_setAutomine", [true]); }
  }, 15_000);
  it("requires service-issued canonical metadata and checks fresh same/older/newer journal nonces atomically", async () => {
    const txHash = await send(chain.buyer); await depth();
    const result = await service.inspectOutcome({ hash: txHash, account: chain.buyer });
    if (result.kind === "pending") throw new Error("Expected canonical receipt");
    let acknowledgments = 0;
    const acknowledge = () => { acknowledgments++; };
    await expect(service.acknowledgeOutcome({ receipt: { ...result.receipt, nonce: 0 }, acknowledge })).rejects.toThrow(/Verify the canonical/);
    for (const nonce of [result.receipt.nonce, Math.max(0, result.receipt.nonce - 1)]) {
      const pending = { id: "unresolved", hash: null, nonce, startedBlock: "1", intentHash: transactionIntent({ to: chain.usdc.address, data: approvalData(), value: 0n }) };
      journal.write(chain.buyer, pending);
      await expect(service.acknowledgeOutcome({ receipt: result.receipt, acknowledge })).rejects.toThrow(/Reconcile pending/);
      expect(journal.read(chain.buyer)).toEqual(pending);
    }
    const newer = { id: "newer", hash: null, nonce: result.receipt.nonce + 1, startedBlock: "1", intentHash: transactionIntent({ to: chain.usdc.address, data: approvalData(), value: 0n }) };
    journal.write(chain.buyer, newer);
    await service.acknowledgeOutcome({ receipt: result.receipt, acknowledge });
    expect(journal.read(chain.buyer)).toEqual(newer);
    expect(acknowledgments).toBe(1);
  });

  it.each(["cancellation", "purchase"] as const)("preserves a canonical replacement %s checkpoint after a pre-clear crash until guarded resume", async kind => {
    const { storage, map } = memoryStorage();
    let to = chain.buyer, data: Hex = "0x";
    if (kind === "purchase") {
      await chain.write(chain.nft, "mint", [chain.seller, 999n]);
      const block = await chain.client.getBlock();
      const reserve = keccak256(toBytes("replacement-purchase"));
      await chain.write(chain.raffle, "createRaffle", [chain.nft.address, 999n, block.timestamp + 3600n, reserve, reserve, "Replacement purchase", [{ name: "Entry", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 }]], chain.seller);
      const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
      await chain.write(chain.nft, "approve", [chain.raffle.address, 999n], chain.seller);
      await chain.write(chain.raffle, "escrow", [id], chain.seller);
      await chain.admit(id);
      const policy = await service.openingPolicy();
      await chain.write(chain.raffle, "openWithPolicy", [id, policy.hash], chain.seller);
      await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
      await chain.write(chain.usdc, "approve", [chain.raffle.address, 100_000_000n], chain.buyer);
      to = chain.raffle.address;
      data = encodeFunctionData({ abi: raffleAbi, functionName: "buyPack", args: [id, 0, 1, PUBLISHED_TERMS_HASH] });
    }
    await chain.rpc("evm_setAutomine", [false]);
    try {
      const nonce = await chain.client.getTransactionCount({ address: chain.buyer, blockTag: "pending" });
      const first = await send(chain.usdc.address, approvalData(), { nonce: `0x${nonce.toString(16)}`, gasPrice: "0x77359400" });
      const pending = { id: "crash-replacement", hash: first, nonce, startedBlock: "1", intentHash: transactionIntent({ to: chain.usdc.address, data: approvalData(), value: 0n }) };
      journal.write(chain.buyer, pending);
      const key = `labx:outcome:v1:31337:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${chain.buyer.toLowerCase()}:${first}`;
      const watching = expect(service.confirm({ transaction: { hash: first, account: chain.buyer, chainId: 31337, to: chain.usdc.address, data: approvalData(), value: 0n }, timeoutMs: 3000, beforeJournalClear({ receipt }) { storage.setItem(key, receipt.hash); throw new Error("Crash before clear"); } })).rejects.toThrow(/Crash before clear/);
      // Let the receipt watcher observe the pending original before Anvil replaces it.
      await new Promise(resolve => setTimeout(resolve, 100));
      const second = await send(to, data, { nonce: `0x${nonce.toString(16)}`, gasPrice: "0xb2d05e00", gas: "0x989680" });
      await chain.mine();
      await new Promise(resolve => setTimeout(resolve, 100));
      await chain.mine();
      await watching;
      const restored = createTransactionOutcomes(service, () => storage);
      await restored.recover(chain.buyer);
      const terminal = restored.getSnapshot(chain.buyer)[0];
      expect(terminal).toMatchObject({ kind: "terminal", submitted: { hash: second }, confirmation: { receipt: { status: "success" } } });
      await expect(restored.acknowledge(terminal, wallet)).rejects.toThrow(/Reconcile pending/);
      expect([...map.values()]).toEqual([second]);
      expect(journal.read(chain.buyer)).toEqual(pending);
      await restored.resume(second, wallet);
      expect(journal.read(chain.buyer)).toBeNull();
      await restored.acknowledge(terminal, wallet);
      expect(map.size).toBe(0);
    } finally { await chain.rpc("evm_setAutomine", [true]); }
  }, 15_000);

});
