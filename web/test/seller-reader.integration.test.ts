import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { createRaffleService } from "../lib/chain/service";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";

describe("seller discovery and financial activity", () => {
  let chain: LocalChain;

  beforeAll(async () => {
    chain = await localChain();
    await chain.write(chain.nft, "mint", [chain.stranger, 701n]);
    await chain.write(chain.nft, "mint", [chain.seller, 702n]);
    await chain.write(chain.nft, "mint", [chain.seller, 703n]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 1_000_000_000n]);
    await Promise.all([
      chain.wallet(chain.stranger).session.connect(),
      chain.wallet(chain.seller).session.connect(),
      chain.wallet(chain.buyer).session.connect()
    ]);
  }, 30_000);

  afterAll(() => chain?.close());

  async function act(action: WorkflowAction, account = chain.seller) {
    const wallet = chain.wallet(account).session;
    await wallet.connect();
    const prepared = await chain.service.prepare({ action, wallet });
    const submitted = await chain.service.submit({ prepared, wallet });
    await chain.mine();
    await chain.mine();
    const confirmed = await chain.service.confirm({ transaction: submitted, timeoutMs: 3_000 });
    if (confirmed.kind !== "confirmed") throw new Error(`Fixture action did not confirm: ${confirmed.kind}`);
  }

  async function draft(tokenId: bigint, seller: typeof chain.seller) {
    const block = await chain.client.getBlock();
    const input: DraftInput = {
      nft: chain.nft.address,
      tokenId,
      salesEnd: block.timestamp + 86_400n,
      reserveNonce: keccak256(toBytes(`nonce-${tokenId}`)),
      reserveCommit: keccak256(toBytes(`commit-${tokenId}`)),
      title: `Seller fixture ${tokenId}`,
      packs: [{ name: "Member", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 20 }]
    };
    await act({ kind: "createDraft", draft: input }, seller);
  }

  it("finds a seller only after an empty first scanned page and preserves the pinned block", async () => {
    await draft(701n, chain.stranger);
    await draft(702n, chain.seller);

    const first = await chain.service.listSellerRaffles({ seller: chain.seller, limit: 1 });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBe(2n);
    const second = await chain.service.listSellerRaffles({ seller: chain.seller, cursor: first.nextCursor ?? undefined, limit: 1, block: first.block });
    expect(second.items.map(item => item.id)).toEqual([2n]);
    expect(second.block).toEqual(first.block);
  }, 30_000);

  it("includes purchases from every buyer and isolates the selected raffle", async () => {
    await act({ kind: "approvePrize", id: 2n });
    await act({ kind: "escrow", id: 2n });
    await act({ kind: "open", id: 2n, expectedPolicyHash: (await chain.service.openingPolicy()).hash });
    await act({ kind: "approveUsdc", id: 2n, packId: 0, quantity: 1 }, chain.buyer);
    await act({
      kind: "buyMembership",
      id: 2n,
      packId: 0,
      quantity: 1,
      acceptedTerms: (await chain.service.readRaffle({ id: 2n })).policy.termsHash,
      agreements: { terms: true, rules: true, age: true },
      payment: { kind: "usdc" }
    }, chain.buyer);
    await draft(703n, chain.seller);

    const activity = await chain.service.listRaffleActivity({ id: 2n });
    expect(activity.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: "PackPurchased", args: expect.objectContaining({ id: 2n, buyer: chain.buyer }) })
    ]));
    expect(activity.items.every(item => item.args.id === 2n)).toBe(true);
  }, 30_000);

  it("rejects invalid cursors and a replaced pinned block", async () => {
    const first = await chain.service.listRaffleActivity({ id: 2n });
    await expect(chain.service.listRaffleActivity({ id: 2n, cursor: chain.manifest.deploymentBlock - 1n })).rejects.toThrow(/range/);
    await expect(chain.service.listRaffleActivity({ id: 2n, cursor: first.block.number + 1n, block: first.block })).rejects.toThrow(/range/);
    await expect(chain.service.listRaffleActivity({
      id: 2n,
      block: { ...first.block, hash: keccak256(toBytes("replaced seller activity block")) }
    })).rejects.toThrow(/Chain state changed/);

    const unavailable = createRaffleService(chain.client, chain.manifest);
    await expect(unavailable.listSellerRaffles({ seller: chain.seller, limit: 0 })).rejects.toThrow(/range/);
  });
});
