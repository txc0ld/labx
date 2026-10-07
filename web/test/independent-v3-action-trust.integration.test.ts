import { describe, expect, it, vi } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { createRaffleService } from "../lib/chain/service";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { WorkflowAction } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
const attestations = { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } as const;

run("independent v3 action-aware trust boundaries", () => {
  async function reviewedService(chain: LocalChain) {
    const opening = await chain.service.openingPolicy();
    const reviewedManifest = {
      ...chain.manifest,
      expectedOwner: chain.operator,
      expectedPolicy: opening.policy
    };
    return {
      expectedPolicy: opening.policy,
      service: createRaffleService(chain.client, reviewedManifest)
    };
  }

  async function createEscrowedDraft(chain: LocalChain, title: string) {
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await chain.write(chain.nft, "mint", [chain.seller, id]);
    const now = (await chain.client.getBlock()).timestamp;
    const nonce = keccak256(`0x${id.toString(16).padStart(2, "0")}` as Hex);
    const commitment = await chain.client.readContract({
      address: chain.raffle.address,
      abi: raffleAbi,
      functionName: "hashCommitment",
      args: [nonce, chain.nft.address, id, nonce, nonce, nonce]
    });
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      id,
      now + 10n * 86_400n,
      nonce,
      commitment,
      title,
      [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 20 }]
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, id], chain.seller);
    await chain.write(chain.raffle, "escrow", [id], chain.seller);
    return { id, salesEnd: now + 10n * 86_400n };
  }

  async function approveAndOpen(chain: LocalChain, id: bigint, approver = chain.operator) {
    const digest = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "draftReviewHash", args: [id] });
    await chain.write(chain.raffle, "approveRaffle", [id, digest], approver);
    const policyHash = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "openingPolicyHash" });
    await chain.write(chain.raffle, "openWithPolicy", [id, policyHash], chain.seller);
  }

  async function connected(chain: LocalChain, account: Address) {
    const wallet = chain.wallet(account).session;
    await wallet.connect();
    return wallet;
  }

  async function execute(chain: LocalChain, service: RaffleService, wallet: WalletSessionPort, action: WorkflowAction) {
    const prepared = await service.prepare({ action, wallet });
    const submitted = await service.submit({ prepared, wallet });
    await chain.client.waitForTransactionReceipt({ hash: submitted.hash });
    await chain.mine();
    expect(await service.confirm({ transaction: submitted, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
    return submitted;
  }

  it("blocks a draft approval at final submit when a pending owner appears without requesting the wallet", async () => {
    const chain = await localChain();
    try {
      const { service } = await reviewedService(chain);
      const { id } = await createEscrowedDraft(chain, "Pending owner race");
      const wallet = await connected(chain, chain.operator);
      const review = await service.readAdmission({ id });
      const expectedReviewHash = review.snapshot.admission.reviewHash;
      if (expectedReviewHash === null) throw new Error("Fixture draft review hash missing.");
      const prepared = await service.prepare({
        action: { kind: "approveRaffle", id, expectedReviewHash, attestations },
        wallet
      });
      const walletRequest = vi.spyOn(wallet, "requestTransaction");
      await chain.write(chain.raffle, "transferOwnership", [chain.stranger]);

      const result = await service.submit({ prepared, wallet }).then(
        () => ({ kind: "submitted" as const }),
        error => ({ kind: "rejected" as const, error })
      );
      expect.soft(result).toMatchObject({ kind: "rejected", error: expect.objectContaining({ message: expect.stringMatching(/pending owner|authority|reviewed deployment/i) }) });
      expect(walletRequest).not.toHaveBeenCalled();
    } finally {
      chain.close();
    }
  }, 30_000);

  it("refuses to export an owner approval after a pending-owner race", async () => {
    const chain = await localChain();
    try {
      const { service } = await reviewedService(chain);
      const { id } = await createEscrowedDraft(chain, "Owner export race");
      const wallet = await connected(chain, chain.operator);
      const review = await service.readAdmission({ id });
      const expectedReviewHash = review.snapshot.admission.reviewHash;
      if (expectedReviewHash === null) throw new Error("Fixture draft review hash missing.");
      const prepared = await service.prepare({
        action: { kind: "approveRaffle", id, expectedReviewHash, attestations },
        wallet
      });
      await chain.write(chain.raffle, "transferOwnership", [chain.stranger]);

      await expect(service.exportOwnerExecution({ prepared, wallet })).rejects.toThrow(/pending owner|authority|reviewed deployment/i);
    } finally {
      chain.close();
    }
  }, 30_000);

  it("rejects a raffle opened under an unsafe policy even after global settings are restored", async () => {
    const chain = await localChain();
    try {
      const { service } = await reviewedService(chain);
      await chain.write(chain.raffle, "setTreasury", [chain.stranger]);
      const { id } = await createEscrowedDraft(chain, "Restored globals must not bless history");
      await approveAndOpen(chain, id);
      await chain.write(chain.raffle, "setTreasury", [chain.treasury]);

      await expect(service.quoteMembership({ id, packId: 0, quantity: 1 })).rejects.toThrow(/policy|reviewed deployment|treasury/i);
    } finally {
      chain.close();
    }
  }, 30_000);

  it("rejects admission by a different owner even after ownership returns to the expected Safe", async () => {
    const chain = await localChain();
    try {
      const { service } = await reviewedService(chain);
      await chain.write(chain.raffle, "transferOwnership", [chain.stranger]);
      await chain.write(chain.raffle, "acceptOwnership", [], chain.stranger);
      const { id } = await createEscrowedDraft(chain, "Wrong admission owner");
      await approveAndOpen(chain, id, chain.stranger);
      await chain.write(chain.raffle, "transferOwnership", [chain.operator], chain.stranger);
      await chain.write(chain.raffle, "acceptOwnership", [], chain.operator);

      await expect(service.quoteMembership({ id, packId: 0, quantity: 1 })).rejects.toThrow(/approved|owner|reviewed deployment/i);
    } finally {
      chain.close();
    }
  }, 30_000);

  it("keeps a correctly pinned purchase and liability recovery live through future global drift", async () => {
    const chain = await localChain();
    try {
      const { service } = await reviewedService(chain);
      const { id, salesEnd } = await createEscrowedDraft(chain, "Pinned policy remains usable");
      await approveAndOpen(chain, id);
      await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
      await chain.write(chain.raffle, "setTreasury", [chain.stranger]);
      await chain.write(chain.raffle, "proposeCoordinator", [chain.router.address]);

      const buyer = await connected(chain, chain.buyer);
      await execute(chain, service, buyer, { kind: "approveUsdc", id, packId: 0, quantity: 1 });
      await execute(chain, service, buyer, {
        kind: "buyMembership",
        id,
        packId: 0,
        quantity: 1,
        acceptedTerms: PUBLISHED_TERMS_HASH,
        agreements: { terms: true, rules: true, age: true },
        payment: { kind: "usdc" }
      });

      await chain.write(chain.raffle, "transferOwnership", [chain.stranger]);
      await expect(service.quoteMembership({ id, packId: 0, quantity: 1 })).rejects.toThrow(/pending owner|authority|reviewed deployment/i);
      await chain.warp(salesEnd + 7n * 86_400n);
      const outsider = await connected(chain, chain.stranger);
      await execute(chain, service, outsider, { kind: "cancel", id });
      await execute(chain, service, buyer, { kind: "refund", id });
      expect((await service.readAccount({ id, account: chain.buyer })).principal).toBe(0n);
    } finally {
      chain.close();
    }
  }, 45_000);
});
