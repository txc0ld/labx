import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { createRaffleService } from "../lib/chain/service";
import { availableActions } from "../lib/chain/workflow";
import { memoryPendingJournal } from "../lib/chain/pending-journal";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { RafflePolicy, WorkflowAction } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
const attestations = { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } as const;
const changes: readonly [string, (policy: RafflePolicy, chain: LocalChain) => RafflePolicy][] = [
  ["coordinator", (p, c) => ({ ...p, coordinator: c.stranger })], ["treasury", (p, c) => ({ ...p, treasury: c.stranger })],
  ["termsHash", p => ({ ...p, termsHash: keccak256("0xaabb") })], ["keyHash", p => ({ ...p, keyHash: keccak256("0xaabb") })],
  ["subscriptionId", p => ({ ...p, subscriptionId: p.subscriptionId + 1n })],
  ["callbackGasLimit", p => ({ ...p, callbackGasLimit: p.callbackGasLimit + 1 })],
  ["requestConfirmations", p => ({ ...p, requestConfirmations: p.requestConfirmations + 1 })],
  ["nativePayment", p => ({ ...p, nativePayment: !p.nativePayment })],
  ["buyerFeeBps", p => ({ ...p, buyerFeeBps: p.buyerFeeBps + 1 })], ["sellerFeeBps", p => ({ ...p, sellerFeeBps: p.sellerFeeBps + 1 })],
  ["minBuyerFeeUsdc", p => ({ ...p, minBuyerFeeUsdc: p.minBuyerFeeUsdc + 1n })]
];
run("action-specific activation trust on isolated Anvil", () => {
  let c: LocalChain, buyer: WalletSessionPort, seller: WalletSessionPort, owner: WalletSessionPort;
  let draftId: bigint, openId: bigint, checkpoint: unknown;
  beforeAll(async () => {
    c = await localChain();
    buyer = c.wallet(c.buyer).session; seller = c.wallet(c.seller).session; owner = c.wallet(c.operator).session;
    await Promise.all([buyer.connect(), seller.connect(), owner.connect()]);
    draftId = await draft(); await c.admit(draftId);
    openId = await draft(); await c.admit(openId); await c.write(c.raffle, "open", [openId], c.seller);
    await c.write(c.usdc, "mint", [c.buyer, 1_000_000_000n]);
    await c.write(c.usdc, "approve", [c.raffle.address, 1_000_000_000n], c.buyer);
  }, 30_000);
  beforeEach(async () => { checkpoint = await c.rpc("evm_snapshot"); });
  afterEach(async () => { vi.restoreAllMocks(); await c.rpc("evm_revert", [checkpoint]); });
  afterAll(() => c?.close());
  async function draft() {
    const id = await c.client.readContract({ address: c.raffle.address, abi: raffleAbi, functionName: "nextId" });
    const now = (await c.client.getBlock()).timestamp, digest = keccak256("0x12");
    await c.write(c.nft, "mint", [c.seller, id]);
    const commit = await c.client.readContract({ address: c.raffle.address, abi: raffleAbi, functionName: "hashCommitment", args: [digest, c.nft.address, id, digest, digest, digest] });
    await c.write(c.raffle, "createRaffle", [c.nft.address, id, now + 86400n, digest, commit, "Activation trust", [{ name: "Entry", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 100 }]], c.seller);
    await c.write(c.nft, "approve", [c.raffle.address, id], c.seller); await c.write(c.raffle, "escrow", [id], c.seller);
    return id;
  }
  async function approval(): Promise<WorkflowAction> {
    const review = await c.service.readAdmission({ id: draftId });
    if (!review.snapshot.admission.reviewHash) throw new Error("Missing draft review.");
    return { kind: "approveRaffle", id: draftId, expectedReviewHash: review.snapshot.admission.reviewHash, attestations };
  }
  async function opening(): Promise<WorkflowAction> { return { kind: "open", id: draftId, expectedPolicyHash: (await c.service.openingPolicy()).hash }; }
  function purchase(id = openId): WorkflowAction {
    return { kind: "buyMembership", id, packId: 0, quantity: 1, acceptedTerms: c.manifest.expectedPolicy.termsHash, agreements: { terms: true, rules: true, age: true }, payment: { kind: "usdc" } };
  }
  async function allBlocked(service: RaffleService, reason: RegExp) {
    await expect(service.prepare({ action: await approval(), wallet: owner })).rejects.toThrow(reason);
    await expect(service.prepare({ action: await opening(), wallet: seller })).rejects.toThrow(reason);
    await expect(service.quoteMembership({ id: openId, packId: 0, quantity: 1 })).rejects.toThrow(reason);
    await expect(service.prepare({ action: { kind: "approveUsdc", id: openId, packId: 0, quantity: 1 }, wallet: buyer })).rejects.toThrow(reason);
    await expect(service.prepare({ action: purchase(), wallet: buyer })).rejects.toThrow(reason);
  }
  it.each(changes)("checks every opening and frozen policy member: %s", async (_name, change) => {
    const service = createRaffleService(c.client, { ...c.manifest, expectedPolicy: change(c.manifest.expectedPolicy, c) });
    await allBlocked(service, /policy does not match/);
  });
  it("blocks wrong reviewed authority and pending ownership only for new exposure", async () => {
    await allBlocked(createRaffleService(c.client, { ...c.manifest, expectedOwner: c.stranger }), /owner differs/);
    await c.write(c.raffle, "transferOwnership", [c.stranger]);
    await allBlocked(c.service, /pending ownership transfer/);
    const read = await c.service.readRaffle({ id: openId }); expect(read.id).toBe(openId);
    const approved = await approval();
    if (approved.kind !== "approveRaffle") throw new Error("Missing approval action.");
    await expect(c.service.prepare({ action: { kind: "revokeRaffleApproval", id: draftId, expectedReviewHash: approved.expectedReviewHash }, wallet: owner })).resolves.toMatchObject({ action: { kind: "revokeRaffleApproval" } });
  });
  it("checks pending coordinator only for approval and opening, preserving old pinned purchases", async () => {
    await c.write(c.raffle, "proposeCoordinator", [c.nft.address]);
    await expect(c.service.prepare({ action: await approval(), wallet: owner })).rejects.toThrow(/coordinator change is pending/);
    await expect(c.service.prepare({ action: await opening(), wallet: seller })).rejects.toThrow(/coordinator change is pending/);
    await c.write(c.raffle, "setTreasury", [c.stranger]); await c.write(c.raffle, "setNativePayment", [true]);
    await expect(c.service.quoteMembership({ id: openId, packId: 0, quantity: 1 })).resolves.toMatchObject({ totalUsdc: 27_500_000n });
    await expect(c.service.prepare({ action: purchase(), wallet: buyer })).resolves.toMatchObject({ amountUsdc: 27_500_000n });
  });
  it("refuses an unsafe frozen treasury even after future global policy is restored", async () => {
    await c.write(c.raffle, "setTreasury", [c.stranger]);
    const unsafe = await draft(); await c.admit(unsafe); await c.write(c.raffle, "open", [unsafe], c.seller);
    await c.write(c.raffle, "setTreasury", [c.treasury]);
    expect((await c.service.openingPolicy()).policy).toEqual(c.manifest.expectedPolicy);
    await expect(c.service.quoteMembership({ id: unsafe, packId: 0, quantity: 1 })).rejects.toThrow(/policy does not match/);
    await expect(c.service.prepare({ action: purchase(unsafe), wallet: buyer })).rejects.toThrow(/policy does not match/);
  });
  it("requires admission at opening from the reviewed owner, even after owner restoration", async () => {
    await expect(c.service.assertActionTrust({ kind: "membership", id: draftId })).rejects.toThrow(/not opened with approval/);
    await c.write(c.raffle, "transferOwnership", [c.stranger]); await c.write(c.raffle, "acceptOwnership", [], c.stranger);
    const unsafe = await draft();
    const review = await c.service.readAdmission({ id: unsafe });
    if (!review.snapshot.admission.reviewHash) throw new Error("Missing review.");
    await c.write(c.raffle, "approveRaffle", [unsafe, review.snapshot.admission.reviewHash], c.stranger);
    await c.write(c.raffle, "open", [unsafe], c.seller);
    await c.write(c.raffle, "transferOwnership", [c.operator], c.stranger); await c.write(c.raffle, "acceptOwnership");
    await expect(c.service.quoteMembership({ id: unsafe, packId: 0, quantity: 1 })).rejects.toThrow(/not opened with approval/);
    await expect(c.service.prepare({ action: { kind: "approveUsdc", id: unsafe, packId: 0, quantity: 1 }, wallet: buyer })).rejects.toThrow(/not opened with approval/);
    await expect(c.service.prepare({ action: purchase(unsafe), wallet: buyer })).rejects.toThrow(/not opened with approval/);
  });
  it("rechecks trust after preparation before any wallet request or owner payload export", async () => {
    const service = createRaffleService(c.client, c.manifest, memoryPendingJournal());
    const approvals = [await approval(), await opening(), { kind: "approveUsdc", id: openId, packId: 0, quantity: 1 } satisfies WorkflowAction, purchase()];
    const wallets = [owner, seller, buyer, buyer];
    const prepared = await Promise.all(approvals.map((action, i) => service.prepare({ action, wallet: wallets[i] })));
    const exported = await service.prepare({ action: await approval(), wallet: owner });
    await c.write(c.raffle, "transferOwnership", [c.stranger]);
    const requests = wallets.map(wallet => vi.spyOn(wallet, "requestTransaction"));
    for (let i = 0; i < prepared.length; i++) await expect(service.submit({ prepared: prepared[i], wallet: wallets[i] })).rejects.toThrow(/pending ownership transfer/);
    await expect(service.exportOwnerExecution({ prepared: exported, wallet: owner })).rejects.toThrow(/pending ownership transfer/);
    requests.forEach(request => expect(request).not.toHaveBeenCalled());
    expect(await service.pending({ wallet: buyer })).toBeNull();
  });
  it("rejects a changed pinned block after trust reads", async () => {
    const original = c.client.getBlock.bind(c.client);
    let change = false;
    const read = c.client.readContract.bind(c.client);
    vi.spyOn(c.client, "readContract").mockImplementation(async args => {
      const result = await read(args); if (args.functionName === "pendingOwner") change = true; return result;
    });
    vi.spyOn(c.client, "getBlock").mockImplementation(async args => {
      const result = await original(args); return change ? { ...result, hash: keccak256("0x123abc") } : result;
    });
    await expect(c.service.quoteMembership({ id: openId, packId: 0, quantity: 1 })).rejects.toThrow(/state changed/);
  });
  it("keeps liability recovery, receipt confirmation and journal reconciliation usable after all trust settings drift", async () => {
    const journal = memoryPendingJournal(), service = createRaffleService(c.client, c.manifest, journal);
    const prepared = await service.prepare({ action: purchase(), wallet: buyer });
    const transaction = await service.submit({ prepared, wallet: buyer }); await c.client.waitForTransactionReceipt({ hash: transaction.hash }); await c.mine();
    await c.write(c.raffle, "setTreasury", [c.stranger]); await c.write(c.raffle, "proposeCoordinator", [c.nft.address]);
    await c.write(c.raffle, "transferOwnership", [c.stranger]); await c.write(c.raffle, "acceptOwnership", [], c.stranger);
    await c.write(c.raffle, "transferOwnership", [c.operator], c.stranger);
    expect((await service.attest()).kind).toBe("verified");
    const reloaded = createRaffleService(c.client, c.manifest, journal);
    expect(await reloaded.pending({ wallet: buyer })).not.toBeNull();
    expect(await reloaded.resume({ hash: transaction.hash, wallet: buyer })).toMatchObject({ hash: transaction.hash });
    expect(await reloaded.confirm({ transaction, timeoutMs: 2000 })).toMatchObject({ kind: "confirmed" });
    expect(await reloaded.inspectOutcome({ hash: transaction.hash, account: c.buyer })).toMatchObject({ kind: "confirmed" });
    expect((await reloaded.history({ account: c.buyer })).items).toHaveLength(1);
    const snapshot = await reloaded.readRaffle({ id: openId });
    await c.warp(snapshot.raffle.salesEnd + snapshot.drawStartGrace);
    async function execute(action: WorkflowAction, wallet: WalletSessionPort) {
      const tx = await reloaded.submit({ prepared: await reloaded.prepare({ action, wallet }), wallet });
      await c.client.waitForTransactionReceipt({ hash: tx.hash }); await c.mine();
      expect(await reloaded.confirm({ transaction: tx, timeoutMs: 2000 })).toMatchObject({ kind: "confirmed" });
    }
    await execute({ kind: "cancel", id: openId }, buyer);
    const account = await reloaded.readAccount({ id: openId, account: c.buyer });
    expect(availableActions(account.snapshot, account, "Trust drift").find(action => action.kind === "refund")?.enabled).toBe(true);
    await execute({ kind: "refund", id: openId }, buyer); await execute({ kind: "claimFee", id: openId }, buyer); await execute({ kind: "reclaimPrize", id: openId }, seller);
    expect((await reloaded.readAccount({ id: openId, account: c.buyer })).principal).toBe(0n);
  });
  it("preserves close, snapshot, draw, reveal, settlement and all successful claims after authority drift", async () => {
    await c.write(c.raffle, "buyPack", [openId, 0, 1, c.manifest.expectedPolicy.termsHash], c.buyer);
    await c.write(c.raffle, "setTreasury", [c.stranger]); await c.write(c.raffle, "proposeCoordinator", [c.nft.address]);
    await c.write(c.raffle, "transferOwnership", [c.stranger]); await c.write(c.raffle, "acceptOwnership", [], c.stranger);
    await c.write(c.raffle, "transferOwnership", [c.operator], c.stranger);
    async function execute(action: WorkflowAction, wallet: WalletSessionPort) {
      const tx = await c.service.submit({ prepared: await c.service.prepare({ action, wallet }), wallet });
      await c.client.waitForTransactionReceipt({ hash: tx.hash }); await c.mine();
      expect(await c.service.confirm({ transaction: tx, timeoutMs: 2000 })).toMatchObject({ kind: "confirmed" });
    }
    const snapshot = await c.service.readRaffle({ id: openId });
    await c.warp(snapshot.raffle.salesEnd);
    await execute({ kind: "close", id: openId }, buyer);
    await execute({ kind: "snapshot", id: openId, maxSteps: 100n }, buyer);
    await execute({ kind: "requestRandomness", id: openId }, buyer);
    const drawing = await c.service.readRaffle({ id: openId });
    await c.write(c.vrf, "fulfill", [c.raffle.address, drawing.raffle.vrfRequestId, 4n]);
    const digest = keccak256("0x12");
    await execute({ kind: "reveal", id: openId, publicHash: digest, privateHash: digest, salt: digest }, seller);
    await execute({ kind: "settle", id: openId }, buyer);
    await execute({ kind: "claimPrize", id: openId }, buyer);
    await execute({ kind: "claimProceeds", id: openId }, seller);
    await execute({ kind: "claimFee", id: openId }, buyer);
    const claimed = await c.service.readRaffle({ id: openId });
    expect(claimed.raffle.principalEscrow).toBe(0n); expect(claimed.raffle.feeEscrow).toBe(0n); expect(claimed.raffle.escrowed).toBe(false);
  });
  it("rejects a reorg during the final action simulation", async () => {
    const originalCall = c.client.call.bind(c.client), originalBlock = c.client.getBlock.bind(c.client);
    let simulated = false;
    vi.spyOn(c.client, "call").mockImplementation(async args => { const result = await originalCall(args); simulated = true; return result; });
    vi.spyOn(c.client, "getBlock").mockImplementation(async args => { const result = await originalBlock(args); return simulated ? { ...result, hash: keccak256("0xabcdef") } : result; });
    await expect(c.service.prepare({ action: purchase(), wallet: buyer })).rejects.toThrow(/state changed/);
  });
  it("does not require pending trust RPCs for reads, revocation or historical owner confirmation", async () => {
    const prepared = await c.service.prepare({ action: await approval(), wallet: owner });
    const intent = await c.service.exportOwnerExecution({ prepared, wallet: owner });
    const receipt = await c.write(c.raffle, "approveRaffle", [draftId, intent.action.expectedReviewHash]); await c.mine();
    await c.write(c.raffle, "transferOwnership", [c.stranger]);
    const read = c.client.readContract.bind(c.client);
    vi.spyOn(c.client, "readContract").mockImplementation(args => {
      if (args.functionName === "pendingOwner" || args.functionName === "pendingCoordinator") throw new Error("Trust RPC unavailable");
      return read(args);
    });
    await expect(c.service.quoteMembership({ id: openId, packId: 0, quantity: 1 })).rejects.toThrow(/Trust RPC unavailable/);
    await expect(c.service.readAdmission({ id: draftId })).resolves.toMatchObject({ snapshot: { id: draftId } });
    await expect(c.service.confirmOwnerExecution({ intent, hash: receipt.transactionHash, timeoutMs: 2000 })).resolves.toMatchObject({ kind: "executed", state: "approved" });
    await expect(c.service.prepare({ action: { kind: "revokeRaffleApproval", id: draftId, expectedReviewHash: intent.action.expectedReviewHash }, wallet: owner })).resolves.toMatchObject({ action: { kind: "revokeRaffleApproval" } });
  });
});
