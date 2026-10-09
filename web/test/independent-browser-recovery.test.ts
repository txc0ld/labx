import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { createReserve } from "../lib/reserve";
import { MemoryStore } from "../lib/store";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { WorkflowAction } from "../lib/chain/types";
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
    const act = async (action: WorkflowAction, wallet: WalletSessionPort) => {
      const prepared = await service.prepare({ action, wallet });
      const transaction = await service.submit({ prepared, wallet });
      await chain.mine();
      await chain.mine();
      expect(await service.confirm({ transaction, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
    };
    await chain.write(chain.raffle, "createRaffle", [chain.nft.address, 401n, latest.timestamp + 900n, commitment.nonce, commitment.commit, "Sold-out pending recovery", [{ name: "Last membership", priceUsdc: 20_000_000n, bonusEntries: 3, maxSupply: 1 }]], chain.seller);
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
    expect(id).toBe(1n);
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    await chain.admit(id);
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

    const agreements = fixture.page.locator(".agreements input[type=checkbox]");
    await expect.poll(async () => {
      for (const checkbox of await agreements.all()) if (!await checkbox.isChecked()) await checkbox.check();
      return (await Promise.all((await agreements.all()).map(checkbox => checkbox.isChecked()))).filter(Boolean).length;
    }, { timeout: 10_000 }).toBe(3);
    await fixture.page.getByRole("button", { name: "Sign and record agreement", exact: true }).click();
    const purchase = fixture.page.getByRole("button", { name: "Purchase membership", exact: true });
    await purchase.waitFor({ state: "visible", timeout: 10_000 });
    await purchase.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });
    await review.getByRole("button", { name: "Confirm purchase membership", exact: true }).click();
    const submitted = fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: "Transaction submitted" });
    await submitted.waitFor({ state: "visible", timeout: 10_000 });
    const submittedText = await submitted.innerText();
    const transactionHash = submittedText.match(/0x[0-9a-fA-F]{64}/)?.[0];
    if (!transactionHash) throw new Error(`Submitted purchase did not render its transaction hash: ${submittedText}`);

    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => fixture.page.getByRole("radiogroup", { name: "Membership packs" }).locator("label").first().getAttribute("data-disabled"), { timeout: 10_000 }).toBe("true");
    expect(await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).count()).toBe(0);
    const recovery = fixture.page.locator(".resume-transaction");
    await recovery.waitFor({ state: "visible", timeout: 10_000 });
    expect(await recovery.getByRole("heading", { name: "Pending wallet activity", exact: true }).isVisible()).toBe(true);
    expect(await recovery.getByLabel("Transaction hash").inputValue()).toBe(transactionHash);

    await chain.mine();
    await chain.mine();
    await recovery.getByRole("button", { name: "Check transaction", exact: true }).click();
    await recovery.getByText(/^Confirmed in block \d+\.$/).waitFor({ state: "visible", timeout: 10_000 });
    expect(await recovery.locator(".transaction-outcome .hash", { hasText: transactionHash }).innerText()).toBe(transactionHash);
    await expect.poll(async () => recovery.locator("form").count(), { timeout: 10_000 }).toBe(0);
    await expect.poll(async () => fixture.page.getByRole("button", { name: "Refresh state", exact: true }).isDisabled(), { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => fixture.page.getByRole("radiogroup", { name: "Membership packs" }).count(), { timeout: 10_000 }).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).count()).toBe(0);
    await expect.poll(async () => service.pending({ wallet: buyer }), { timeout: 10_000 }).toBeNull();
    const purchaseReceipt = fixture.page.locator(".buyer-flow .transaction-state", { hasText: "Purchase confirmed" });
    await purchaseReceipt.getByText(transactionHash, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(async () => purchaseReceipt.getByRole("button", { name: "Acknowledge purchase receipt", exact: true }).isEnabled(), { timeout: 10_000 }).toBe(true);
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    const reloadedReceipt = fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: transactionHash });
    await reloadedReceipt.getByText(/^Confirmed in block \d+\.$/).waitFor({ state: "visible", timeout: 10_000 });
    expect(await reloadedReceipt.locator(".hash").innerText()).toBe(transactionHash);
    expect(await fixture.page.locator(".resume-transaction form").count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).count()).toBe(0);
    expect(await service.readAccount({ id: 1n, account: chain.buyer })).toMatchObject({ principal: 20_000_000n, fee: 2_500_000n });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }, 90_000);
});
