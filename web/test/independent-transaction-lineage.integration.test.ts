import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublicClient, custom, encodeFunctionData, erc20Abi, keccak256, toBytes, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { memoryPendingJournal, transactionIntent } from "../lib/chain/pending-journal";
import { createRaffleService } from "../lib/chain/service";
import { createTransactionOutcomes, transactionMeaning, type OutcomeStorage, type TransactionOutcome } from "../lib/chain/transaction-outcomes";
import { hash } from "../lib/chain/validation";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { SubmittedAction } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_INDEPENDENT_TRANSACTION_LINEAGE === "1" ? describe : describe.skip;

function memoryStorage() {
  const map = new Map<string, string>();
  const storage: OutcomeStorage = {
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: key => { map.delete(key); }
  };
  return { map, storage };
}

function blocking(outcome: TransactionOutcome) {
  return outcome.kind === "overflow"
    || outcome.kind === "submitting"
    || outcome.kind === "checking"
    || outcome.kind === "pending"
    || outcome.kind === "recovery"
    || outcome.kind === "unverified"
    || outcome.kind === "error" && (outcome.submitted !== null || outcome.id === "storage-error");
}

function includesHash(value: string, transactionHash: Hex) {
  return value.toLowerCase().includes(transactionHash.toLowerCase());
}

