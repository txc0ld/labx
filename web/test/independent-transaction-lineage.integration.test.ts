import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublicClient, custom, keccak256, toBytes, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { memoryPendingJournal, transactionIntent } from "../lib/chain/pending-journal";
import { createRaffleService } from "../lib/chain/service";
import { createTransactionOutcomes, transactionMeaning, type OutcomeStorage, type TransactionOutcome } from "../lib/chain/transaction-outcomes";
import { hash } from "../lib/chain/validation";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
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

function outcomeHashForTest(outcome: TransactionOutcome) {
  return "submitted" in outcome ? outcome.submitted?.hash ?? null : "hash" in outcome ? outcome.hash : null;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
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

  async function replacementFixture(storage: OutcomeStorage, hydrateReplacementTab = false) {
    const journal = memoryPendingJournal();
    const service = createRaffleService(chain.client, chain.manifest, journal);
    const wallet = chain.wallet(chain.buyer).session;
    await wallet.connect();
    const tabA = createTransactionOutcomes({ ...service, confirm: input => service.confirm({ ...input, timeoutMs: 1000 }) }, () => storage);
    const tabB = createTransactionOutcomes({ ...service, confirm: input => service.confirm({ ...input, timeoutMs: 1000 }) }, () => storage);
    if (hydrateReplacementTab) tabB.hydrate(chain.buyer);

    await chain.write(chain.nft, "mint", [chain.buyer, 8101n]);
    const block = await chain.client.getBlock();
    const digest = keccak256(toBytes("independent-lineage-draft"));
    const prepared = await service.prepare({
      action: {
        kind: "createDraft",
        draft: {
          nft: chain.nft.address,
          tokenId: 8101n,
          salesEnd: block.timestamp + 3600n,
          reserveNonce: digest,
          reserveCommit: digest,
          title: "Independent lineage draft",
          packs: [{ name: "Entry", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 }]
        }
      },
      wallet
    });

    await chain.rpc("evm_setAutomine", [false]);
    const pending = await tabA.submit(prepared, wallet);
    expect(pending).toMatchObject({ kind: "pending" });
    if (pending.kind !== "pending") throw new Error("Expected the draft watcher to time out with H1 pending.");
    const h1 = pending.submitted.hash;
    const nonce = journal.read(chain.buyer)?.nonce;
    if (nonce === undefined) throw new Error("The draft submission did not create its pending journal.");
    expect(journal.read(chain.buyer)).toMatchObject({ hash: h1, nonce });

    const h1Transaction = await chain.client.getTransaction({ hash: h1 });
    const h2 = await send(chain.buyer, chain.buyer, "0x", nonce, "0xb2d05e00");
    await chain.mine();
    await chain.mine();
    return { journal, service, wallet, tabA, tabB, h1, h1Transaction, h2 };
  }

  it("does not recreate stale H1 after its same-nonce H2 was reconciled in the persistent flow", async () => {
    const { map, storage } = memoryStorage();
    const fixture = await replacementFixture(storage);
    const canonical = await fixture.tabA.resume(fixture.h2, fixture.wallet);
    expect(canonical).toMatchObject({ kind: "terminal", id: fixture.h1, submitted: { hash: fixture.h2 } });
    expect(fixture.journal.read(chain.buyer)).toBeNull();

    const staleCheck = await fixture.tabA.resume(fixture.h1, fixture.wallet);
    expect(staleCheck).toMatchObject({ kind: "terminal", submitted: { hash: fixture.h2 } });

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

  it("does not let a late guarded H1 resume recreate state after H2 was reconciled and acknowledged", async () => {
    const { map, storage } = memoryStorage();
    const fixture = await replacementFixture(storage);
    const entered = deferred();
    const release = deferred();
    let firstH1Read = true;
    const delayedClient = {
      ...chain.client,
      async getTransaction(input: Parameters<typeof chain.client.getTransaction>[0]) {
        if (firstH1Read && input.hash?.toLowerCase() === fixture.h1.toLowerCase()) {
          firstH1Read = false;
          entered.resolve();
          await release.promise;
          return fixture.h1Transaction;
        }
        return chain.client.getTransaction(input);
      }
    } as typeof chain.client;
    const delayedService = createRaffleService(delayedClient, chain.manifest, fixture.journal);
    const delayed = createTransactionOutcomes({
      ...delayedService,
      confirm: input => delayedService.confirm({ ...input, timeoutMs: 1_000 })
    }, () => storage);

    const stale = delayed.resume(fixture.h1, fixture.wallet);
    try {
      await Promise.race([
        entered.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("The stale H1 transaction read was not reached.")), 5_000))
      ]);
      const canonical = await fixture.tabB.resume(fixture.h2, fixture.wallet);
      expect(canonical).toMatchObject({ kind: "terminal", submitted: { hash: fixture.h2 } });
      await fixture.tabB.acknowledge(canonical, fixture.wallet);
      expect(map.size).toBe(0);
      expect(fixture.journal.read(chain.buyer)).toBeNull();
    } finally {
      release.resolve();
      await stale.catch(() => undefined);
    }

    expect({ checkpoints: map.size, journal: fixture.journal.read(chain.buyer) }).toEqual({ checkpoints: 0, journal: null });
    expect(delayed.getSnapshot(chain.buyer)).toEqual([]);
    expect(fixture.tabB.getSnapshot(chain.buyer)).toEqual([]);
  }, 15_000);

  it("keeps an observed H2 candidate when a late cold H1 inspection finishes after its checkpoint was deleted", async () => {
    const { map, storage } = memoryStorage();
    const fixture = await replacementFixture(storage);
    const entered = deferred();
    const release = deferred();
    let h1Inspections = 0;
    const cold = createTransactionOutcomes({
      ...fixture.service,
      async inspectOutcome(input: Parameters<RaffleService["inspectOutcome"]>[0]) {
        if (input.hash.toLowerCase() === fixture.h1.toLowerCase()) {
          h1Inspections += 1;
          if (h1Inspections === 1) return {
            kind: "pending" as const,
            hash: fixture.h1,
            reason: "unmined" as const,
            transaction: {
              hash: fixture.h1,
              account: fixture.h1Transaction.from,
              chainId: chain.manifest.chainId,
              to: fixture.h1Transaction.to,
              data: fixture.h1Transaction.input,
              value: fixture.h1Transaction.value,
              nonce: fixture.h1Transaction.nonce
            }
          };
          if (h1Inspections === 2) {
            entered.resolve();
            await release.promise;
          }
        }
        return fixture.service.inspectOutcome(input);
      }
    }, () => storage);
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const listeners = new Map<string, Set<(event: { key?: string | null; newValue?: string | null; storageArea?: OutcomeStorage }) => void>>();
    const fakeWindow = {
      localStorage: storage,
      addEventListener(type: string, listener: (event: { key?: string | null; newValue?: string | null; storageArea?: OutcomeStorage }) => void) {
        const current = listeners.get(type) ?? new Set();
        current.add(listener); listeners.set(type, current);
      },
      removeEventListener(type: string, listener: (event: { key?: string | null; newValue?: string | null; storageArea?: OutcomeStorage }) => void) {
        listeners.get(type)?.delete(listener);
      }
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    const stop = cold.observe(chain.buyer);
    try {
      await expect.poll(() => cold.getSnapshot(chain.buyer), { timeout: 5_000 }).toMatchObject([
        { kind: "unverified", hash: fixture.h1 }
      ]);
      const h1Entry = [...map.entries()].find(([, value]) => includesHash(value, fixture.h1));
      if (!h1Entry) throw new Error("H1 was not available for the second cold inspection.");
      for (const listener of listeners.get("storage") ?? []) listener({ key: h1Entry[0], newValue: h1Entry[1], storageArea: storage });
      await entered.promise;
      const canonical = await fixture.tabB.resume(fixture.h2, fixture.wallet);
      expect(canonical).toMatchObject({ kind: "terminal", submitted: { hash: fixture.h2 } });
      const entry = [...map.entries()].find(([, value]) => includesHash(value, fixture.h2));
      if (!entry) throw new Error("H2 was not saved before the simulated storage event.");
      for (const listener of listeners.get("storage") ?? []) listener({ key: entry[0], newValue: entry[1], storageArea: storage });
      await fixture.tabB.acknowledge(canonical, fixture.wallet);
      expect(map.size).toBe(0);
      for (const listener of listeners.get("storage") ?? []) listener({ key: entry[0], newValue: null, storageArea: storage });

      release.resolve();
      await expect.poll(() => cold.getSnapshot(chain.buyer), { timeout: 10_000 }).toMatchObject([
        { kind: "terminal", submitted: { hash: fixture.h2 } }
      ]);
      await cold.synchronize(chain.buyer);
      expect(cold.getSnapshot(chain.buyer).some(item => outcomeHashForTest(item)?.toLowerCase() === fixture.h1.toLowerCase())).toBe(false);
      expect(cold.getSnapshot(chain.buyer).filter(blocking)).toEqual([]);
      expect(map.size).toBe(0);
      expect(fixture.journal.read(chain.buyer)).toBeNull();
    } finally {
      stop();
      release.resolve();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  }, 15_000);

  it("does not retain an unverified cold H1 after observed H2 was verified and acknowledged", async () => {
    const { map, storage } = memoryStorage();
    const fixture = await replacementFixture(storage);
    const entered = deferred();
    const release = deferred();
    let delayedH1 = true;
    const cold = createTransactionOutcomes({
      ...fixture.service,
      async inspectOutcome(input: Parameters<RaffleService["inspectOutcome"]>[0]) {
        if (delayedH1 && input.hash.toLowerCase() === fixture.h1.toLowerCase()) {
          delayedH1 = false;
          entered.resolve();
          await release.promise;
        }
        return fixture.service.inspectOutcome(input);
      }
    }, () => storage);
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const listeners = new Map<string, Set<(event: { key?: string | null; newValue?: string | null; storageArea?: OutcomeStorage }) => void>>();
    const fakeWindow = {
      localStorage: storage,
      addEventListener(type: string, listener: (event: { key?: string | null; newValue?: string | null; storageArea?: OutcomeStorage }) => void) {
        const current = listeners.get(type) ?? new Set();
        current.add(listener); listeners.set(type, current);
      },
      removeEventListener(type: string, listener: (event: { key?: string | null; newValue?: string | null; storageArea?: OutcomeStorage }) => void) {
        listeners.get(type)?.delete(listener);
      }
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    const stop = cold.observe(chain.buyer);
    try {
      await entered.promise;
      const canonical = await fixture.tabB.resume(fixture.h2, fixture.wallet);
      expect(canonical).toMatchObject({ kind: "terminal", submitted: { hash: fixture.h2 } });
      const entry = [...map.entries()].find(([, value]) => includesHash(value, fixture.h2));
      if (!entry) throw new Error("H2 was not saved before the simulated storage event.");
      for (const listener of listeners.get("storage") ?? []) listener({ key: entry[0], newValue: entry[1], storageArea: storage });
      await fixture.tabB.acknowledge(canonical, fixture.wallet);
      expect(map.size).toBe(0);
      for (const listener of listeners.get("storage") ?? []) listener({ key: entry[0], newValue: null, storageArea: storage });

      release.resolve();
      await cold.synchronize(chain.buyer);
      await expect.poll(() => cold.getSnapshot(chain.buyer).find(item => outcomeHashForTest(item)?.toLowerCase() === fixture.h2.toLowerCase()), { timeout: 10_000 })
        .toMatchObject({ kind: "terminal", submitted: { hash: fixture.h2 } });
      expect(cold.getSnapshot(chain.buyer).some(item => outcomeHashForTest(item)?.toLowerCase() === fixture.h1.toLowerCase())).toBe(false);
      expect(cold.getSnapshot(chain.buyer).filter(blocking)).toEqual([]);
      expect(map.size).toBe(0);
      expect(fixture.journal.read(chain.buyer)).toBeNull();
    } finally {
      stop();
      release.resolve();
      await cold.synchronize(chain.buyer).catch(() => undefined);
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  }, 15_000);

  it("does not apply a captured buyer lineage token to another account's canonical same-nonce receipt", async () => {
    const journal = memoryPendingJournal();
    const service = createRaffleService(chain.client, chain.manifest, journal);
    const buyerNonce = await chain.client.getTransactionCount({ address: chain.buyer });
    const otherNonce = await chain.client.getTransactionCount({ address: chain.treasury });
    expect(otherNonce).toBe(buyerNonce);
    const buyerHash = await send(chain.buyer, chain.buyer, "0x", buyerNonce, "0x77359400");
    const otherHash = await send(chain.treasury, chain.treasury, "0x", otherNonce, "0x77359400");
    await chain.mine();
    await chain.mine();
    const buyerTransaction = await chain.client.getTransaction({ hash: buyerHash });
    const syntheticPrior = keccak256(toBytes("independent-other-account-lineage"));
    journal.write(chain.buyer, {
      id: "independent-buyer-lineage",
      intentHash: transactionIntent({ to: chain.buyer, data: "0x", value: 0n }),
      nonce: buyerTransaction.nonce,
      startedBlock: "1",
      hash: syntheticPrior
    });
    const lineage = service.captureOutcomeLineage({ account: chain.buyer, hash: syntheticPrior });
    if (!lineage) throw new Error("The buyer lineage token was not captured.");
    journal.remove(chain.buyer);
    const other = await service.inspectOutcome({ hash: otherHash, account: chain.treasury });
    if (other.kind !== "confirmed") throw new Error("The other account's canonical receipt was not confirmed.");
    expect(other.receipt.nonce).toBe(buyerTransaction.nonce);
    const retained: Array<Hex | null> = [];
    await service.retainOutcome({ receipt: other.receipt, lineage, retain: ({ priorHash }) => retained.push(priorHash) });
    expect(retained).toEqual([null]);
    expect(journal.read(chain.buyer)).toBeNull();
    expect(journal.read(chain.treasury)).toBeNull();
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
    const owner = createTransactionOutcomes(service, () => storage);
    const prepared = await service.prepare({
      action: {
        kind: "buyMembership",
        id,
        packId: 0,
        quantity: 1,
        acceptedTerms: PUBLISHED_TERMS_HASH,
        agreements: { terms: true, rules: true, age: true },
        payment: { kind: "usdc" }
      },
      wallet
    });
    const confirming = owner.submit(prepared, wallet);
    await expect.poll(() => journal.read(chain.buyer)?.hash ?? null, { timeout: 5_000 }).toMatch(/^0x[0-9a-f]{64}$/);
    await chain.mine();
    await chain.mine();
    const receipt = await confirming;
    expect(receipt).toMatchObject({ kind: "terminal" });
    if (receipt.kind !== "terminal") throw new Error("Expected a canonical purchase receipt.");
    const transactionHash = receipt.submitted.hash;
    expect(transactionMeaning(service, receipt.submitted)?.purchase).toBe(true);
    return { id, journal, service, transactionHash, wallet };
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
      }, { retryCount: 0 })
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
