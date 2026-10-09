import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toBytes } from "viem";
import { SubmissionNotDispatchedError } from "../lib/chain/submission-errors";
import type { DraftInput } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;

run("independent three-action service boundaries", () => {
  let chain: LocalChain;
  let checkpoint: unknown;

  beforeAll(async () => {
    chain = await localChain();
    await chain.write(chain.nft, "mint", [chain.seller, 9_001n]);
    await chain.write(chain.nft, "mint", [chain.seller, 9_002n]);
  }, 60_000);
  beforeEach(async () => { checkpoint = await chain.rpc("evm_snapshot"); });
  afterEach(async () => { vi.restoreAllMocks(); await chain.rpc("evm_revert", [checkpoint]); });
  afterAll(() => chain?.close());

  async function draft(tokenId = 9_001n, suffix = "original"): Promise<DraftInput> {
    return {
      nft: chain.nft.address,
      tokenId,
      salesEnd: (await chain.client.getBlock()).timestamp + 86_400n,
      reserveNonce: keccak256(toBytes(`independent-nonce-${suffix}`)),
      reserveCommit: keccak256(toBytes(`independent-commit-${suffix}`)),
      title: `Independent exact draft ${suffix}`,
      packs: standardMembershipPacks((_tier, index) => ({ priceUsdc: 25_000_000n + BigInt(index), bonusEntries: index + 1, maxSupply: 20 }))
    };
  }

  async function sendCreate(input: DraftInput) {
    const wallet = chain.wallet(chain.seller).session;
    await wallet.connect();
    const prepared = await chain.service.prepare({ action: { kind: "createDraft", draft: input }, wallet });
    const submitted = await chain.service.submit({ prepared, wallet });
    await chain.client.waitForTransactionReceipt({ hash: submitted.hash });
    await chain.mine();
    const confirmed = await chain.service.confirm({ transaction: submitted, timeoutMs: 3_000 });
    if (confirmed.kind !== "confirmed") throw new Error("Fixture create was not confirmed.");
    return { wallet, receipt: confirmed.receipt };
  }

  it("rejects a coherent different receipt returned for the verified creation hash", async () => {
    const captured = await draft();
    const original = await sendCreate(captured);
    const alternateHash = await chain.write(chain.raffle, "createRaffle", [
      captured.nft,
      captured.tokenId,
      captured.salesEnd,
      captured.reserveNonce,
      captured.reserveCommit,
      captured.title,
      captured.packs
    ], chain.seller);
    await chain.mine();
    const alternateReceipt = await chain.client.getTransactionReceipt({ hash: alternateHash.transactionHash });
    const getReceipt = chain.client.getTransactionReceipt.bind(chain.client);
    vi.spyOn(chain.client, "getTransactionReceipt").mockImplementation(async input =>
      input.hash.toLowerCase() === original.receipt.hash.toLowerCase() ? alternateReceipt : getReceipt(input));

    await expect(chain.service.resolveCreatedDraft({ receipt: original.receipt, draft: captured }))
      .rejects.toThrow(/receipt differs|transaction changed/i);
  });

  it.each(["approvePrize", "escrow"] as const)("blocks %s when the canonical draft changes after preparation and before dispatch", async kind => {
    const captured = await draft();
    await chain.write(chain.raffle, "createRaffle", [captured.nft, captured.tokenId, captured.salesEnd, captured.reserveNonce, captured.reserveCommit, captured.title, captured.packs], chain.seller);
    if (kind === "escrow") {
      await chain.write(chain.nft, "approve", [chain.raffle.address, 9_001n], chain.seller);
      await chain.write(chain.nft, "approve", [chain.raffle.address, 9_002n], chain.seller);
    }
    const wallet = chain.wallet(chain.seller).session;
    await wallet.connect();
    const prepared = await chain.service.prepare({ action: { kind, id: 1n }, wallet, expectedDraft: captured });
    const changed = await draft(9_002n, `${kind}-changed`);
    await chain.write(chain.raffle, "updateDraft", [1n, changed.nft, changed.tokenId, changed.salesEnd, changed.reserveNonce, changed.reserveCommit, changed.title, changed.packs], chain.seller);
    const request = vi.spyOn(wallet, "requestTransaction");

    await expect(chain.service.submit({ prepared, wallet })).rejects.toBeInstanceOf(SubmissionNotDispatchedError);
    expect(request).not.toHaveBeenCalled();
  });

  it("proves an actual pre-provider service failure is retryable and invokes the wallet only on retry", async () => {
    const captured = await draft();
    const wallet = chain.wallet(chain.seller).session;
    await wallet.connect();
    const prepared = await chain.service.prepare({ action: { kind: "createDraft", draft: captured }, wallet });
    const request = vi.spyOn(wallet, "requestTransaction");
    const getCode = chain.client.getCode.bind(chain.client);
    vi.spyOn(chain.client, "getCode").mockRejectedValueOnce(new Error("independent pre-provider RPC failure")).mockImplementation(getCode);

    await expect(chain.service.submit({ prepared, wallet })).rejects.toBeInstanceOf(SubmissionNotDispatchedError);
    expect(request).not.toHaveBeenCalled();

    const submitted = await chain.service.submit({ prepared, wallet });
    expect(request).toHaveBeenCalledTimes(1);
    expect(submitted.hash).toMatch(/^0x[0-9a-f]{64}$/i);
  });
});
