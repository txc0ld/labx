import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRaffleService } from "../lib/chain/service";
import { raffleAbi } from "../lib/chain/abi";
import { memoryPendingJournal, type PendingJournal } from "../lib/chain/pending-journal";
import { createReserve } from "../lib/reserve";
import { MemoryStore } from "../lib/store";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;

run("independent pending journal boundaries on isolated Anvil", () => {
  let chain: LocalChain;
  let seller: WalletSessionPort;
  let base: RaffleService;

  beforeAll(async () => {
    chain = await localChain();
    seller = chain.wallet(chain.seller).session;
    await seller.connect();
    base = chain.service;
  }, 30_000);

  afterAll(() => chain?.close());

  async function confirmed(service: RaffleService, action: WorkflowAction, wallet = seller) {
    const prepared = await service.prepare({ action, wallet });
    const transaction = await service.submit({ prepared, wallet });
    await chain.mine();
    expect(await service.confirm({ transaction, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
    return transaction;
  }

  async function draft(tokenId: bigint) {
    await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    const commitment = await createReserve(new MemoryStore(), {
      seller: chain.seller,
      nft: chain.nft.address,
      tokenId: tokenId.toString(),
      publicSummary: `Journal boundary ${tokenId}`,
      privateCommitment: `Independent journal record ${tokenId}`,
      chainId: 31337n,
      labx: chain.raffle.address
    });
    const latest = await chain.client.getBlock();
    const input: DraftInput = {
      nft: chain.nft.address,
      tokenId,
      salesEnd: latest.timestamp + 900n,
      reserveNonce: commitment.nonce,
      reserveCommit: commitment.commit,
      title: `Journal ${tokenId}`,
      packs: [{ name: "Membership", priceUsdc: 10_000_000n, bonusEntries: 1, maxSupply: 2 }]
    };
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await confirmed(base, { kind: "createDraft", draft: input });
    return id;
  }

  it("allows only one provider request across two service instances sharing one journal", async () => {
    const id = await draft(501n);
    const journal = memoryPendingJournal();
    const first = createRaffleService(chain.client, chain.manifest, journal);
    const second = createRaffleService(chain.client, chain.manifest, journal);
    const [one, two] = await Promise.all([
      first.prepare({ action: { kind: "approvePrize", id }, wallet: seller }),
      second.prepare({ action: { kind: "approvePrize", id }, wallet: seller })
    ]);

    const attempts = await Promise.allSettled([
      first.submit({ prepared: one, wallet: seller }),
      second.submit({ prepared: two, wallet: seller })
    ]);
    const fulfilled = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<RaffleService["submit"]>>> => result.status === "fulfilled");
    const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toMatch(/unresolved transaction/);
    await chain.mine();
    expect(await first.confirm({ transaction: fulfilled[0]!.value, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
    expect(journal.read(chain.seller)).toBeNull();
  });

  it("fails closed on storage failure before the provider request and permits a fresh reviewed retry", async () => {
    const id = await draft(502n);
    let providerRequests = 0;
    const counted: WalletSessionPort = {
      getSnapshot: () => seller.getSnapshot(),
      subscribe: listener => seller.subscribe(listener),
      connect: () => seller.connect(),
      refresh: () => seller.refresh(),
      disconnect: () => seller.disconnect(),
      assertCurrent: expected => seller.assertCurrent(expected),
      signMessage: input => seller.signMessage(input),
      requestTransaction: (expected, transaction, beforeRequest, onProviderRequest) => seller.requestTransaction(
        expected,
        transaction,
        beforeRequest,
        () => { providerRequests += 1; onProviderRequest?.(); }
      )
    };
    const unavailable: PendingJournal = {
      read: () => null,
      write: () => { throw new Error("storage full"); },
      remove: () => {},
      exclusive: (_account, run) => run()
    };
    const blocked = createRaffleService(chain.client, chain.manifest, unavailable);
    const prepared = await blocked.prepare({ action: { kind: "approvePrize", id }, wallet: counted });
    await expect(blocked.submit({ prepared, wallet: counted })).rejects.toThrow(/storage full/);
    expect(providerRequests).toBe(0);

    const retry = createRaffleService(chain.client, chain.manifest, memoryPendingJournal());
    await confirmed(retry, { kind: "approvePrize", id }, counted);
    expect(providerRequests).toBe(1);
  });

  it("reconciles an unknown-hash ambiguous send only with its same-nonce cancellation", async () => {
    const id = await draft(503n);
    const journal = memoryPendingJournal();
    const service = createRaffleService(chain.client, chain.manifest, journal);
    const controlled = chain.wallet(chain.seller).session;
    await controlled.connect();
    let originalHash: `0x${string}` | undefined;
    const uncertain: WalletSessionPort = {
      getSnapshot: () => controlled.getSnapshot(),
      subscribe: listener => controlled.subscribe(listener),
      connect: () => controlled.connect(),
      refresh: () => controlled.refresh(),
      disconnect: () => controlled.disconnect(),
      assertCurrent: expected => controlled.assertCurrent(expected),
      signMessage: input => controlled.signMessage(input),
      async requestTransaction(expected, transaction, beforeRequest, onProviderRequest) {
        originalHash = await controlled.requestTransaction(expected, transaction, beforeRequest, onProviderRequest);
        throw new Error("provider timed out after broadcast");
      }
    };

    await chain.rpc("evm_setAutomine", [false]);
    try {
      const prepared = await service.prepare({ action: { kind: "approvePrize", id }, wallet: uncertain });
      await expect(service.submit({ prepared, wallet: uncertain })).rejects.toThrow(/uncertain/);
      expect(await service.pending({ wallet: controlled })).toMatchObject({ hash: null });
      if (!originalHash) throw new Error("Fixture did not broadcast the ambiguous transaction.");
      const original = await chain.client.getTransaction({ hash: originalHash });
      const replacement = await chain.rpc("eth_sendTransaction", [{
        from: chain.seller,
        to: chain.seller,
        value: "0x0",
        nonce: `0x${original.nonce.toString(16)}`,
        gasPrice: "0x174876e800",
        gas: "0x5208"
      }]);
      if (typeof replacement !== "string" || !/^0x[0-9a-f]{64}$/i.test(replacement)) throw new Error("Fixture replacement was not submitted.");
      await chain.mine();
      await chain.mine();
      const resumed = await service.resume({ hash: replacement as `0x${string}`, wallet: controlled });
      expect(await service.confirm({ transaction: resumed, timeoutMs: 3_000 })).toMatchObject({ kind: "replaced" });
      expect(await service.pending({ wallet: controlled })).toBeNull();
    } finally {
      await chain.rpc("evm_setAutomine", [true]);
    }
  });
});
