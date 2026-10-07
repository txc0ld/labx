import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { createReserve } from "../lib/reserve";
import { MemoryStore } from "../lib/store";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_BROWSER_ACCEPTANCE === "1" ? describe : describe.skip;

run("independent rendered pending recovery on isolated Anvil", () => {
  let chain: LocalChain;
  let seller: WalletSessionPort;
  let buyer: WalletSessionPort;
  let service: RaffleService;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  beforeAll(async () => {
    chain = await localChain();
    service = chain.service;
    seller = chain.wallet(chain.seller).session;
    buyer = chain.wallet(chain.buyer).session;
    await Promise.all([seller.connect(), buyer.connect()]);
    await chain.write(chain.nft, "mint", [chain.seller, 401n]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);

    const commitment = await createReserve(new MemoryStore(), {
      seller: chain.seller,
      nft: chain.nft.address,
      tokenId: "401",
      publicSummary: "Pending recovery prize",
      privateCommitment: "Independent pending recovery record",
      chainId: 31337n,
      labx: chain.raffle.address
    });
    const latest = await chain.client.getBlock();
    const draft: DraftInput = {
      nft: chain.nft.address,
      tokenId: 401n,
      salesEnd: latest.timestamp + 900n,
      reserveNonce: commitment.nonce,
      reserveCommit: commitment.commit,
      title: "Sold-out pending recovery",
      packs: [{ name: "Last membership", priceUsdc: 20_000_000n, bonusEntries: 3, maxSupply: 1 }]
    };
    const act = async (action: WorkflowAction, wallet: WalletSessionPort) => {
      const prepared = await service.prepare({ action, wallet });
      const transaction = await service.submit({ prepared, wallet });
      await chain.mine();
      expect(await service.confirm({ transaction, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
    };
    await act({ kind: "createDraft", draft }, seller);
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
    expect(id).toBe(1n);
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    const policy = await service.openingPolicy();
    await act({ kind: "open", id, expectedPolicyHash: policy.hash }, seller);
    await act({ kind: "approveUsdc", id, packId: 0, quantity: 1 }, buyer);

    fixture = await browserChain(chain, chain.buyer, false);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  it("keeps the known-hash recovery control available after the last membership sells out and clears it only after confirmation", async () => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    fixture.page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    fixture.page.on("console", (message: { type(): string; text(): string }) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    const response = await fixture.page.goto(`${fixture.baseUrl}/piece/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible()) await connect.click();
    await expect.poll(async () => fixture.page.locator(".wallet-identity").innerText(), { timeout: 10_000 })
      .toContain(`${chain.buyer.slice(0, 6)}…${chain.buyer.slice(-4)}`);

    for (const checkbox of await fixture.page.locator(".agreements input[type=checkbox]").all()) await checkbox.check();
    await fixture.page.getByRole("button", { name: "Sign and record agreement", exact: true }).click();
    const purchase = fixture.page.getByRole("button", { name: "Purchase membership", exact: true });
    await purchase.waitFor({ state: "visible", timeout: 10_000 });
    await purchase.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });
    await review.getByRole("button", { name: "Confirm purchase membership", exact: true }).click();
    const submitted = fixture.page.locator(".transaction-state", { hasText: "Transaction submitted" });
    await submitted.waitFor({ state: "visible", timeout: 10_000 });
    const submittedText = await submitted.innerText();
    const transactionHash = submittedText.match(/0x[0-9a-fA-F]{64}/)?.[0];
    expect(transactionHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => fixture.page.locator(".chain-pack").first().getAttribute("data-disabled"), { timeout: 10_000 }).toBe("true");
    expect(await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).count()).toBe(0);
    const recovery = fixture.page.locator(".resume-transaction");
    await recovery.waitFor({ state: "visible", timeout: 10_000 });
    expect(await recovery.getByRole("heading", { name: "Pending wallet activity", exact: true }).isVisible()).toBe(true);
    expect(await recovery.getByLabel("Transaction hash").inputValue()).toBe(transactionHash);

    await chain.mine();
    await recovery.getByRole("button", { name: "Check transaction", exact: true }).click();
    await expect.poll(async () => fixture.page.locator(".resume-transaction").count(), { timeout: 10_000 }).toBe(0);
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => fixture.page.locator(".resume-transaction").count(), { timeout: 10_000 }).toBe(0);
    expect(await service.readAccount({ id: 1n, account: chain.buyer })).toMatchObject({ principal: 20_000_000n, fee: 400_000n });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }, 90_000);
});
