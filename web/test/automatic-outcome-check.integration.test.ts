import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { startSavedHashCheck } from "../components/workflow/useTransactionOutcomes";
import { createRaffleService } from "../lib/chain/service";
import { memoryPendingJournal, transactionIntent } from "../lib/chain/pending-journal";
import { createTransactionOutcomes, type OutcomeStorage } from "../lib/chain/transaction-outcomes";
import { hash } from "../lib/chain/validation";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
function memoryStorage(): OutcomeStorage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); } };
}
const alwaysVisible = { visible: () => true, onVisible: () => () => {} };

run("automatic saved-hash check on isolated Anvil", () => {
  let chain: LocalChain, service: RaffleService, wallet: WalletSessionPort;
  const journal = memoryPendingJournal();
  beforeAll(async () => {
    chain = await localChain();
    service = createRaffleService(chain.client, chain.manifest, journal);
    wallet = chain.wallet(chain.buyer).session;
    await wallet.connect();
  }, 30_000);
  afterAll(() => chain?.close());
  afterEach(() => { if (chain) journal.remove(chain.buyer); vi.restoreAllMocks(); });

  const approval = () => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [chain.raffle.address, 12_500_000n] });
  async function sendSaved(to: Address, data: Hex, intent = transactionIntent({ to, data, value: 0n })) {
    const startedBlock = await chain.client.getBlockNumber({ cacheTime: 0 });
    const txHash = hash(await chain.rpc("eth_sendTransaction", [{ from: chain.buyer, to, data, value: "0x0", gas: "0x186a0" }]));
    const sent = await chain.client.getTransaction({ hash: txHash });
    journal.write(chain.buyer, { id: `saved-${txHash.slice(2, 10)}`, hash: txHash, nonce: sent.nonce, startedBlock: startedBlock.toString(), intentHash: intent });
    return txHash;
  }
  function watchWallet() {
    return [
      vi.spyOn(wallet, "connect"), vi.spyOn(wallet, "requestTransaction"), vi.spyOn(wallet, "signMessage")
    ];
  }
  function start(txHash: Hex) {
    const owner = createTransactionOutcomes(service, memoryStorage);
    const onAttention = vi.fn(), onSettled = vi.fn();
    const stop = startSavedHashCheck({ owner, service, wallet, account: chain.buyer, hash: txHash, onAttention, onSettled, visibility: alwaysVisible });
    return { owner, onAttention, onSettled, stop };
  }

  it("keeps the journal through one confirmation and clears it through the canonical path after two", async () => {
    const walletCalls = watchWallet();
    const txHash = await sendSaved(chain.usdc.address, approval());
    const check = start(txHash);
    try {
      await new Promise(resolve => setTimeout(resolve, 3_500));
      expect(journal.read(chain.buyer)?.hash).toBe(txHash);
      expect(check.onAttention).not.toHaveBeenCalled();
      await chain.mine();
      await vi.waitFor(() => expect(journal.read(chain.buyer)).toBeNull(), { timeout: 20_000, interval: 100 });
      expect(check.owner.getSnapshot(chain.buyer)).toMatchObject([{ kind: "terminal", submitted: { hash: txHash }, confirmation: { kind: "confirmed" } }]);
      await vi.waitFor(() => expect(check.onSettled).toHaveBeenCalled(), { timeout: 10_000, interval: 100 });
      expect(check.onAttention).not.toHaveBeenCalled();
      for (const call of walletCalls) expect(call).not.toHaveBeenCalled();
    } finally { check.stop(); }
  }, 40_000);

  it("leaves a reverted receipt in the journal for the person", async () => {
    const walletCalls = watchWallet();
    // transferFrom without an allowance reverts on the mock token.
    const reverting = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [chain.treasury, chain.buyer, 1n] });
    const txHash = await sendSaved(chain.usdc.address, reverting);
    await chain.mine(); await chain.mine();
    expect((await chain.client.getTransactionReceipt({ hash: txHash })).status).toBe("reverted");
    const saved = journal.read(chain.buyer);
    const check = start(txHash);
    try {
      await vi.waitFor(() => expect(check.onAttention).toHaveBeenCalled(), { timeout: 10_000, interval: 100 });
      expect(journal.read(chain.buyer)).toEqual(saved);
      expect(check.owner.getSnapshot(chain.buyer)).toEqual([]);
      for (const call of walletCalls) expect(call).not.toHaveBeenCalled();
    } finally { check.stop(); }
  }, 30_000);

  it("leaves a confirmed transaction whose intent differs from the journal for the person", async () => {
    const txHash = await sendSaved(chain.usdc.address, approval(), transactionIntent({ to: chain.usdc.address, data: "0x", value: 0n }));
    await chain.mine(); await chain.mine();
    const saved = journal.read(chain.buyer);
    const check = start(txHash);
    try {
      await vi.waitFor(() => expect(check.onAttention).toHaveBeenCalled(), { timeout: 10_000, interval: 100 });
      expect(journal.read(chain.buyer)).toEqual(saved);
      expect(check.owner.getSnapshot(chain.buyer)).toEqual([]);
    } finally { check.stop(); }
  }, 30_000);
});