run("independent transaction replacement lineage on isolated Anvil", () => {
  let chain: LocalChain;
  let snapshot: unknown;

  beforeAll(async () => { chain = await localChain(); }, 30_000);
  beforeEach(async () => { snapshot = await chain.rpc("evm_snapshot"); });
  afterEach(async () => {
    await chain.rpc("evm_setAutomine", [true]);
    await chain.rpc("evm_revert", [snapshot]);
  });
  afterAll(() => chain?.close());

  function approvalData() {
    return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [chain.raffle.address, 100n] });
  }

  async function send(from: Address, to: Address, data: Hex, nonce: number, gasPrice: Hex) {
    return hash(await chain.rpc("eth_sendTransaction", [{
      from,
      to,
      data,
      nonce: `0x${nonce.toString(16)}`,
      gasPrice,
      gas: "0x989680",
      value: "0x0"
    }]));
  }

  function submitted(transactionHash: Hex, account: Address, to: Address, data: Hex): SubmittedAction {
    return { hash: transactionHash, account, chainId: chain.manifest.chainId, to, data, value: 0n };
  }

  async function replacementFixture(storage: OutcomeStorage, hydrateReplacementTab = false) {
    const journal = memoryPendingJournal();
    const service = createRaffleService(chain.client, chain.manifest, journal);
    const wallet = chain.wallet(chain.buyer).session;
    await wallet.connect();
    const tabA = createTransactionOutcomes({ ...service, confirm: input => service.confirm({ ...input, timeoutMs: 1000 }) }, () => storage);
    const tabB = createTransactionOutcomes({ ...service, confirm: input => service.confirm({ ...input, timeoutMs: 1000 }) }, () => storage);
    if (hydrateReplacementTab) tabB.hydrate(chain.buyer);

    await chain.rpc("evm_setAutomine", [false]);
    const nonce = await chain.client.getTransactionCount({ address: chain.buyer, blockTag: "pending" });
    const data = approvalData();
    const h1 = await send(chain.buyer, chain.usdc.address, data, nonce, "0x77359400");
    journal.write(chain.buyer, {
      id: "independent-lineage",
      hash: h1,
      nonce,
      startedBlock: (await chain.client.getBlockNumber()).toString(),
      intentHash: transactionIntent({ to: chain.usdc.address, data, value: 0n })
    });
    const original = submitted(h1, chain.buyer, chain.usdc.address, data);
    expect(await tabA.confirm(original)).toMatchObject({ kind: "pending", submitted: { hash: h1 } });
    expect(journal.read(chain.buyer)).toMatchObject({ hash: h1, nonce });

    const h2 = await send(chain.buyer, chain.buyer, "0x", nonce, "0xb2d05e00");
    await chain.mine();
    await chain.mine();
    return { journal, service, wallet, tabA, tabB, original, h1, h2 };
  }

  it("does not recreate stale H1 after its same-nonce H2 was reconciled in the persistent flow", async () => {
    const { map, storage } = memoryStorage();
    const fixture = await replacementFixture(storage);
    const canonical = await fixture.tabA.resume(fixture.h2, fixture.wallet);
    expect(canonical).toMatchObject({ kind: "terminal", id: fixture.h1, submitted: { hash: fixture.h2 } });
    expect(fixture.journal.read(chain.buyer)).toBeNull();

    await fixture.tabA.confirm(fixture.original);

    expect(map.size).toBe(1);
    expect([...map.values()].some(value => includesHash(value, fixture.h2))).toBe(true);
    expect(fixture.tabA.getSnapshot(chain.buyer).filter(blocking)).toEqual([]);
    expect(fixture.tabA.getSnapshot(chain.buyer)).toMatchObject([
      { kind: "terminal", submitted: { hash: fixture.h2 } }
    ]);
    const reloaded = createTransactionOutcomes(fixture.service, () => storage);
    await reloaded.recover(chain.buyer);
    expect(reloaded.getSnapshot(chain.buyer).filter(blocking)).toEqual([]);
    expect(reloaded.getSnapshot(chain.buyer)).toMatchObject([
      { kind: "terminal", submitted: { hash: fixture.h2 } }
    ]);
  }, 15_000);

  it("rewrites stored H1 lineage when a tab hydrated before another tab submitted it", async () => {
    const { map, storage } = memoryStorage();
    const fixture = await replacementFixture(storage, true);
    const canonical = await fixture.tabB.resume(fixture.h2, fixture.wallet);
    expect(canonical).toMatchObject({ kind: "terminal", submitted: { hash: fixture.h2 } });
    expect(fixture.journal.read(chain.buyer)).toBeNull();
    expect(map.size).toBe(1);
    expect([...map.values()].some(value => includesHash(value, fixture.h2))).toBe(true);

    const reloaded = createTransactionOutcomes(fixture.service, () => storage);
    await reloaded.recover(chain.buyer);
    expect(reloaded.getSnapshot(chain.buyer).filter(blocking)).toEqual([]);
    expect(reloaded.getSnapshot(chain.buyer)).toMatchObject([
      { kind: "terminal", submitted: { hash: fixture.h2 } }
    ]);
  }, 15_000);

  async function confirmedPurchaseCheckpoint(storage: OutcomeStorage) {
    const journal = memoryPendingJournal();
    const service = createRaffleService(chain.client, chain.manifest, journal);
    const wallet = chain.wallet(chain.buyer).session;
    await wallet.connect();
    const block = await chain.client.getBlock();
    const reserve = keccak256(toBytes("independent-slow-receipt"));
    await chain.write(chain.nft, "mint", [chain.seller, 7001n]);
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      7001n,
      block.timestamp + 3600n,
      reserve,
      reserve,
      "Independent slow receipt",
      [{ name: "Entry", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 }]
    ], chain.seller);
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
    await chain.write(chain.nft, "approve", [chain.raffle.address, 7001n], chain.seller);
    await chain.write(chain.raffle, "escrow", [id], chain.seller);
    await chain.admit(id);
    const policy = await service.openingPolicy();
    await chain.write(chain.raffle, "openWithPolicy", [id, policy.hash], chain.seller);
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 100_000_000n], chain.buyer);
    const data = encodeFunctionData({ abi: raffleAbi, functionName: "buyPack", args: [id, 0, 1, PUBLISHED_TERMS_HASH] });
    const transactionHash = hash(await chain.rpc("eth_sendTransaction", [{
      from: chain.buyer,
      to: chain.raffle.address,
      data,
      value: "0x0",
      gas: "0x989680"
    }]));
    await chain.mine();
    await chain.mine();
    const owner = createTransactionOutcomes(service, () => storage);
    const receipt = await owner.confirm(submitted(transactionHash, chain.buyer, chain.raffle.address, data));
    expect(receipt).toMatchObject({ kind: "terminal", submitted: { hash: transactionHash } });
    expect(transactionMeaning(service, receipt.kind === "terminal" ? receipt.submitted : submitted(transactionHash, chain.buyer, chain.raffle.address, data))?.purchase).toBe(true);
    return { data, id, journal, service, transactionHash, wallet };
  }

  function delayedService(journal: ReturnType<typeof memoryPendingJournal>, delayMs: number, failFirstReceipt = false) {
    let fail = failFirstReceipt;
    const client = createPublicClient({
      cacheTime: 0,
      pollingInterval: 20,
      transport: custom({
        async request({ method, params }) {
          if (method === "eth_getTransactionReceipt") {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            if (fail) {
              fail = false;
              throw new Error("Independent transient receipt RPC failure.");
            }
          }
          return chain.rpc(method, Array.isArray(params) ? params : []);
        }
      })
    });
    return createRaffleService(client, chain.manifest, journal);
  }

  it("automatically restores a confirmed historical purchase when receipt RPC takes longer than one second", async () => {
    const { storage } = memoryStorage();
    const purchase = await confirmedPurchaseCheckpoint(storage);
    const service = delayedService(purchase.journal, 1200);
    const owner = createTransactionOutcomes(service, () => storage);

    await owner.recover(chain.buyer);

    expect(owner.getSnapshot(chain.buyer).filter(blocking)).toEqual([]);
    const terminal = owner.getSnapshot(chain.buyer)[0];
    expect(terminal).toMatchObject({ kind: "terminal", submitted: { hash: purchase.transactionHash } });
    expect(terminal.kind === "terminal" && transactionMeaning(service, terminal.submitted)?.purchase).toBe(true);
  }, 15_000);

  it("retains the purchase barrier after a transient RPC failure and a manual slow recheck recovers it", async () => {
    const { map, storage } = memoryStorage();
    const purchase = await confirmedPurchaseCheckpoint(storage);
    const service = delayedService(purchase.journal, 1200, true);
    const owner = createTransactionOutcomes(service, () => storage);

    await owner.recover(chain.buyer);
    expect(owner.getSnapshot(chain.buyer).some(blocking)).toBe(true);
    expect([...map.values()].some(value => includesHash(value, purchase.transactionHash))).toBe(true);
    expect(purchase.journal.read(chain.buyer)).toBeNull();

    const recovered = await owner.resume(purchase.transactionHash, purchase.wallet);
    expect(recovered).toMatchObject({ kind: "terminal", submitted: { hash: purchase.transactionHash } });
    expect(recovered.kind === "terminal" && transactionMeaning(service, recovered.submitted)?.purchase).toBe(true);
    expect(owner.getSnapshot(chain.buyer).filter(blocking)).toEqual([]);
  }, 20_000);
});
