import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes, type Hex } from "viem";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { createRaffleService } from "../lib/chain/service";
import { memoryPendingJournal } from "../lib/chain/pending-journal";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { WorkflowAction } from "../lib/chain/types";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
run("pending purchase repair on isolated Anvil", () => {
  let c: LocalChain, service: RaffleService, seller: WalletSessionPort, buyer: WalletSessionPort;
  const journal = memoryPendingJournal();
  beforeAll(async () => {
    c = await localChain(); service = createRaffleService(c.client, c.manifest, journal);
    seller = c.wallet(c.seller).session; buyer = c.wallet(c.buyer).session; await seller.connect(); await buyer.connect();
    await c.write(c.usdc, "mint", [c.buyer, 10000000000n]); await c.write(c.nft, "mint", [c.seller, 1n]);
    const h = keccak256(toBytes("fixture"));
    await execute({ kind: "createDraft", draft: { nft: c.nft.address, tokenId: 1n, title: "Pending protections", salesEnd: (await c.client.getBlock()).timestamp + 86400n, reserveCommit: h, reserveNonce: h, packs: [{ name: "Entry", priceUsdc: 25000000n, bonusEntries: 1, maxSupply: 100 }] } }, seller);
    await execute({ kind: "approvePrize", id: 1n }, seller); await execute({ kind: "escrow", id: 1n }, seller);
    await c.admit(1n);
    await execute({ kind: "open", id: 1n, expectedPolicyHash: (await service.openingPolicy()).hash }, seller);
  }, 30000);
  afterAll(() => c?.close());
  async function execute(action: WorkflowAction, wallet = buyer) {
    const prepared = await service.prepare({ action, wallet }); const transaction = await service.submit({ prepared, wallet }); await c.client.waitForTransactionReceipt({ hash: transaction.hash }); await c.mine();
    expect((await service.confirm({ transaction, timeoutMs: 3000 })).kind).toBe("confirmed"); return transaction;
  }
  const purchase: WorkflowAction = { kind: "buyMembership", id: 1n, packId: 0, quantity: 1, acceptedTerms: PUBLISHED_TERMS_HASH, agreements: { terms: true, rules: true, age: true }, payment: { kind: "usdc" } };
  it("protects an excess-allowance purchase across recreation and refuses old confirmed recovery", async () => {
    const old = await execute({ kind: "approveUsdc", id: 1n, packId: 0, quantity: 10 });
    await c.rpc("evm_setAutomine", [false]);
    try {
      const prepared = await service.prepare({ action: purchase, wallet: buyer }); const transaction = await service.submit({ prepared, wallet: buyer });
      const before = journal.read(c.buyer), reloaded = createRaffleService(c.client, c.manifest, journal);
      expect((await reloaded.pending({ wallet: buyer }))?.hash).toBe(transaction.hash);
      const duplicate = await reloaded.prepare({ action: purchase, wallet: buyer });
      await expect(reloaded.submit({ prepared: duplicate, wallet: buyer })).rejects.toThrow(/unresolved/);
      await expect(reloaded.resume({ hash: old.hash, wallet: buyer })).rejects.toThrow(/unrelated/);
      await expect(reloaded.confirm({ transaction: old, timeoutMs: 1000 })).rejects.toThrow(/does not reconcile/);
      expect(journal.read(c.buyer)).toEqual(before);
      const resumed = await reloaded.resume({ hash: transaction.hash, wallet: buyer }); await c.mine(); await c.mine();
      expect((await reloaded.confirm({ transaction: resumed, timeoutMs: 3000 })).kind).toBe("confirmed");
      expect(await service.pending({ wallet: buyer })).toBeNull();
      expect((await service.readAccount({ id: 1n, account: c.buyer })).principal).toBe(25000000n);
    } finally { await c.rpc("evm_setAutomine", [true]); }
  }, 15000);
  it("retains ambiguous accepted sends through recreation until the exact nonce is reconciled", async () => {
    const control = c.wallet(c.buyer); await control.session.connect();
    const send = control.session.requestTransaction.bind(control.session); let accepted: Hex | null = null;
    control.session.requestTransaction = async (...args) => { accepted = await send(...args); throw new Error("Wallet connection dropped after broadcast"); };
    const prepared = await service.prepare({ action: purchase, wallet: control.session });
    await expect(service.submit({ prepared, wallet: control.session })).rejects.toThrow(/uncertain/);
    expect(journal.read(c.buyer)?.hash).toBeNull();
    const reloaded = createRaffleService(c.client, c.manifest, journal);
    const duplicate = await reloaded.prepare({ action: purchase, wallet: buyer });
    await expect(reloaded.submit({ prepared: duplicate, wallet: buyer })).rejects.toThrow(/unresolved/);
    if (!accepted) throw new Error("Fixture did not broadcast");
    const resumed = await reloaded.resume({ hash: accepted, wallet: buyer }); await c.mine();
    expect((await reloaded.confirm({ transaction: resumed, timeoutMs: 3000 })).kind).toBe("confirmed"); expect(journal.read(c.buyer)).toBeNull();
  });
  it("does not create a ghost journal when inner pre-send wallet revalidation fails", async () => {
    const control = c.wallet(c.buyer); await control.session.connect();
    const send = control.session.requestTransaction.bind(control.session);
    control.session.requestTransaction = async (...args) => { control.changeAccount(c.stranger); return send(...args); };
    const prepared = await service.prepare({ action: purchase, wallet: control.session });
    await expect(service.submit({ prepared, wallet: control.session })).rejects.toThrow(/changed/); expect(journal.read(c.buyer)).toBeNull();
    await execute(purchase); expect(journal.read(c.buyer)).toBeNull();
  });
  it("keeps an unresolved ETH purchase blocked despite surplus native funds", async () => {
    await c.write(c.feed, "setUpdatedAt", [(await c.client.getBlock()).timestamp]); await c.write(c.raffle, "setEthPathEnabled", [true]);
    const quote = await service.quoteMembership({ id: 1n, packId: 0, quantity: 1 }); if (quote.eth.kind !== "available") throw new Error(quote.eth.reason);
    const action: WorkflowAction = { ...purchase, payment: { kind: "eth", maxEth: quote.eth.maxEth, deadline: quote.eth.deadline, slippageBps: quote.eth.slippageBps } };
    await c.rpc("evm_setAutomine", [false]);
    try {
      const transaction = await service.submit({ prepared: await service.prepare({ action, wallet: buyer }), wallet: buyer });
      const reloaded = createRaffleService(c.client, c.manifest, journal);
      await expect(reloaded.submit({ prepared: await reloaded.prepare({ action, wallet: buyer }), wallet: buyer })).rejects.toThrow(/unresolved/);
      await c.mine(); await c.mine(); expect((await service.confirm({ transaction, timeoutMs: 3000 })).kind).toBe("confirmed");
    } finally { await c.rpc("evm_setAutomine", [true]); }
  });
  it.each(["account", "chain"])("clears only the prepared journal when %s changes while the callback waits", async kind => {
    const control = c.wallet(c.buyer); await control.session.connect();
    const send = control.session.requestTransaction.bind(control.session);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let providerInvocations = 0;
    control.session.requestTransaction = (expected, transaction, prepareJournal, providerStarted) => send(expected, transaction, async () => {
      await prepareJournal?.(); entered(); await gate;
    }, () => { providerInvocations += 1; providerStarted?.(); });
    const prepared = await service.prepare({ action: purchase, wallet: control.session });
    const rejected = expect(service.submit({ prepared, wallet: control.session })).rejects.toThrow(/changed/);
    await started; expect(journal.read(c.buyer)).not.toBeNull();
    if (kind === "account") control.changeAccount(c.stranger); else control.changeChain("0x1");
    release(); await rejected;
    expect(providerInvocations).toBe(0); expect(journal.read(c.buyer)).toBeNull();
    await execute(purchase); expect(journal.read(c.buyer)).toBeNull();
  });

});
