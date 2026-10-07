import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, keccak256, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { createRaffleService } from "../lib/chain/service";
import { attestDeployment } from "../lib/chain/deployment";
import { MAX_MEMBERSHIP_TOTAL_USDC, sellerAccounting } from "../lib/chain/fees";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { PUBLISHED_TERMS_HASH as OLD_TERMS } from "../lib/published-terms-v2";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import type { WalletSessionPort } from "../lib/chain/ports";
import type { WorkflowAction } from "../lib/chain/types";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
run("v3 fee accounting and version binding on isolated Anvil", () => {
  let c: LocalChain, buyer: WalletSessionPort;
  beforeAll(async () => {
    c = await localChain(); buyer = c.wallet(c.buyer).session; await buyer.connect();
    await c.write(c.usdc, "mint", [c.buyer, 100_000_000_000_000n]);
  }, 30_000);
  afterAll(() => c?.close());
  async function opened(price: bigint, terms: Hex = PUBLISHED_TERMS_HASH) {
    const id = await c.client.readContract({ address: c.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await c.write(c.nft, "mint", [c.seller, id]);
    const now = (await c.client.getBlock()).timestamp;
    const hash = keccak256("0x1234");
    await c.write(c.raffle, "setTermsHash", [terms]);
    await c.write(c.raffle, "createRaffle", [c.nft.address, id, now + 1000n, hash, hash, "Fees",
      [{ name: "Pack", priceUsdc: price, bonusEntries: 1, maxSupply: 100 }]], c.seller);
    await expect(c.service.quoteMembership({ id, packId: 0, quantity: 1 })).rejects.toThrow(/not open/);
    await c.write(c.nft, "approve", [c.raffle.address, id], c.seller);
    await c.write(c.raffle, "escrow", [id], c.seller);
    await c.admit(id);
    await c.write(c.raffle, "open", [id], c.seller);
    return id;
  }
  async function act(action: WorkflowAction) {
    const prepared = await c.service.prepare({ action, wallet: buyer });
    const transaction = await c.service.submit({ prepared, wallet: buyer });
    await c.client.waitForTransactionReceipt({ hash: transaction.hash }); await c.mine();
    expect((await c.service.confirm({ transaction, timeoutMs: 3000 })).kind).toBe("confirmed");
    return { prepared, transaction };
  }
  it("pins struct accounting and quantity-rounded quotes to actual chain state through claims", async () => {
    const id = await opened(49n);
    const read = vi.spyOn(c.client, "readContract");
    const before = await c.service.readRaffle({ id });
    const accountingCall = read.mock.calls.find(([call]) => call.functionName === "getRaffleAccounting");
    expect(accountingCall?.[0].blockNumber).toBe(before.block.number);
    read.mockRestore();
    const policy = await c.service.openingPolicy();
    expect(policy.policy).toMatchObject({ buyerFeeBps: 200, sellerFeeBps: 200 });
    const quote = await c.service.quoteMembership({ id, packId: 0, quantity: 2 });
    expect(quote).toMatchObject({ principal: 98n, fee: 2_500_000n, totalUsdc: 2_500_098n });
    const approval = await act({ kind: "approveUsdc", id, packId: 0, quantity: 2 });
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.prepared.data }).args).toEqual([c.raffle.address, 2_500_098n]);
    const bought = await act({ kind: "buyMembership", id, packId: 0, quantity: 2, acceptedTerms: PUBLISHED_TERMS_HASH,
      agreements: { terms: true, rules: true, age: true }, payment: { kind: "usdc" } });
    expect(bought.prepared.amountUsdc).toBe(2_500_098n);
    expect((await c.service.readRaffle({ id, block: before.block })).accounting).toEqual({ grossPrincipal: 0n, buyerFees: 0n });
    expect((await c.service.readRaffle({ id })).accounting).toEqual({ grossPrincipal: 98n, buyerFees: 2_500_000n });
    await c.warp(before.raffle.salesEnd);
    await c.write(c.raffle, "close", [id]); await c.write(c.raffle, "snapshot", [id, 100n]);
    await c.write(c.raffle, "requestRandomness", [id]);
    const drawing = await c.service.readRaffle({ id });
    await c.write(c.vrf, "fulfill", [c.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    const drawn = await c.service.readRaffle({ id });
    await c.warp(drawn.raffle.drawnAt + drawn.revealGrace);
    await c.write(c.raffle, "settle", [id]);
    expect(sellerAccounting(await c.service.readRaffle({ id }))).toMatchObject({ grossPrincipal: 98n,
      buyerFees: 2_500_000n, sellerCommission: 1n, netProceeds: 97n, claimableProceeds: 97n, paidProceeds: 0n, escrowHeld: 2_500_098n });
    await c.write(c.raffle, "claimFee", [id]); await c.write(c.raffle, "claimProceeds", [id], c.seller);
    expect(sellerAccounting(await c.service.readRaffle({ id }))).toMatchObject({ grossPrincipal: 98n,
      buyerFees: 2_500_000n, sellerCommission: 1n, netProceeds: 97n, claimableProceeds: 0n, paidProceeds: 97n, escrowHeld: 0n });
  }, 30_000);
  it("refuses old or unknown terms for quotes, approvals and purchases", async () => {
    for (const terms of [OLD_TERMS, keccak256("0xffff")]) {
      const id = await opened(49n, terms);
      await expect(c.service.quoteMembership({ id, packId: 0, quantity: 2 })).rejects.toThrow(/terms/);
      await expect(c.service.prepare({ action: { kind: "approveUsdc", id, packId: 0, quantity: 2 }, wallet: buyer })).rejects.toThrow(/terms/);
      await expect(c.service.prepare({ action: { kind: "buyMembership", id, packId: 0, quantity: 2, acceptedTerms: terms,
        agreements: { terms: true, rules: true, age: true }, payment: { kind: "usdc" } }, wallet: buyer })).rejects.toThrow(/terms/);
    }
  }, 30_000);
  it("prepares the maximum exact approval and recovers it without an existing journal", async () => {
    const id = await opened(1_000_000_000_000n);
    const quote = await c.service.quoteMembership({ id, packId: 0, quantity: 20 });
    expect(quote.totalUsdc).toBe(MAX_MEMBERSHIP_TOTAL_USDC);
    const { transaction, prepared } = await act({ kind: "approveUsdc", id, packId: 0, quantity: 20 });
    expect(prepared.amountUsdc).toBe(MAX_MEMBERSHIP_TOTAL_USDC);
    const reloaded = createRaffleService(c.client, c.manifest);
    const excessive = await c.write(c.usdc, "approve", [c.raffle.address, MAX_MEMBERSHIP_TOTAL_USDC + 1n], c.buyer);
    await expect(reloaded.resume({ hash: excessive.transactionHash, wallet: buyer })).rejects.toThrow(/bounded/);
    expect((await reloaded.resume({ hash: transaction.hash, wallet: buyer })).hash).toBe(transaction.hash);
  }, 30_000);
  it("rejects changed runtime, token, chain and on-chain version 2 even with its matching hash", async () => {
    expect((await attestDeployment(c.client, { ...c.manifest, runtimeCodeHash: keccak256("0xff") })).kind).toBe("mismatch");
    expect((await attestDeployment(c.client, { ...c.manifest, usdc: c.nft.address })).kind).toBe("mismatch");
    expect((await attestDeployment(c.client, { ...c.manifest, chainId: 11155111 })).kind).toBe("mismatch");
    const code = await c.client.getCode({ address: c.raffle.address });
    if (!code) throw new Error("Fixture code missing");
    const versionTwo = "0x600260005260206000f3";
    try {
      await c.rpc("anvil_setCode", [c.raffle.address, versionTwo]); await c.mine();
      const result = await attestDeployment(c.client, { ...c.manifest, runtimeCodeHash: keccak256(versionTwo) });
      expect(result).toMatchObject({ kind: "mismatch", reason: expect.stringMatching(/version/) });
    } finally { await c.rpc("anvil_setCode", [c.raffle.address, code]); await c.mine(); }
  });
});
