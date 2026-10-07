import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, keccak256, zeroHash } from "viem";
import { hash } from "../lib/chain/validation";
import { raffleAbi } from "../lib/chain/abi";
import { createRaffleService } from "../lib/chain/service";
import { availableActions } from "../lib/chain/workflow";
import { parseOwnerExecutionIntent, serializeOwnerExecutionIntent } from "../lib/chain/owner-execution";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
const attestations = { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } as const;
run("admission review and external owner execution", () => {
  let c: LocalChain;
  beforeAll(async () => { c = await localChain(); }, 30000);
  afterAll(() => c?.close());
  async function draft() {
    const id = await c.client.readContract({ address: c.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await c.write(c.nft, "mint", [c.seller, id]);
    const now = (await c.client.getBlock()).timestamp, digest = keccak256("0x12");
    await c.write(c.raffle, "createRaffle", [c.nft.address, id, now + 86400n, digest, digest, "Admission", [{ name: "Entry", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 100 }]], c.seller);
    await c.write(c.nft, "approve", [c.raffle.address, id], c.seller);
    await c.write(c.raffle, "escrow", [id], c.seller);
    return id;
  }
  async function exported(id: bigint, owner = c.operator, revoke = false) {
    const wallet = c.wallet(owner).session; await wallet.connect();
    const review = await c.service.readAdmission({ id });
    const expectedReviewHash = review.snapshot.admission.reviewHash;
    if (expectedReviewHash === null) throw new Error("Fixture draft required.");
    const action = revoke ? { kind: "revokeRaffleApproval" as const, id, expectedReviewHash } : { kind: "approveRaffle" as const, id, expectedReviewHash, attestations };
    const prepared = await c.service.prepare({ action, wallet });
    return { wallet, prepared, intent: await c.service.exportOwnerExecution({ prepared, wallet }) };
  }
  it("reads owner identity at a canonical block even for an empty queue", async () => {
    const page = await c.service.listOwnerQueue();
    expect(page.items).toEqual([]);
    expect(await c.service.readOwner({ block: page.block })).toEqual({ owner: c.operator, block: page.block });
  });
  it("checks bounded queue pages without NFT metadata or custody calls", async () => {
    const first = await draft(); await c.admit(first); await c.write(c.raffle, "open", [first], c.seller);
    const second = await draft();
    const spy = vi.spyOn(c.client, "readContract");
    const page = await c.service.listOwnerQueue({ cursor: first, limit: 1 });
    expect(page.items).toEqual([]); expect(page.nextCursor).toBe(second);
    const next = await c.service.listOwnerQueue({ cursor: second, limit: 1, block: page.block });
    expect(next.items.map(item => item.id)).toEqual([second]);
    expect(spy.mock.calls.some(([call]) => call.functionName === "ownerOf" || call.functionName === "tokenURI")).toBe(false);
    spy.mockRestore();
    await expect(c.service.listOwnerQueue({ limit: 25 })).rejects.toThrow();
  });
  it("requires actual owner identity and current review at export, retaining seller isolation", async () => {
    const id = await draft(); const review = await c.service.readAdmission({ id });
    expect(review.custody.kind).toBe("held"); expect(review.nftCodeHash).not.toBeNull();
    const owner = c.wallet(c.operator).session, seller = c.wallet(c.seller).session;
    await owner.connect(); await seller.connect();
    const expectedReviewHash = review.snapshot.admission.reviewHash ?? zeroHash;
    const action = { kind: "approveRaffle" as const, id, expectedReviewHash, attestations };
    await expect(c.service.prepare({ action, wallet: seller })).rejects.toThrow(/current owner/);
    const prepared = await c.service.prepare({ action, wallet: owner });
    await c.write(c.raffle, "setNativePayment", [false]);
    await expect(c.service.exportOwnerExecution({ prepared, wallet: owner })).rejects.toThrow(/changed/);
    const sellerState = await c.service.readAccount({ id, account: c.seller });
    expect(availableActions(sellerState.snapshot, sellerState).find(action => action.kind === "open")?.enabled).toBe(false);
  });
  it("retains direct EOA submission and recovery for exact owner selectors", async () => {
    const id = await draft(), wallet = c.wallet(c.operator).session; await wallet.connect();
    const review = await c.service.readAdmission({ id });
    const action = { kind: "approveRaffle" as const, id, expectedReviewHash: review.snapshot.admission.reviewHash ?? zeroHash, attestations: { ...attestations } };
    Object.assign(action.attestations, { drawFunding: false });
    await expect(c.service.prepare({ action, wallet })).rejects.toThrow(/funding first/);
    Object.assign(action.attestations, { drawFunding: true });
    const prepared = await c.service.prepare({ action, wallet });
    const submitted = await c.service.submit({ prepared, wallet });
    await c.client.waitForTransactionReceipt({ hash: submitted.hash }); await c.mine();
    expect(await c.service.confirm({ transaction: submitted, timeoutMs: 2000 })).toMatchObject({ kind: "confirmed" });
    const reloaded = createRaffleService(c.client, c.manifest);
    const recovered = await reloaded.resume({ hash: submitted.hash, wallet });
    expect(await reloaded.confirm({ transaction: recovered, timeoutMs: 2000 })).toMatchObject({ kind: "confirmed" });
  });
  it("rejects reverted outer transactions and mismatching approvers", async () => {
    const id = await draft(); const { intent } = await exported(id);
    const failedHash = hash(await c.rpc("eth_sendTransaction", [{ from: c.operator, to: c.raffle.address,
      data: encodeFunctionData({ abi: raffleAbi, functionName: "approveRaffle", args: [id, zeroHash] }), gas: "0xf4240" }]));
    await c.client.waitForTransactionReceipt({ hash: failedHash }); await c.mine();
    await expect(c.service.confirmOwnerExecution({ intent, hash: failedHash, timeoutMs: 2000 })).rejects.toThrow(/No successful/);
    const receipt = await c.admit(id); await c.mine();
    await expect(c.service.confirmOwnerExecution({ intent: { ...intent, from: c.seller }, hash: receipt.transactionHash, timeoutMs: 2000 })).rejects.toThrow(/no matching/);
  });
  it("persists a bounded deployment/account-bound public intent and confirms exact event after reload", async () => {
    const id = await draft(); const { intent } = await exported(id);
    const raw = serializeOwnerExecutionIntent(intent);
    expect(parseOwnerExecutionIntent(raw, c.manifest, c.operator)).toEqual(intent);
    for (const changed of [{ ...intent, value: 1n }, { ...intent, data: "0x" }, { ...intent, ownerGeneration: -1n }, { ...intent, runtimeCodeHash: zeroHash }]) {
      expect(() => parseOwnerExecutionIntent(JSON.stringify(changed, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value), c.manifest, c.operator)).toThrow();
    }
    expect(() => parseOwnerExecutionIntent(raw, c.manifest, c.seller)).toThrow();
    expect(() => parseOwnerExecutionIntent(" ".repeat(8193), c.manifest, c.operator)).toThrow();
    const receipt = await c.write(c.raffle, "approveRaffle", [id, intent.action.expectedReviewHash]); await c.mine();
    const reloaded = createRaffleService(c.client, c.manifest);
    const result = await reloaded.confirmOwnerExecution({ intent: parseOwnerExecutionIntent(raw, c.manifest, c.operator), hash: receipt.transactionHash, timeoutMs: 2000 });
    expect(result).toMatchObject({ kind: "executed", state: "approved" });
    await c.write(c.raffle, "setNativePayment", [false]);
    expect(await reloaded.confirmOwnerExecution({ intent, hash: receipt.transactionHash, timeoutMs: 2000 })).toMatchObject({ kind: "executed", state: "stale" });
  });
  it("rejects unrelated events and reconciles revocation separately from later approval", async () => {
    const id = await draft(); const { intent } = await exported(id);
    const unrelated = await c.write(c.raffle, "setPaused", [false]); await c.mine();
    await expect(c.service.confirmOwnerExecution({ intent, hash: unrelated.transactionHash, timeoutMs: 2000 })).rejects.toThrow(/no matching/);
    await c.write(c.raffle, "approveRaffle", [id, intent.action.expectedReviewHash]);
    const revoke = await exported(id, c.operator, true);
    const receipt = await c.write(c.raffle, "revokeRaffleApproval", [id, revoke.intent.action.expectedReviewHash]); await c.mine();
    expect(await c.service.confirmOwnerExecution({ intent: revoke.intent, hash: receipt.transactionHash, timeoutMs: 2000 })).toMatchObject({ kind: "executed", state: "revoked" });
    await c.admit(id);
    expect(await c.service.confirmOwnerExecution({ intent: revoke.intent, hash: receipt.transactionHash, timeoutMs: 2000 })).toMatchObject({ kind: "executed", state: "stale" });
  });
  it("rejects other raffles, unknown proposal hashes and custody failures without hiding revocation", async () => {
    const id = await draft(), other = await draft(); const { intent } = await exported(id);
    const otherReceipt = await c.admit(other); await c.mine();
    await expect(c.service.confirmOwnerExecution({ intent, hash: otherReceipt.transactionHash, timeoutMs: 1000 })).rejects.toThrow(/no matching/);
    expect(await c.service.confirmOwnerExecution({ intent, hash: keccak256("0x9876"), timeoutMs: 1000 })).toMatchObject({ kind: "pending" });
    await c.admit(id);
    const code = await c.client.getCode({ address: c.nft.address });
    if (!code) throw new Error("Fixture NFT code missing.");
    try {
      await c.rpc("anvil_setCode", [c.nft.address, "0x60006000fd"]); await c.mine();
      const broken = await c.service.readAdmission({ id });
      expect(broken.custody.kind).toBe("unknown");
      expect(broken.snapshot.admission.status).toBe("changed");
      const revoked = await exported(id, c.operator, true);
      const receipt = await c.write(c.raffle, "revokeRaffleApproval", [id, revoked.intent.action.expectedReviewHash]); await c.mine();
      expect(await c.service.confirmOwnerExecution({ intent: revoked.intent, hash: receipt.transactionHash, timeoutMs: 2000 })).toMatchObject({ kind: "executed", state: "revoked" });
    } finally { await c.rpc("anvil_setCode", [c.nft.address, code]); await c.mine(); }
  });
  it("rejects a receipt reorg even after a matching approval event", async () => {
    const id = await draft(); const { intent } = await exported(id);
    const receipt = await c.write(c.raffle, "approveRaffle", [id, intent.action.expectedReviewHash]); await c.mine();
    const original = c.client.getBlock.bind(c.client);
    const spy = vi.spyOn(c.client, "getBlock").mockImplementation(async args => {
      const block = await original(args);
      return args?.blockNumber === receipt.blockNumber ? { ...block, hash: zeroHash } : block;
    });
    await expect(c.service.confirmOwnerExecution({ intent, hash: receipt.transactionHash, timeoutMs: 2000 })).rejects.toThrow(/block changed/);
    spy.mockRestore();
  });
  it("rejects a canonical admission snapshot older than the required execution depth", async () => {
    const id = await draft(); const { intent } = await exported(id);
    await c.admit(id); const older = await c.client.getBlock();
    const receipt = await c.write(c.raffle, "approveRaffle", [id, intent.action.expectedReviewHash]); await c.mine();
    const original = c.client.getBlock.bind(c.client);
    const spy = vi.spyOn(c.client, "getBlock").mockImplementation(async args => args?.blockTag === "latest" ? older : original(args));
    try { await expect(c.service.confirmOwnerExecution({ intent, hash: receipt.transactionHash, timeoutMs: 2000 })).rejects.toThrow(/confirmation depth/); }
    finally { spy.mockRestore(); }
  });
  it("rejects a review block replaced during receipt confirmation", async () => {
    const id = await draft(); const { intent } = await exported(id);
    const receipt = await c.admit(id); await c.mine();
    const original = c.client.getBlock.bind(c.client); let reviewReads = 0;
    const spy = vi.spyOn(c.client, "getBlock").mockImplementation(async args => {
      const block = await original(args);
      if (args?.blockNumber === intent.reviewBlock.number && ++reviewReads > 1) return { ...block, hash: zeroHash };
      return block;
    });
    try { await expect(c.service.confirmOwnerExecution({ intent, hash: receipt.transactionHash, timeoutMs: 2000 })).rejects.toThrow(/state changed/); }
    finally { spy.mockRestore(); }
  });
  it("confirms an outer executor different from the contract owner and refuses failed inner calls", async () => {
    const safe = await c.deploy("Mocks.sol", "OwnerExecutorFixture");
    await c.write(c.raffle, "transferOwnership", [safe.address]);
    await c.write(safe, "execute", [c.raffle.address, encodeFunctionData({ abi: raffleAbi, functionName: "acceptOwnership" })], c.stranger);
    const id = await draft(); const { intent, wallet } = await exported(id, safe.address);
    expect(intent.from).toBe(safe.address); expect(intent.value).toBe(0n);
    const repeat = await c.service.prepare({ action: intent.action, wallet });
    await expect(c.service.submit({ prepared: repeat, wallet })).rejects.toThrow(/external execution/);
    expect(await c.service.pending({ wallet })).toBeNull();
    const outer = await c.write(safe, "execute", [intent.to, intent.data], c.stranger); await c.mine();
    const tx = await c.client.getTransaction({ hash: outer.transactionHash }); expect(tx.from.toLowerCase()).toBe(c.stranger.toLowerCase()); expect(tx.to?.toLowerCase()).toBe(safe.address.toLowerCase());
    expect(await c.service.confirmOwnerExecution({ intent, hash: outer.transactionHash, timeoutMs: 2000 })).toMatchObject({ kind: "executed", state: "approved" });
    const revoke = await exported(id, safe.address, true);
    const wrongDigest = encodeFunctionData({ abi: raffleAbi, functionName: "revokeRaffleApproval", args: [id, zeroHash] });
    const failed = await c.write(safe, "execute", [c.raffle.address, wrongDigest], c.stranger); await c.mine();
    await expect(c.service.confirmOwnerExecution({ intent: revoke.intent, hash: failed.transactionHash, timeoutMs: 2000 })).rejects.toThrow(/no matching/);
    const revoked = await c.write(safe, "execute", [revoke.intent.to, revoke.intent.data], c.stranger); await c.mine();
    expect(await c.service.confirmOwnerExecution({ intent: revoke.intent, hash: revoked.transactionHash, timeoutMs: 2000 })).toMatchObject({ kind: "executed", state: "revoked" });
  }, 30000);
});
