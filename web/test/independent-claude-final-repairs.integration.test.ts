import { fixtureTrust } from "./fixtures/deployment";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TransactionNotFoundError, encodeFunctionData, keccak256, toBytes, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { memoryPendingJournal } from "../lib/chain/pending-journal";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import { createRaffleService } from "../lib/chain/service";
import { createTransactionOutcomes, type OutcomeStorage } from "../lib/chain/transaction-outcomes";
import type { CanonicalReceipt, OutcomeInspection, OutcomeLineage, PreparedAction, SubmittedAction, WalletSnapshot, WorkflowAction } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_INDEPENDENT_TRANSACTION_LINEAGE === "1" ? describe : describe.skip;

function deferred() {
  let resolve: () => void = () => { throw new Error("Deferred promise was not initialized."); };
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

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

run("independent final transaction outcome repairs", () => {
  let chain: LocalChain;
  let seller: WalletSessionPort;
  let token = 1200n;

  beforeAll(async () => {
    chain = await localChain();
    seller = chain.wallet(chain.seller).session;
    await seller.connect();
  }, 60_000);

  afterAll(() => chain?.close());

  async function draftAction(label: string): Promise<WorkflowAction> {
    token += 1n;
    await chain.write(chain.nft, "mint", [chain.seller, token]);
    const block = await chain.client.getBlock();
    const commitment = keccak256(toBytes(`independent-final-${label}-${token.toString()}`));
    return {
      kind: "createDraft",
      draft: {
        nft: chain.nft.address,
        tokenId: token,
        salesEnd: block.timestamp + 7_200n,
        reserveNonce: commitment,
        reserveCommit: commitment,
        title: label,
        packs: [{ name: "Membership", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 4 }]
      }
    };
  }

  it("keeps its own broadcast volatile through transaction-visibility lag and eventually confirms it", async () => {
    const journal = memoryPendingJournal();
    const service = createRaffleService(chain.client, chain.manifest, journal);
    const { storage, map } = memoryStorage();
    const owner = createTransactionOutcomes(service, () => storage);
    const prepared = await service.prepare({ action: await draftAction("Visibility lag"), wallet: seller });
    const lookup = deferred();
    const getTransaction = vi.spyOn(chain.client, "getTransaction");
    getTransaction.mockImplementationOnce(async ({ hash }) => {
      await lookup.promise;
      throw new TransactionNotFoundError({ hash });
    });
    try {
      const checking = owner.submit(prepared, seller);
      await vi.waitFor(() => expect(getTransaction).toHaveBeenCalledTimes(1));
      const duringLag = owner.getSnapshot(chain.seller);
      const pendingDuringLag = journal.read(chain.seller);
      const persistedDuringLag = map.size;
      await chain.mine();
      await chain.mine();
      lookup.resolve();
      const result = await checking;

      expect(duringLag).toHaveLength(1);
      const volatile = duringLag[0];
      if (!volatile) throw new Error("The freshly submitted transaction was dropped during the RPC visibility lag.");
      expect(["checking", "pending"]).toContain(volatile.kind);
      expect("submitted" in volatile ? volatile.submitted?.hash ?? null : null).toBe(pendingDuringLag?.hash);
      expect(persistedDuringLag).toBe(0);
      expect(pendingDuringLag?.hash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(result).toMatchObject({ kind: "terminal", confirmation: { kind: "confirmed" } });
      expect(map.size).toBe(1);
      expect(journal.read(chain.seller)).toBeNull();
    } finally {
      lookup.resolve();
      getTransaction.mockRestore();
    }
  }, 30_000);

  it("does not retry or persist a transaction lookup whose sender is wrong", async () => {
    const journal = memoryPendingJournal();
    const service = createRaffleService(chain.client, chain.manifest, journal);
    const prepared = await service.prepare({ action: await draftAction("Wrong sender"), wallet: seller });
    const submitted = await service.submit({ prepared, wallet: seller });
    const actual = await chain.client.getTransaction({ hash: submitted.hash });
    const beforeJournalWatch = vi.fn();
    const getTransaction = vi.spyOn(chain.client, "getTransaction").mockResolvedValue({ ...actual, from: chain.buyer });
    try {
      await expect(service.confirm({ transaction: submitted, timeoutMs: 1_000, beforeJournalWatch })).rejects.toThrow(/sender|wallet request/i);
      expect(getTransaction).toHaveBeenCalledTimes(1);
      expect(beforeJournalWatch).not.toHaveBeenCalled();
      expect(journal.read(chain.seller)?.hash).toBe(submitted.hash);
    } finally {
      getTransaction.mockRestore();
    }
  }, 20_000);

  it("bounds a changed H1 pointer and carries its private lineage to canonical H2", async () => {
    const account = "0x1111111111111111111111111111111111111111" as Address;
    const contract = "0x3333333333333333333333333333333333333333" as Address;
    const h1 = `0x${"11".repeat(32)}` as Hex;
    const h2 = `0x${"22".repeat(32)}` as Hex;
    const runtime = `0x${"33".repeat(32)}` as Hex;
    const id = h1;
    const { storage, map } = memoryStorage();
    const checkpoint = `labx:outcome:v1:31337:${contract}:${runtime}:${account}:${id}`;
    const lineage = Object.freeze({ hash: h1 }) as OutcomeLineage;
    let journalHash: Hex | null = h1;
    let h1Inspections = 0;
    const h2Receipt: CanonicalReceipt = {
      hash: h2,
      account,
      chainId: 31337,
      to: account,
      data: "0x",
      value: 0n,
      nonce: 7,
      blockNumber: 30n,
      status: "success"
    };
    const service = {
      manifest: { ...fixtureTrust, chainId: 31337 as const, address: contract, usdc: account, runtimeCodeHash: runtime, deploymentBlock: 1n, version: 3 as const },
      submit: vi.fn<(_: { prepared: PreparedAction; wallet: WalletSessionPort }) => Promise<SubmittedAction>>(),
      resume: vi.fn<(_: Parameters<RaffleService["resume"]>[0]) => Promise<SubmittedAction | null>>(),
      confirm: vi.fn<(_: Parameters<RaffleService["confirm"]>[0]) => ReturnType<RaffleService["confirm"]>>(),
      pending: vi.fn<(_: { wallet: WalletSessionPort }) => ReturnType<RaffleService["pending"]>>(),
      acknowledgeOutcome: vi.fn(async (input: Parameters<RaffleService["acknowledgeOutcome"]>[0]) => input.acknowledge()),
      captureOutcomeLineage: vi.fn(({ hash }: { account: Address; hash: Hex }) => journalHash?.toLowerCase() === hash.toLowerCase() ? lineage : null),
      inspectOutcome: vi.fn(async ({ hash }: { hash: Hex; account: Address; timeoutMs?: number }): Promise<OutcomeInspection> => {
        if (hash.toLowerCase() === h2.toLowerCase()) return { kind: "confirmed", hash: h2, blockNumber: h2Receipt.blockNumber, replacedHash: null, receipt: h2Receipt };
        h1Inspections += 1;
        if (h1Inspections === 3) {
          map.set(checkpoint, h1);
          journalHash = h1;
        }
        return { kind: "unknown", hash: h1, reason: "The original hash is not visible from this RPC." };
      }),
      retainOutcome: vi.fn(async ({ receipt, lineage: supplied, retain }: Parameters<RaffleService["retainOutcome"]>[0]) => {
        expect(receipt.hash).toBe(h2);
        retain({ priorHash: supplied === lineage ? h1 : null });
      })
    } satisfies Pick<RaffleService, "manifest" | "submit" | "resume" | "confirm" | "pending" | "acknowledgeOutcome" | "captureOutcomeLineage" | "inspectOutcome" | "retainOutcome">;

    map.set(checkpoint, h1);
    const owner = createTransactionOutcomes(service, () => storage);
    owner.hydrate(account);
    const capturesBeforePointerChange = service.captureOutcomeLineage.mock.calls.length;
    journalHash = h2;
    map.set(checkpoint, h2);
    await owner.recover(account);

    const snapshot = owner.getSnapshot(account);
    expect({
      capturesBeforePointerChange,
      h1Inspections,
      inspectedH2: service.inspectOutcome.mock.calls.some(([input]) => input.hash.toLowerCase() === h2.toLowerCase()),
      snapshot: snapshot.map(item => ({ kind: item.kind, id: item.id, hash: "submitted" in item ? item.submitted?.hash ?? null : "hash" in item ? item.hash : null })),
      stored: [...map.values()]
    }).toEqual({
      capturesBeforePointerChange: 1,
      h1Inspections: 1,
      inspectedH2: true,
      snapshot: [{ kind: "terminal", id, hash: h2 }],
      stored: [h2]
    });
  });

  it("does not let an injected H2 pointer release unknown H1 without private lineage", async () => {
    const account = "0x1111111111111111111111111111111111111111" as Address;
    const contract = "0x3333333333333333333333333333333333333333" as Address;
    const h1 = `0x${"44".repeat(32)}` as Hex;
    const h2 = `0x${"55".repeat(32)}` as Hex;
    const runtime = `0x${"66".repeat(32)}` as Hex;
    const { storage, map } = memoryStorage();
    const checkpoint = `labx:outcome:v1:31337:${contract}:${runtime}:${account}:${h1}`;
    let h1Inspections = 0;
    const h2Receipt: CanonicalReceipt = {
      hash: h2,
      account,
      chainId: 31337,
      to: account,
      data: "0x",
      value: 0n,
      nonce: 12,
      blockNumber: 40n,
      status: "success"
    };
    const service = {
      manifest: { ...fixtureTrust, chainId: 31337 as const, address: contract, usdc: account, runtimeCodeHash: runtime, deploymentBlock: 1n, version: 3 as const },
      submit: vi.fn<(_: { prepared: PreparedAction; wallet: WalletSessionPort }) => Promise<SubmittedAction>>(),
      resume: vi.fn<(_: Parameters<RaffleService["resume"]>[0]) => Promise<SubmittedAction | null>>(),
      confirm: vi.fn<(_: Parameters<RaffleService["confirm"]>[0]) => ReturnType<RaffleService["confirm"]>>(),
      pending: vi.fn<(_: { wallet: WalletSessionPort }) => ReturnType<RaffleService["pending"]>>(),
      captureOutcomeLineage: vi.fn(() => null),
      inspectOutcome: vi.fn(async ({ hash }: { hash: Hex; account: Address; timeoutMs?: number }): Promise<OutcomeInspection> => {
        if (hash.toLowerCase() === h2.toLowerCase()) return { kind: "confirmed", hash: h2, blockNumber: h2Receipt.blockNumber, replacedHash: null, receipt: h2Receipt };
        h1Inspections += 1;
        if (h1Inspections === 3) map.set(checkpoint, h1);
        return { kind: "unknown", hash: h1, reason: "No private journal lineage exists for this historical hash." };
      }),
      retainOutcome: vi.fn(async ({ retain }: Parameters<RaffleService["retainOutcome"]>[0]) => retain({ priorHash: null })),
      acknowledgeOutcome: vi.fn(async ({ acknowledge }: Parameters<RaffleService["acknowledgeOutcome"]>[0]) => acknowledge())
    } satisfies Pick<RaffleService, "manifest" | "submit" | "resume" | "confirm" | "pending" | "captureOutcomeLineage" | "inspectOutcome" | "retainOutcome" | "acknowledgeOutcome">;

    map.set(checkpoint, h1);
    const owner = createTransactionOutcomes(service, () => storage);
    owner.hydrate(account);
    map.set(checkpoint, h2);
    await owner.recover(account);
    const before = owner.getSnapshot(account);
    const terminal = before.find(item => item.kind === "terminal" && item.submitted.hash.toLowerCase() === h2.toLowerCase());
    if (!terminal) throw new Error("The canonical H2 receipt was not available for acknowledgment.");
    expect({
      h1Inspections,
      outcomes: before.map(item => ({ kind: item.kind, hash: "submitted" in item ? item.submitted?.hash ?? null : "hash" in item ? item.hash : null })),
      stored: [...map.values()]
    }).toEqual({
      h1Inspections: 1,
      outcomes: [{ kind: "unverified", hash: h1 }, { kind: "terminal", hash: h2 }],
      stored: [h2]
    });
    await owner.acknowledge(terminal);
    expect(owner.getSnapshot(account)).toMatchObject([{ kind: "unverified", hash: h1 }, { kind: "terminal", submitted: { hash: h2 } }]);
    expect(owner.getSnapshot(account)).toHaveLength(2);
    expect([...map.values()]).toEqual([h2]);
  });
});
