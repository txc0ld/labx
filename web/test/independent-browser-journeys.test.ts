import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, parseUnits, erc721Abi } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { fillStandardMembershipEconomics } from "./fixtures/membership-tiers";
import { connectWallet } from "./fixtures/connect-wallet";
import { localDeadlineValue, openCreatePanel } from "./fixtures/seller-create";

const run = process.env.RUN_BROWSER_ACCEPTANCE === "1" ? describe : describe.skip;

run("independent rendered wallet journeys on isolated Anvil", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let pageErrors: string[];
  let consoleErrors: string[];
  const firstDeadline = Math.floor((Date.now() + 12 * 60_000) / 60_000) * 60;
  const secondDeadline = firstDeadline + 10 * 60;

  beforeAll(async () => {
    chain = await localChain();
    await chain.write(chain.nft, "mint", [chain.seller, 301n]);
    await chain.write(chain.nft, "mint", [chain.seller, 302n]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 1_000_000_000n]);
    fixture = await browserChain(chain);
    pageErrors = [];
    consoleErrors = [];
    fixture.page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    fixture.page.on("console", (message: { type(): string; text(): string }) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  function short(account: string) {
    return `${account.slice(0, 6)}…${account.slice(-4)}`;
  }

  async function ensureConnected(account: string) {
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    await expect.poll(async () => {
      if (await connect.isVisible().catch(() => false)) await connect.click();
      return (await fixture.page.locator(".wallet-identity").allInnerTexts()).join(" ");
    }, {
      timeout: 10_000
    }).toContain(short(account));
  }

  async function switchAccount(account: typeof chain.seller) {
    await fixture.switchAccount(account);
    await expect.poll(async () => fixture.page.evaluate(async () => {
      const provider = (window as unknown as Window & { ethereum: { request(input: { method: string }): Promise<unknown> } }).ethereum;
      return provider.request({ method: "eth_accounts" });
    }), { timeout: 5_000 }).toEqual([account]);
    await fixture.page.waitForTimeout(250);
  }

  async function goto(path: string, account: typeof chain.seller) {
    const response = await fixture.page.goto(`${fixture.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.locator("#content").waitFor({ state: "visible" });
    const ready = path === "/seller"
      ? fixture.page.locator("summary").filter({ hasText: /Create a raffle|Prepare a draft/ })
      : path.startsWith("/review/")
        ? fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true })
        : path.startsWith("/seller/")
          ? fixture.page.locator("details.workflow-details > summary").first()
          : fixture.page.getByRole("button", { name: /^(Approve exact USDC|Claim NFT|Claim refund|Send protocol fees)$/ }).first();
    await connectWallet(fixture.page, ready);
    await expect.poll(async () => fixture.page.evaluate(async () => {
      const provider = (window as unknown as Window & { ethereum: { request(input: { method: string }): Promise<unknown> } }).ethereum;
      return provider.request({ method: "eth_accounts" });
    }), { timeout: 5_000 }).toEqual([account]);
  }

  async function refreshState() {
    await fixture.page.getByRole("button", { name: "Refresh state", exact: true }).click();
    await fixture.page.locator(".chain-piece").waitFor({ state: "visible", timeout: 10_000 });
  }

  async function transact(label: string, confirmName = `Confirm ${label.charAt(0).toLowerCase()}${label.slice(1)}`) {
    const trigger = fixture.page.getByRole("button", { name: label, exact: true }).first();
    const secondary = fixture.page.locator("summary").filter({ hasText: "Advanced (" });
    await expect.poll(async () => await trigger.isVisible().catch(() => false) || await secondary.isVisible().catch(() => false), { timeout: 10_000 }).toBe(true);
    if (!await trigger.isVisible().catch(() => false) && await secondary.isVisible().catch(() => false)) await secondary.click();
    await trigger.click();
    const confirm = fixture.page.getByRole("button", { name: confirmName, exact: true });
    await confirm.waitFor({ state: "visible", timeout: 15_000 });
    const review = confirm.locator("xpath=ancestor::section[contains(@class, 'transaction-review')]");
    await review.locator("summary", { hasText: "Transaction details" }).click();
    const reviewed = await review.innerText();
    const blockBeforeSubmit = await chain.client.getBlockNumber({ cacheTime: 0 });
    await review.getByRole("button", { name: confirmName, exact: true }).click();
    await expect.poll(async () => chain.client.getBlockNumber({ cacheTime: 0 }), { timeout: 15_000 }).toBeGreaterThan(blockBeforeSubmit);
    await fixture.page.waitForTimeout(250);
    await expect.poll(async () => {
      const reviews = await confirm.count();
      const states = await fixture.page.locator(".transaction-state").allInnerTexts();
      return reviews === 0 && !states.some((text: string) => /Transaction submitted|Waiting for wallet|Checking confirmation|Confirming|Finishing your last step/i.test(text));
    }, { timeout: 15_000 }).toBe(true);
    const alerts = (await fixture.page.locator(".notice.error[role=alert], .transaction-state[role=alert]").allInnerTexts()).map((text: string) => text.trim()).filter(Boolean);
    expect(alerts).toEqual([]);
    return reviewed;
  }

  async function createDraft(input: { tokenId: bigint; title: string; price: string; supply: string; deadline: number }) {
    await goto("/seller", chain.seller);
    const draftSummary = fixture.page.locator("summary").filter({ hasText: /Create a raffle|Prepare a draft/ });
    await draftSummary.waitFor({ state: "visible", timeout: 10_000 });
    await openCreatePanel(fixture.page);
    await fixture.page.getByLabel("Raffle title").waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.getByLabel("Raffle title").fill(input.title);
    await fixture.page.getByLabel("NFT contract").fill(chain.nft.address);
    await fixture.page.getByLabel("Token ID").fill(input.tokenId.toString());
    await fixture.page.getByLabel("Sales deadline (your time)").fill(await localDeadlineValue(fixture.page, input.deadline));
    await fillStandardMembershipEconomics(fixture.page, () => ({ price: input.price, bonusEntries: "3", supply: input.supply }));
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    await fixture.page.getByRole("button", { name: "Create", exact: true }).click();
    await fixture.page.waitForURL(`**/seller/${id.toString()}`);
    await ensureConnected(chain.seller);
    const snapshot = await chain.service.readRaffle({ id });
    expect(snapshot.raffle.escrowed).toBe(true);
    expect(snapshot.raffle.tokenId).toBe(input.tokenId);
    return id;
  }

  async function approveDraftAsOwner(id: bigint) {
    await switchAccount(chain.operator);
    await goto(`/review/${id.toString()}`, chain.operator);
    await fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByRole("checkbox").count()).toBe(0);
    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Approval recorded", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  }

  async function escrowAndOpen(id: bigint) {
    await fixture.page.getByRole("heading", { name: "Awaiting LABx review", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    const cancel = fixture.page.getByRole("button", { name: "Cancel draft", exact: true });
    expect(await cancel.isVisible()).toBe(false);
    const advanced = fixture.page.locator("summary").filter({ hasText: "Advanced (" });
    await advanced.click();
    expect(await cancel.isVisible()).toBe(true);
    await advanced.click();
    expect(await fixture.page.getByRole("button", { name: "List", exact: true }).count()).toBe(0);
    await approveDraftAsOwner(id);
    await switchAccount(chain.seller);
    await goto(`/seller/${id.toString()}`, chain.seller);
    await fixture.page.getByRole("heading", { name: "List your raffle", exact: true, level: 2 }).waitFor({ state: "visible" });
    await fixture.page.locator("details.workflow-details > summary").filter({ hasText: "Listing details" }).click();
    await fixture.page.getByText(chain.manifest.expectedPolicy.termsHash, { exact: true }).waitFor({ state: "visible" });
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    await fixture.page.getByRole("button", { name: "List", exact: true }).click();
    await expect.poll(async () => (await chain.service.readRaffle({ id })).raffle.phase, { timeout: 15_000 }).toBe(1);
  }

  async function purchase(id: bigint, expectedTotal: string) {
    await switchAccount(chain.buyer);
    await goto(`/piece/${id.toString()}`, chain.buyer);
    await fixture.page.getByRole("button", { name: "Approve exact USDC", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const approval = await transact("Approve exact USDC", "Confirm approval");
    expect(approval).toContain(expectedTotal);
    expect(approval).toContain(chain.raffle.address);
    const agreements = fixture.page.locator(".agreements input[type=checkbox]");
    await agreements.first().waitFor({ state: "visible", timeout: 10_000 });
    for (const checkbox of await agreements.all()) await checkbox.check();
    await fixture.page.getByRole("button", { name: "Sign and record agreement", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const purchaseReview = await transact("Purchase membership", "Confirm purchase");
    expect(purchaseReview).toContain(expectedTotal);
    expect(purchaseReview).toContain(chain.raffle.address);
    const account = await chain.service.readAccount({ id, account: chain.buyer });
    expect(account.principal + account.fee).toBe(parseUnits(expectedTotal.replace(" USDC", ""), 6));
  }

  it("renders seller creation through buyer prize, seller proceeds and pinned fee claims", async () => {
    const sellerBefore = await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] });
    const treasuryBefore = await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.treasury] });
    const id = await createDraft({ tokenId: 301n, title: "Rendered winner path", price: "25", supply: "2", deadline: firstDeadline });
    expect(id).toBe(1n);
    await escrowAndOpen(id);
    await purchase(id, "27.5 USDC");

    await chain.warp(BigInt(firstDeadline));
    await switchAccount(chain.seller);
    await goto(`/seller/${id.toString()}`, chain.seller);
    await transact("Close sales");
    await transact("Freeze next entries");
    await transact("Start draw");
    const drawing = await chain.service.readRaffle({ id });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    await refreshState();
    await fixture.page.getByRole("button", { name: "Sign to recover commitment", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Reveal commitment", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await transact("Reveal commitment");
    await transact("Settle raffle");

    await switchAccount(chain.buyer);
    await goto(`/piece/${id.toString()}`, chain.buyer);
    await transact("Claim NFT");
    await switchAccount(chain.seller);
    await goto(`/seller/${id.toString()}`, chain.seller);
    await transact("Claim proceeds");
    await switchAccount(chain.stranger);
    await goto(`/piece/${id.toString()}`, chain.stranger);
    await transact("Send protocol fees");

    expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [301n] })).toBe(chain.buyer);
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] })).toBe(sellerBefore + 24_500_000n);
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.treasury] })).toBe(treasuryBefore + 3_000_000n);
  }, 120_000);

  it("renders timed cancellation through exact buyer refund and seller NFT reclaim", async () => {
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await switchAccount(chain.seller);
    const id = await createDraft({ tokenId: 302n, title: "Rendered refund path", price: "40", supply: "2", deadline: secondDeadline });
    expect(id).toBe(2n);
    await escrowAndOpen(id);
    const buyerBefore = await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.buyer] });
    await purchase(id, "42.5 USDC");
    const snapshot = await chain.service.readRaffle({ id });
    await chain.write(chain.raffle, "setPaused", [true]);
    try {
      await chain.warp(snapshot.raffle.salesEnd + snapshot.drawStartGrace);
      await switchAccount(chain.seller);
      await goto(`/seller/${id.toString()}`, chain.seller);
      await transact("Enable refunds");
      await switchAccount(chain.buyer);
      await goto(`/piece/${id.toString()}`, chain.buyer);
      await transact("Claim refund");
      await switchAccount(chain.seller);
      await goto(`/seller/${id.toString()}`, chain.seller);
      await transact("Reclaim NFT");
    } finally {
      await chain.write(chain.raffle, "setPaused", [false]);
    }
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.buyer] })).toBe(buyerBefore - 2_500_000n);
    expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [302n] })).toBe(chain.seller);
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }, 120_000);
});
