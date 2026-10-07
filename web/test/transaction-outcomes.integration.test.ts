import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
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
});
