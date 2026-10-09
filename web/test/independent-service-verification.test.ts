import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  erc721Abi,
  http,
  keccak256,
  toBytes,
  type Hex
} from "viem";
import { createRaffleService } from "../lib/chain/service";
import { memoryPendingJournal } from "../lib/chain/pending-journal";
import { raffleAbi } from "../lib/chain/abi";
import { hash } from "../lib/chain/validation";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { MemoryStore } from "../lib/store";
import { createReserve, readReserveRecord } from "../lib/reserve";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;

run("independent service verification on isolated Anvil", () => {
  let chain: LocalChain;
  let service: RaffleService;
  let seller: WalletSessionPort;
  let buyer: WalletSessionPort;
  let outsider: WalletSessionPort;

  beforeAll(async () => {
    chain = await localChain();
    service = chain.service;
    seller = chain.wallet(chain.seller).session;
    buyer = chain.wallet(chain.buyer).session;
    outsider = chain.wallet(chain.stranger).session;
    await Promise.all([seller.connect(), buyer.connect(), outsider.connect()]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 1_000_000_000n]);
  }, 30_000);

  afterAll(() => chain?.close());

  async function act(action: WorkflowAction, wallet: WalletSessionPort) {
    const prepared = await service.prepare({ action, wallet });
    const transaction = await service.submit({ prepared, wallet });
    await chain.client.waitForTransactionReceipt({ hash: transaction.hash }); await chain.mine();
    expect(await service.confirm({ transaction, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
    return { prepared, transaction };
  }

  async function createDraft(tokenId: bigint, packPrice = 25_000_000n) {
    await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    const store = new MemoryStore();
    const commitment = await createReserve(store, {
      seller: chain.seller,
      nft: chain.nft.address,
      tokenId: String(tokenId),
      publicSummary: `Prize ${tokenId}`,
      privateCommitment: `Independent private record ${tokenId}`,
      chainId: 31337n,
      labx: chain.raffle.address
    });
    const reveal = await readReserveRecord(store, commitment.commit);
    const latest = await chain.client.getBlock();
    const draft: DraftInput = {
      nft: chain.nft.address,
      tokenId,
      salesEnd: latest.timestamp + 900n,
      reserveNonce: commitment.nonce,
      reserveCommit: commitment.commit,
      title: `Independent ${tokenId}`,
      packs: standardMembershipPacks((tier) => ({
        priceUsdc: tier === "Entry" ? packPrice : 40_000_000n,
        bonusEntries: tier === "Entry" ? 3 : 7,
        maxSupply: tier === "Entry" ? 20 : 10
      }))
    };
    const id = await chain.client.readContract({
      address: chain.raffle.address,
      abi: raffleAbi,
      functionName: "nextId"
    });
    await act({ kind: "createDraft", draft }, seller);
    return { id, draft, reveal };
  }

  async function open(id: bigint) {
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    await chain.admit(id);
    const policy = await service.openingPolicy();
    const opened = await act({ kind: "open", id, expectedPolicyHash: policy.hash }, seller);
    expect(decodeFunctionData({ abi: raffleAbi, data: opened.prepared.data }).functionName).toBe("openWithPolicy");
  }

  async function purchase(id: bigint, quantity: number) {
    const quote = await service.quoteMembership({ id, packId: 0, quantity });
    const approved = await act({ kind: "approveUsdc", id, packId: 0, quantity }, buyer);
    expect(approved.prepared.to).toBe(chain.usdc.address);
    expect(approved.prepared.amountUsdc).toBe(quote.totalUsdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: approved.prepared.data })).toMatchObject({
      functionName: "approve",
      args: [chain.raffle.address, quote.totalUsdc]
    });
    const bought = await act(
      {
        kind: "buyMembership",
        id,
        packId: 0,
        quantity,
        acceptedTerms: PUBLISHED_TERMS_HASH,
        agreements: { terms: true, rules: true, age: true },
        payment: { kind: "usdc" }
      },
      buyer
    );
    expect(bought.prepared.amountUsdc).toBe(quote.totalUsdc);
    expect(bought.prepared.recipient).toBe(chain.raffle.address);
    return { quote, bought };
  }

  it("executes purchase, draw, exact prize/proceeds/fee claims and authoritative rereads", async () => {
    const sellerBefore = await chain.client.readContract({
      address: chain.usdc.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [chain.seller]
    });
    const treasuryBefore = await chain.client.readContract({
      address: chain.usdc.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [chain.treasury]
    });
    const { id, draft, reveal } = await createDraft(101n);
    await act({ kind: "updateDraft", id, draft: { ...draft, title: "Reviewed membership" } }, seller);
    await open(id);
    const { quote, bought } = await purchase(id, 2);
    expect(quote).toMatchObject({ principal: 50_000_000n, fee: 2_500_000n, bonusEntries: 6n });

    const purchased = await service.readAccount({ id, account: chain.buyer });
    expect(purchased.principal).toBe(quote.principal);
    expect(purchased.fee).toBe(quote.fee);
    expect(purchased.usdcAllowance).toBe(0n);
    expect((await service.listLots({ id })).items).toMatchObject([{ owner: chain.buyer, amount: 6 }]);
    expect((await service.history({ account: chain.buyer })).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transactionHash: bought.transaction.hash, principal: quote.principal, fee: quote.fee })
      ])
    );

    await chain.warp(draft.salesEnd);
    await act({ kind: "close", id }, outsider);
    await act({ kind: "snapshot", id, maxSteps: 1n }, outsider);
    await act({ kind: "requestRandomness", id }, seller);
    const drawing = await service.readRaffle({ id });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    await act(
      { kind: "reveal", id, publicHash: reveal.publicHash, privateHash: reveal.privateHash, salt: reveal.salt },
      seller
    );
    await act({ kind: "settle", id }, outsider);

    const prizeReview = await service.prepare({ action: { kind: "claimPrize", id }, wallet: buyer });
    expect(prizeReview.recipient).toBe(chain.buyer);
    await act({ kind: "claimPrize", id }, buyer);
    const proceedsReview = await service.prepare({ action: { kind: "claimProceeds", id }, wallet: seller });
    expect(proceedsReview).toMatchObject({ recipient: chain.seller, amountUsdc: quote.principal * 98n / 100n });
    await act({ kind: "claimProceeds", id }, seller);
    const feeReview = await service.prepare({ action: { kind: "claimFee", id }, wallet: outsider });
    expect(feeReview).toMatchObject({ recipient: chain.treasury, amountUsdc: quote.fee + quote.principal * 2n / 100n });
    await act({ kind: "claimFee", id }, outsider);

    expect(
      await chain.client.readContract({
        address: chain.nft.address,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [101n]
      })
    ).toBe(chain.buyer);
    expect(
      await chain.client.readContract({
        address: chain.usdc.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [chain.seller]
      })
    ).toBe(sellerBefore + quote.principal * 98n / 100n);
    expect(
      await chain.client.readContract({
        address: chain.usdc.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [chain.treasury]
      })
    ).toBe(treasuryBefore + quote.fee + quote.principal * 2n / 100n);
    expect((await service.readRaffle({ id })).raffle).toMatchObject({ principalEscrow: 0n, feeEscrow: 0n });
  }, 30_000);

  it("executes paused timed cancellation, exact buyer refund and seller reclaim", async () => {
    const buyerBefore = await chain.client.readContract({
      address: chain.usdc.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [chain.buyer]
    });
    const outsiderBefore = await chain.client.getBalance({ address: chain.stranger });
    const { id, draft } = await createDraft(102n);
    await open(id);
    const { quote } = await purchase(id, 1);
    await chain.write(chain.raffle, "setPaused", [true]);
    try {
      await chain.warp(draft.salesEnd + 7n * 86400n);
      await act({ kind: "cancel", id }, outsider);
      const refundReview = await service.prepare({ action: { kind: "refund", id }, wallet: buyer });
      expect(refundReview).toMatchObject({ recipient: chain.buyer, amountUsdc: quote.principal });
      await act({ kind: "refund", id }, buyer);
      const reclaimReview = await service.prepare({ action: { kind: "reclaimPrize", id }, wallet: seller });
      expect(reclaimReview.recipient).toBe(chain.seller);
      await act({ kind: "reclaimPrize", id }, seller);
    } finally {
      await chain.write(chain.raffle, "setPaused", [false]);
    }
    expect(
      await chain.client.readContract({
        address: chain.usdc.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [chain.buyer]
      })
    ).toBe(buyerBefore - quote.fee);
    expect(await chain.client.getBalance({ address: chain.stranger })).toBeLessThanOrEqual(outsiderBefore);
    expect(
      await chain.client.readContract({
        address: chain.nft.address,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [102n]
      })
    ).toBe(chain.seller);
    await expect(service.prepare({ action: { kind: "claimProceeds", id }, wallet: seller })).rejects.toThrow();
    const retained = await service.prepare({ action: { kind: "claimFee", id }, wallet: outsider });
    expect(retained.amountUsdc).toBe(quote.fee);
    await act({ kind: "claimFee", id }, outsider);
    await expect(service.prepare({ action: { kind: "claimFee", id }, wallet: outsider })).rejects.toThrow();
  }, 30_000);

  it("rejects bytecode, account, chain and revision drift plus a policy race before wallet submission", async () => {
    const wrong = createRaffleService(chain.client, {
      ...chain.manifest,
      runtimeCodeHash: keccak256(toBytes("unreviewed runtime"))
    });
    expect(await wrong.attest()).toMatchObject({ kind: "mismatch" });
    await expect(wrong.listRaffles()).rejects.toThrow(/bytecode/);

    const { id } = await createDraft(103n);
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    await chain.admit(id);
    const policy = await service.openingPolicy();

    const accountControl = chain.wallet(chain.seller);
    await accountControl.session.connect();
    const accountReview = await service.prepare({
      action: { kind: "open", id, expectedPolicyHash: policy.hash },
      wallet: accountControl.session
    });
    accountControl.changeAccount(chain.buyer);
    await expect(service.submit({ prepared: accountReview, wallet: accountControl.session })).rejects.toThrow(/changed/);

    const chainControl = chain.wallet(chain.seller);
    await chainControl.session.connect();
    const chainReview = await service.prepare({
      action: { kind: "open", id, expectedPolicyHash: policy.hash },
      wallet: chainControl.session
    });
    chainControl.changeChain("0x1");
    await expect(service.submit({ prepared: chainReview, wallet: chainControl.session })).rejects.toThrow(/changed/);

    const revisionControl = chain.wallet(chain.seller);
    await revisionControl.session.connect();
    const revisionReview = await service.prepare({
      action: { kind: "open", id, expectedPolicyHash: policy.hash },
      wallet: revisionControl.session
    });
    revisionControl.changeAccount(chain.seller);
    await expect(service.submit({ prepared: revisionReview, wallet: revisionControl.session })).rejects.toThrow(/changed/);

    const raced = await service.prepare({
      action: { kind: "open", id, expectedPolicyHash: policy.hash },
      wallet: seller
    });
    await chain.write(chain.raffle, "setTreasury", [chain.stranger]);
    await expect(service.submit({ prepared: raced, wallet: seller })).rejects.toThrow(/Opening policy changed/);
    await chain.write(chain.raffle, "setTreasury", [chain.treasury]);
  }, 30_000);

  it("handles uncertain submission, pending status, reload resume and a mined revert", async () => {
    const { id } = await createDraft(104n);
    const journal = memoryPendingJournal();
    const uncertainService = createRaffleService(chain.client, chain.manifest, journal);
    const controlled = chain.wallet(chain.seller);
    await controlled.session.connect();
    const captured: Hex[] = [];
    const uncertain: WalletSessionPort = {
      getSnapshot: () => controlled.session.getSnapshot(),
      subscribe: listener => controlled.session.subscribe(listener),
      connect: () => controlled.session.connect(),
      refresh: () => controlled.session.refresh(),
      disconnect: () => controlled.session.disconnect(),
      assertCurrent: expected => controlled.session.assertCurrent(expected),
      signMessage: input => controlled.session.signMessage(input),
      async requestTransaction(expected, transaction, beforeRequest, onProviderRequest) {
        captured.push(await controlled.session.requestTransaction(expected, transaction, beforeRequest, onProviderRequest));
        throw new Error("provider timed out after accepting transaction");
      }
    };
    await chain.rpc("evm_setAutomine", [false]);
    try {
      const prepared = await uncertainService.prepare({ action: { kind: "approvePrize", id }, wallet: uncertain });
      await expect(uncertainService.submit({ prepared, wallet: uncertain })).rejects.toThrow(/uncertain/);
      const hash = captured[0];
      if (!hash) throw new Error("Uncertain wallet did not submit a fixture transaction.");
      const reloaded = createRaffleService(chain.client, chain.manifest, journal);
      const resumed = await reloaded.resume({ hash, wallet: controlled.session });
      if (!resumed) throw new Error("The persisted uncertain send was not available after reload.");
      expect(await reloaded.confirm({ transaction: resumed, timeoutMs: 1_000 })).toEqual({ kind: "pending", hash });
      await chain.mine();
      await chain.mine();
      expect(await reloaded.confirm({ transaction: resumed, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
      service = reloaded;
    } finally {
      await chain.rpc("evm_setAutomine", [true]);
    }

    const reverted = await chain.rpc("eth_sendTransaction", [
      {
        from: chain.buyer,
        to: chain.raffle.address,
        data: encodeFunctionData({ abi: raffleAbi, functionName: "claimPrize", args: [2n ** 200n] }),
        gas: "0x186a0"
      }
    ]);
    if (typeof reverted !== "string" || !/^0x[0-9a-f]{64}$/i.test(reverted)) {
      throw new Error("Fixture reverted transaction was not submitted.");
    }
    await chain.mine();
    await chain.mine();
    expect(await service.pending({ wallet: buyer })).toBeNull();
    expect(await service.inspectOutcome({ hash: hash(reverted), account: chain.buyer, timeoutMs: 3_000 })).toMatchObject({ kind: "reverted" });
    expect(await service.pending({ wallet: buyer })).toBeNull();
  }, 30_000);

  it("detects replacement with different intent and keeps pagination block-bound and bounded", async () => {
    const { id } = await createDraft(105n);
    await open(id);
    await chain.rpc("evm_setAutomine", [false]);
    try {
      const prepared = await service.prepare({
        action: { kind: "approveUsdc", id, packId: 0, quantity: 1 },
        wallet: buyer
      });
      const submitted = await service.submit({ prepared, wallet: buyer });
      const original = await chain.client.getTransaction({ hash: submitted.hash });
      const confirmation = service.confirm({ transaction: submitted, timeoutMs: 5_000 });
      await new Promise(resolve => setTimeout(resolve, 100));
      await chain.rpc("eth_sendTransaction", [
        {
          from: chain.buyer,
          to: chain.buyer,
          value: "0x0",
          nonce: `0x${original.nonce.toString(16)}`,
          gasPrice: "0x174876e800",
          gas: "0x5208"
        }
      ]);
      await chain.mine();
      await new Promise(resolve => setTimeout(resolve, 150));
      await chain.mine();
      expect(await confirmation).toMatchObject({ kind: "replaced" });
    } finally {
      await chain.rpc("evm_setAutomine", [true]);
    }

    const first = await service.listRaffles({ limit: 1 });
    await chain.mine();
    if (first.nextCursor === null) throw new Error("Expected a second catalog page.");
    const second = await service.listRaffles({ cursor: first.nextCursor, limit: 1, block: first.block });
    expect(second.block).toEqual(first.block);
    expect(second.items.every(item => item.block.hash === first.block.hash)).toBe(true);
    await expect(service.listRaffles({ limit: 0 })).rejects.toThrow(/range/);
    await expect(service.listRaffles({ limit: 25 })).rejects.toThrow(/range/);
    await expect(service.listLots({ id: 1n, limit: 101 })).rejects.toThrow(/range/);
    await expect(service.history({ account: chain.buyer, fromBlock: chain.manifest.deploymentBlock - 1n })).rejects.toThrow(
      /range/
    );
    await expect(
      service.listRaffles({ block: { ...first.block, hash: keccak256(toBytes("replaced block")) } })
    ).rejects.toThrow(/Chain state changed/);
  }, 30_000);

  it("surfaces an unavailable RPC instead of returning authoritative-looking empty data", async () => {
    const unavailable = createRaffleService(
      createPublicClient({ transport: http("http://127.0.0.1:1", { retryCount: 0, timeout: 100 }) }),
      chain.manifest
    );

    await expect(unavailable.listRaffles()).rejects.toThrow();
  });
});
