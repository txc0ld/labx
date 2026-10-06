import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, erc721Abi, keccak256, toBytes } from "viem";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { createRaffleService } from "../lib/chain/service";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { MemoryStore } from "../lib/store";
import { createReserve, readReserveRecord } from "../lib/reserve";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import type { WalletSessionPort } from "../lib/chain/ports";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
run("isolated Anvil seller and membership journeys", () => {
  let chain: LocalChain;
  let seller: WalletSessionPort, buyer: WalletSessionPort, stranger: WalletSessionPort;
  beforeAll(async () => {
    chain = await localChain(); seller = chain.wallet(chain.seller).session; buyer = chain.wallet(chain.buyer).session; stranger = chain.wallet(chain.stranger).session;
    await Promise.all([seller.connect(), buyer.connect(), stranger.connect()]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000_000n]);
  }, 30_000);
  afterAll(() => chain?.close());
  async function act(action: WorkflowAction, wallet = seller) {
    const prepared = await chain.service.prepare({ action, wallet });
    const transaction = await chain.service.submit({ prepared, wallet });
    await chain.mine();
    expect((await chain.service.confirm({ transaction, timeoutMs: 3000 })).kind).toBe("confirmed");
    return { prepared, transaction };
  }
  async function draft(tokenId: bigint) {
    await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    const store = new MemoryStore();
    const commitment = await createReserve(store, { nft: chain.nft.address, tokenId: String(tokenId), seller: chain.seller, publicSummary: "The escrowed token is the prize.", privateCommitment: `Local fixture ${tokenId}`, chainId: 31337n, labx: chain.raffle.address });
    const reveal = await readReserveRecord(store, commitment.commit);
    const latest = await chain.client.getBlock();
    const input: DraftInput = { nft: chain.nft.address, tokenId, title: `Fixture ${tokenId}`, salesEnd: latest.timestamp + 1000n, reserveNonce: commitment.nonce, reserveCommit: commitment.commit, packs: [{ name: "Entry", priceUsdc: 25_000_000n, bonusEntries: 3, maxSupply: 20 }] };
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await act({ kind: "createDraft", draft: input });
    return { id, input, reveal };
  }
  async function open(id: bigint) {
    const approved = await act({ kind: "approvePrize", id });
    expect(decodeFunctionData({ abi: erc721Abi, data: approved.prepared.data })).toMatchObject({ functionName: "approve", args: [chain.raffle.address, expect.any(BigInt)] });
    await act({ kind: "escrow", id });
    const policy = await chain.service.openingPolicy();
    const opened = await act({ kind: "open", id, expectedPolicyHash: policy.hash });
    expect(decodeFunctionData({ abi: raffleAbi, data: opened.prepared.data }).functionName).toBe("openWithPolicy");
  }
  async function purchase(id: bigint) {
    const approval = await act({ kind: "approveUsdc", id, packId: 0, quantity: 2 }, buyer);
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.prepared.data })).toMatchObject({ functionName: "approve", args: [chain.raffle.address, 60_000_000n] });
    return act({ kind: "buyMembership", id, packId: 0, quantity: 2, acceptedTerms: PUBLISHED_TERMS_HASH, agreements: { terms: true, rules: true, age: true }, payment: { kind: "usdc" } }, buyer);
  }
  it("runs draft edit, exact approvals, purchase, draw, reveal, settlement and separate claims", async () => {
    const { id, input, reveal } = await draft(1n);
    await act({ kind: "updateDraft", id, draft: { ...input, title: "Updated local fixture" } });
    await open(id);
    await expect(chain.service.prepare({ action: { kind: "close", id }, wallet: seller })).rejects.toThrow(/published deadline/);
    const bought = await purchase(id);
    const account = await chain.service.readAccount({ id, account: chain.buyer });
    expect(account.principal).toBe(50_000_000n); expect(account.fee).toBe(10_000_000n); expect(account.usdcAllowance).toBe(0n);
    const lots = await chain.service.listLots({ id }); expect(lots.items).toHaveLength(1); expect(lots.items[0].amount).toBe(6);
    const history = await chain.service.history({ account: chain.buyer }); expect(history.items.find(row => row.transactionHash === bought.transaction.hash)?.bonusEntries).toBe(6);
    await expect(chain.service.prepare({ action: { kind: "cancel", id }, wallet: seller })).rejects.toThrow(/discretionary cancellation/);
    await chain.warp(input.salesEnd); await act({ kind: "close", id }, stranger); await act({ kind: "snapshot", id, maxSteps: 100n }, stranger); await act({ kind: "requestRandomness", id });
    const drawing = await chain.service.readRaffle({ id }); await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 4n]);
    await expect(chain.service.prepare({ action: { kind: "settle", id }, wallet: stranger })).rejects.toThrow(/seven-day/);
    await act({ kind: "reveal", id, publicHash: reveal.publicHash, privateHash: reveal.privateHash, salt: reveal.salt });
    await act({ kind: "settle", id }, stranger); await act({ kind: "claimPrize", id }, buyer); await act({ kind: "claimProceeds", id }); await act({ kind: "claimFee", id }, stranger);
    expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [1n] })).toBe(chain.buyer);
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] })).toBe(50_000_000n);
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.treasury] })).toBe(10_000_000n);
    await expect(chain.service.prepare({ action: { kind: "claimPrize", id }, wallet: buyer })).rejects.toThrow(/unclaimed NFT/);
  }, 30_000);
  it("recovers a funded raffle without a draw through buyer refunds and seller NFT reclaim", async () => {
    const { id, input } = await draft(2n); await open(id); await purchase(id);
    await chain.warp(input.salesEnd + 7n * 86400n); await act({ kind: "cancel", id }, stranger);
    const before = await chain.service.readAccount({ id, account: chain.buyer });
    await act({ kind: "refund", id }, buyer); await act({ kind: "reclaimPrize", id });
    const after = await chain.service.readAccount({ id, account: chain.buyer }); expect(after.usdcBalance - before.usdcBalance).toBe(60_000_000n); expect(after.principal + after.fee).toBe(0n);
    expect(after.nftOwner).toBe(chain.seller);
    await expect(chain.service.prepare({ action: { kind: "refund", id }, wallet: buyer })).rejects.toThrow(/no remaining refund/);
  }, 30_000);
  it("rejects unreviewed bytecode, stale wallet sessions and changed opening policy", async () => {
    const invalid = createRaffleService(chain.client, { ...chain.manifest, runtimeCodeHash: keccak256(toBytes("different code")) });
    expect((await invalid.attest()).kind).toBe("mismatch"); await expect(invalid.listRaffles()).rejects.toThrow(/bytecode/);
    const { id } = await draft(3n); await act({ kind: "approvePrize", id }); await act({ kind: "escrow", id });
    const wallet = chain.wallet(chain.seller); await wallet.session.connect(); const policy = await chain.service.openingPolicy();
    const prepared = await chain.service.prepare({ action: { kind: "open", id, expectedPolicyHash: policy.hash }, wallet: wallet.session });
    wallet.changeAccount(chain.buyer); await expect(chain.service.submit({ prepared, wallet: wallet.session })).rejects.toThrow(/Wallet or network changed/);
    const review = await chain.service.prepare({ action: { kind: "open", id, expectedPolicyHash: policy.hash }, wallet: seller });
    await chain.write(chain.raffle, "setTreasury", [chain.stranger]);
    await expect(chain.service.submit({ prepared: review, wallet: seller })).rejects.toThrow(/Opening policy changed/);
    await openExistingEscrow(id);
  }, 30_000);
  async function openExistingEscrow(id: bigint) { const policy = await chain.service.openingPolicy(); await act({ kind: "open", id, expectedPolicyHash: policy.hash }); }
  it("handles rejected signatures, duplicate submit, pending confirmation and reload recovery", async () => {
    const { id } = await draft(4n); const wallet = chain.wallet(chain.seller); await wallet.session.connect();
    const rejected = await chain.service.prepare({ action: { kind: "approvePrize", id }, wallet: wallet.session }); wallet.reject(true);
    await expect(chain.service.submit({ prepared: rejected, wallet: wallet.session })).rejects.toMatchObject({ code: 4001 }); wallet.reject(false);
    const review = await chain.service.prepare({ action: { kind: "approvePrize", id }, wallet: wallet.session });
    const tx = await chain.service.submit({ prepared: review, wallet: wallet.session });
    await expect(chain.service.submit({ prepared: review, wallet: wallet.session })).rejects.toThrow(/already submitted/);
    expect((await chain.service.confirm({ transaction: tx, timeoutMs: 1000 })).kind).toBe("pending");
    const reloaded = createRaffleService(chain.client, chain.manifest); const resumed = await reloaded.resume({ hash: tx.hash, wallet: wallet.session }); await chain.mine();
    expect((await reloaded.confirm({ transaction: resumed, timeoutMs: 3000 })).kind).toBe("confirmed");
    await chain.service.confirm({ transaction: tx, timeoutMs: 3000 });
  }, 15_000);
  it("purchases with a bounded ETH quote, then refunds when randomness misses its seven-day deadline", async () => {
    const { id, input } = await draft(5n); await open(id);
    await chain.write(chain.feed, "setUpdatedAt", [(await chain.client.getBlock()).timestamp]);
    await chain.write(chain.raffle, "setEthPathEnabled", [true]);
    const quote = await chain.service.quoteMembership({ id, packId: 0, quantity: 1, slippageBps: 100 });
    if (quote.eth.kind !== "available") throw new Error(quote.eth.reason);
    const action: WorkflowAction = { kind: "buyMembership", id, packId: 0, quantity: 1, acceptedTerms: PUBLISHED_TERMS_HASH, agreements: { terms: true, rules: true, age: true }, payment: { kind: "eth", maxEth: quote.eth.maxEth, slippageBps: quote.eth.slippageBps, deadline: quote.eth.deadline } };
    const review = await chain.service.prepare({ action, wallet: buyer }); expect(review.value).toBe(quote.eth.maxEth); expect(review.amountUsdc).toBe(30_000_000n);
    const purchased = await chain.service.submit({ prepared: review, wallet: buyer }); await chain.mine(); expect((await chain.service.confirm({ transaction: purchased })).kind).toBe("confirmed");
    expect((await chain.service.readAccount({ id, account: chain.buyer })).principal).toBe(25_000_000n);
    await chain.warp(input.salesEnd); await act({ kind: "close", id }, stranger); await act({ kind: "snapshot", id, maxSteps: 100n }, stranger);
    await chain.write(chain.raffle, "setPaused", [true]); await act({ kind: "requestRandomness", id });
    const drawing = await chain.service.readRaffle({ id });
    await expect(chain.service.prepare({ action: { kind: "abortDrawing", id }, wallet: buyer })).rejects.toThrow(/deadline/);
    await chain.warp(drawing.raffle.vrfRequestedAt + 7n * 86400n); await act({ kind: "abortDrawing", id }, stranger); await act({ kind: "refund", id }, buyer); await act({ kind: "reclaimPrize", id });
    await chain.write(chain.raffle, "setPaused", [false]); await chain.write(chain.raffle, "setEthPathEnabled", [false]);
  }, 30_000);
  it("allows permissionless settlement after the reveal grace without seller cooperation", async () => {
    const { id, input } = await draft(6n); await open(id); await purchase(id);
    await chain.warp(input.salesEnd); await act({ kind: "close", id }, stranger); await act({ kind: "snapshot", id, maxSteps: 1n }, stranger); await act({ kind: "requestRandomness", id });
    const drawing = await chain.service.readRaffle({ id }); await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    const drawn = await chain.service.readRaffle({ id }); await chain.warp(drawn.raffle.drawnAt + 7n * 86400n);
    await act({ kind: "settle", id }, stranger); await act({ kind: "claimPrize", id }, buyer);
    expect((await chain.service.readRaffle({ id })).raffle.revealed).toBe(false);
  }, 30_000);

});
