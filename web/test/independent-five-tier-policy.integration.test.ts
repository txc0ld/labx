import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, keccak256, toBytes } from "viem";
import type { WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_FIVE_TIER_VERIFICATION === "1" || process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;

const CANONICAL_NAMES = ["Entry", "Bronze", "Silver", "Gold", "Platinum"] as const;

function packs(names: readonly string[]) {
  return names.map((name, index) => ({
    name,
    priceUsdc: BigInt(index + 1) * 1_000_000n,
    bonusEntries: index + 1,
    maxSupply: (index + 1) * 10
  }));
}

run("independent five-tier action boundary", () => {
  let chain: LocalChain;
  let seller: WalletSessionPort;
  let buyer: WalletSessionPort;
  let stranger: WalletSessionPort;

  beforeAll(async () => {
    chain = await localChain();
    seller = chain.wallet(chain.seller).session;
    buyer = chain.wallet(chain.buyer).session;
    stranger = chain.wallet(chain.stranger).session;
    await Promise.all([seller.connect(), buyer.connect(), stranger.connect()]);
  }, 30_000);

  afterAll(() => chain?.close());

  async function act(action: WorkflowAction) {
    const prepared = await chain.service.prepare({ action, wallet: seller });
    const transaction = await chain.service.submit({ prepared, wallet: seller });
    await chain.client.waitForTransactionReceipt({ hash: transaction.hash });
    await chain.mine();
    expect((await chain.service.confirm({ transaction, timeoutMs: 3_000 })).kind).toBe("confirmed");
  }

  async function mintAndDraft(tokenId: bigint, names: readonly string[], salesEnd: bigint) {
    const reserveNonce = keccak256(toBytes(`five-tier-nonce-${tokenId}`));
    const reserveCommit = keccak256(toBytes(`five-tier-commit-${tokenId}`));
    await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    const draft: DraftInput = {
      nft: chain.nft.address,
      tokenId,
      salesEnd,
      reserveNonce,
      reserveCommit,
      title: `Legacy ${names.length} pack draft`,
      packs: packs(names)
    };
    await chain.write(chain.raffle, "createRaffle", [
      draft.nft,
      draft.tokenId,
      draft.salesEnd,
      draft.reserveNonce,
      draft.reserveCommit,
      draft.title,
      draft.packs
    ], chain.seller);
    return { id, draft };
  }

  it("rejects noncanonical direct creates before any transaction and accepts the exact ordered five", async () => {
    const tokenId = 7_001n;
    await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    const block = await chain.client.getBlock();
    const base: DraftInput = {
      nft: chain.nft.address,
      tokenId,
      salesEnd: block.timestamp + 3_600n,
      reserveNonce: keccak256(toBytes("create-five-nonce")),
      reserveCommit: keccak256(toBytes("create-five-commit")),
      title: "Five tier boundary",
      packs: packs(CANONICAL_NAMES)
    };
    const invalid = [
      { label: "empty", value: [] },
      { label: "four", value: packs(CANONICAL_NAMES.slice(0, 4)) },
      { label: "six", value: packs([...CANONICAL_NAMES, "Diamond"]) },
      { label: "wrong order", value: packs(["Bronze", "Entry", "Silver", "Gold", "Platinum"]) },
      { label: "duplicate", value: packs(["Entry", "Bronze", "Silver", "Gold", "Gold"]) },
      { label: "custom", value: packs(["Entry", "Bronze", "Silver", "Gold", "VIP"]) },
      { label: "case changed", value: packs(["entry", "Bronze", "Silver", "Gold", "Platinum"]) },
      { label: "whitespace changed", value: packs(["Entry ", "Bronze", "Silver", "Gold", "Platinum"]) }
    ] as const;
    const nextIdBefore = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    const accepted: string[] = [];
    for (const candidate of invalid) {
      try {
        await chain.service.prepare({ action: { kind: "createDraft", draft: { ...base, packs: candidate.value } }, wallet: seller });
        accepted.push(candidate.label);
      } catch {}
    }
    expect(accepted).toEqual([]);
    expect(await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" })).toBe(nextIdBefore);
    await expect(chain.service.prepare({ action: { kind: "createDraft", draft: base }, wallet: seller })).resolves.toMatchObject({ action: { kind: "createDraft" } });
  }, 30_000);

  it("classifies canonical updates from a fresh saved snapshot and preserves seller authorization", async () => {
    const start = await chain.client.getBlock();
    const canonical = await mintAndDraft(7_002n, CANONICAL_NAMES, start.timestamp + 7_200n);
    const renamed = { ...canonical.draft, packs: packs(["Entry", "Bronze", "Silver", "Gold", "VIP"]) };
    await expect(chain.service.prepare({ action: { kind: "updateDraft", id: canonical.id, draft: renamed }, wallet: seller })).rejects.toThrow(/Entry|Bronze|Silver|Gold|Platinum|tier|membership/i);
    await expect(chain.service.prepare({ action: { kind: "updateDraft", id: canonical.id, draft: canonical.draft }, wallet: stranger })).rejects.toThrow(/Only the seller/);

    const legacy = await mintAndDraft(7_003n, ["eNTRY", "BASIC"], start.timestamp + 7_200n);
    const reviewed = await chain.service.prepare({ action: { kind: "updateDraft", id: legacy.id, draft: legacy.draft }, wallet: seller });
    await chain.write(chain.raffle, "updateDraft", [
      legacy.id,
      legacy.draft.nft,
      legacy.draft.tokenId,
      legacy.draft.salesEnd,
      legacy.draft.reserveNonce,
      legacy.draft.reserveCommit,
      legacy.draft.title,
      packs(CANONICAL_NAMES)
    ], chain.seller);
    await expect(chain.service.submit({ prepared: reviewed, wallet: seller })).rejects.toThrow(/Entry|Bronze|Silver|Gold|Platinum|tier|membership/i);
    expect((await chain.service.readRaffle({ id: legacy.id })).packs.map(pack => pack.name)).toEqual(CANONICAL_NAMES);
  }, 30_000);

  it("repairs expired one, two, and eight-pack legacy drafts without changing saved data", async () => {
    const start = await chain.client.getBlock();
    const fixtures = [
      await mintAndDraft(7_004n, ["Only"], start.timestamp + 120n),
      await mintAndDraft(7_005n, ["eNTRY", "BASIC"], start.timestamp + 120n),
      await mintAndDraft(7_006n, ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"], start.timestamp + 120n)
    ];
    await chain.warp(start.timestamp + 121n);
    const repairBlock = await chain.client.getBlock();
    for (const [index, fixture] of fixtures.entries()) {
      const before = await chain.service.readRaffle({ id: fixture.id });
      const salesEnd = repairBlock.timestamp + 3_600n + BigInt(index);
      await act({ kind: "updateDraft", id: fixture.id, draft: { ...fixture.draft, salesEnd } });
      const after = await chain.service.readRaffle({ id: fixture.id });
      expect(after.raffle).toMatchObject({
        nft: before.raffle.nft,
        tokenId: before.raffle.tokenId,
        title: before.raffle.title,
        reserveNonce: before.raffle.reserveNonce,
        reserveCommit: before.raffle.reserveCommit,
        salesEnd
      });
      expect(after.packs).toEqual(before.packs);
      expect(after.packs.map((pack, packIndex) => ({
        index: packIndex,
        name: pack.name,
        priceUsdc: pack.priceUsdc,
        bonusEntries: pack.bonusEntries,
        maxSupply: pack.maxSupply
      }))).toEqual(before.packs.map((pack, packIndex) => ({
        index: packIndex,
        name: pack.name,
        priceUsdc: pack.priceUsdc,
        bonusEntries: pack.bonusEntries,
        maxSupply: pack.maxSupply
      })));
    }
  }, 60_000);

  it("keeps legacy buyer pack index one attached to the saved second pack", async () => {
    const block = await chain.client.getBlock();
    const legacy = await mintAndDraft(7_007n, ["eNTRY", "BASIC"], block.timestamp + 3_600n);
    await chain.write(chain.nft, "approve", [chain.raffle.address, legacy.draft.tokenId], chain.seller);
    await chain.write(chain.raffle, "escrow", [legacy.id], chain.seller);
    await chain.admit(legacy.id);
    await chain.write(chain.raffle, "open", [legacy.id], chain.seller);
    const snapshot = await chain.service.readRaffle({ id: legacy.id });
    expect(snapshot.packs.map((pack, index) => ({ index, name: pack.name, priceUsdc: pack.priceUsdc }))).toEqual([
      { index: 0, name: "eNTRY", priceUsdc: 1_000_000n },
      { index: 1, name: "BASIC", priceUsdc: 2_000_000n }
    ]);
    const approval = await chain.service.prepare({ action: { kind: "approveUsdc", id: legacy.id, packId: 1, quantity: 1 }, wallet: buyer });
    expect(approval.amountUsdc).toBe(4_500_000n);
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.data })).toMatchObject({
      functionName: "approve",
      args: [chain.raffle.address, 4_500_000n]
    });
    await chain.write(chain.usdc, "mint", [chain.buyer, 10_000_000n]);
    const approvalTransaction = await chain.service.submit({ prepared: approval, wallet: buyer });
    await chain.client.waitForTransactionReceipt({ hash: approvalTransaction.hash });
    await chain.mine();
    const purchase = await chain.service.prepare({
      action: {
        kind: "buyMembership",
        id: legacy.id,
        packId: 1,
        quantity: 1,
        acceptedTerms: PUBLISHED_TERMS_HASH,
        agreements: { terms: true, rules: true, age: true },
        payment: { kind: "usdc" }
      },
      wallet: buyer
    });
    expect(decodeFunctionData({ abi: raffleAbi, data: purchase.data })).toMatchObject({
      functionName: "buyPack",
      args: [legacy.id, 1, 1, PUBLISHED_TERMS_HASH]
    });
  }, 30_000);

  it("keeps a contract-valid whitespace-only legacy name repairable", async () => {
    const block = await chain.client.getBlock();
    const legacy = await mintAndDraft(7_008n, [" "], block.timestamp + 120n);
    await chain.warp(block.timestamp + 121n);
    const repairBlock = await chain.client.getBlock();
    const prepared = await chain.service.prepare({
      action: { kind: "updateDraft", id: legacy.id, draft: { ...legacy.draft, salesEnd: repairBlock.timestamp + 3_600n } },
      wallet: seller
    });
    const decoded = decodeFunctionData({ abi: raffleAbi, data: prepared.data });
    expect(decoded.functionName).toBe("updateDraft");
    expect(decoded.args?.[7]).toMatchObject([{ name: " " }]);
  }, 30_000);
});
