import { createRaffleService } from "../lib/chain/service";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, keccak256, zeroHash } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import type { WorkflowAction } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
const attestations = { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } as const;

run("independent admission execution verification", () => {
  let chain: LocalChain;

  beforeAll(async () => { chain = await localChain(); }, 30_000);
  afterAll(() => chain?.close());

  async function draft() {
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await chain.write(chain.nft, "mint", [chain.seller, id]);
    const now = (await chain.client.getBlock()).timestamp;
    const nonce = keccak256("0x1234");
    const commitment = await chain.client.readContract({
      address: chain.raffle.address,
      abi: raffleAbi,
      functionName: "hashCommitment",
      args: [nonce, chain.nft.address, id, nonce, nonce, nonce]
    });
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      id,
      now + 86_400n,
      nonce,
      commitment,
      "Independent admission",
      [{ name: "Entry", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 100 }]
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, id], chain.seller);
    await chain.write(chain.raffle, "escrow", [id], chain.seller);
    return id;
  }

  it("treats a completed Safe approval as stale after an owner away-and-back cycle", async () => {
    const safe = await chain.deploy("Mocks.sol", "OwnerExecutorFixture");
    await chain.write(chain.raffle, "transferOwnership", [safe.address]);
    await chain.write(safe, "execute", [
      chain.raffle.address,
      encodeFunctionData({ abi: raffleAbi, functionName: "acceptOwnership" })
    ], chain.stranger);

    chain.service = createRaffleService(chain.client, { ...chain.manifest, expectedOwner: safe.address });
    const id = await draft();
    const wallet = chain.wallet(safe.address).session;
    await wallet.connect();
    const review = await chain.service.readAdmission({ id });
    const expectedReviewHash = review.snapshot.admission.reviewHash;
    if (expectedReviewHash === null) throw new Error("Draft review hash missing.");
    const action = { kind: "approveRaffle", id, expectedReviewHash, attestations } satisfies WorkflowAction;
    const prepared = await chain.service.prepare({ action, wallet });
    const intent = await chain.service.exportOwnerExecution({ prepared, wallet });
    const approval = await chain.write(safe, "execute", [intent.to, intent.data], chain.stranger);

    await chain.write(safe, "execute", [
      chain.raffle.address,
      encodeFunctionData({ abi: raffleAbi, functionName: "transferOwnership", args: [chain.operator] })
    ], chain.stranger);
    await chain.write(chain.raffle, "acceptOwnership");
    await chain.write(chain.raffle, "transferOwnership", [safe.address]);
    await chain.write(safe, "execute", [
      chain.raffle.address,
      encodeFunctionData({ abi: raffleAbi, functionName: "acceptOwnership" })
    ], chain.stranger);

    const transaction = await chain.client.getTransaction({ hash: approval.transactionHash });
    expect(transaction.from.toLowerCase()).toBe(chain.stranger.toLowerCase());
    expect(transaction.to?.toLowerCase()).toBe(safe.address.toLowerCase());
    await expect(chain.service.confirmOwnerExecution({ intent, hash: approval.transactionHash, timeoutMs: 2_000 }))
      .resolves.toMatchObject({ kind: "executed", state: "stale" });

    await chain.write(safe, "execute", [
      chain.raffle.address,
      encodeFunctionData({ abi: raffleAbi, functionName: "transferOwnership", args: [chain.operator] })
    ], chain.stranger);
    await chain.write(chain.raffle, "acceptOwnership");
  });

  it("rejects a matching approval log when the receipt attributes it to another contract", async () => {
    const id = await draft();
    chain.service = createRaffleService(chain.client, chain.manifest);
    const wallet = chain.wallet(chain.operator).session;
    await wallet.connect();
    const review = await chain.service.readAdmission({ id });
    const expectedReviewHash = review.snapshot.admission.reviewHash;
    if (expectedReviewHash === null) throw new Error("Draft review hash missing.");
    const action = { kind: "approveRaffle", id, expectedReviewHash, attestations } satisfies WorkflowAction;
    const prepared = await chain.service.prepare({ action, wallet });
    const intent = await chain.service.exportOwnerExecution({ prepared, wallet });
    const receipt = await chain.write(chain.raffle, "approveRaffle", [id, expectedReviewHash]);
    await chain.mine();

    const wrongAddressReceipt = {
      ...receipt,
      logs: receipt.logs.map(log => ({ ...log, address: chain.nft.address }))
    };
    const wait = vi.spyOn(chain.client, "waitForTransactionReceipt").mockResolvedValue(wrongAddressReceipt);
    try {
      await expect(chain.service.confirmOwnerExecution({ intent, hash: receipt.transactionHash, timeoutMs: 2_000 }))
        .rejects.toThrow(/no matching raffle approval event/i);
    } finally {
      wait.mockRestore();
    }
  });

  it("rejects an owner read when its pinned block hash changes", async () => {
    const pinned = await chain.service.readOwner();
    const original = chain.client.getBlock.bind(chain.client);
    const getBlock = vi.spyOn(chain.client, "getBlock").mockImplementation(async args => {
      const block = await original(args);
      return args?.blockNumber === pinned.block.number ? { ...block, hash: zeroHash } : block;
    });
    try {
      await expect(chain.service.readOwner({ block: pinned.block })).rejects.toThrow(/Chain state changed/);
    } finally {
      getBlock.mockRestore();
    }
  });
});
