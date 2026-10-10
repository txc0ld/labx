import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, parseUnits, erc721Abi } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { fillStandardMembershipEconomics } from "./fixtures/membership-tiers";
import { connectWallet } from "./fixtures/connect-wallet";
import { localDeadlineValue, openCreatePanel } from "./fixtures/seller-create";
import { watchWallet } from "./fixtures/wallet-watch";

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
          : fixture.page.getByRole("button", { name: /^(Approve [\d.,]+ USDC|Claim your NFT|Claim [\d.,]+ USDC refund)$/ }).or(fixture.page.locator("summary").filter({ hasText: "Other actions" })).first();
    await connectWallet(fixture.page, ready);
    await expect.poll(async () => fixture.page.evaluate(async () => {
      const provider = (window as unknown as Window & { ethereum: { request(input: { method: string }): Promise<unknown> } }).ethereum;
      return provider.request({ method: "eth_accounts" });
    }), { timeout: 5_000 }).toEqual([account]);
  }

  async function revealTrigger(label: string) {
    const trigger = fixture.page.getByRole("button", { name: label, exact: true }).first();
    const secondary = fixture.page.locator("summary").filter({ hasText: /^(Advanced \(|Other actions)/ });
    await expect.poll(async () => await trigger.isVisible().catch(() => false) || await secondary.isVisible().catch(() => false), { timeout: 10_000 }).toBe(true);
    if (!await trigger.isVisible().catch(() => false) && await secondary.isVisible().catch(() => false)) await secondary.click();
    return trigger;
  }

  async function settled(blockBeforeSubmit: bigint) {
    await expect.poll(async () => chain.client.getBlockNumber({ cacheTime: 0 }), { timeout: 15_000 }).toBeGreaterThan(blockBeforeSubmit);
    await fixture.page.waitForTimeout(250);
    await expect.poll(async () => {
      const reviews = await fixture.page.locator("section.transaction-review").count();
      const states = await fixture.page.locator(".transaction-state").allInnerTexts();
      return reviews === 0 && !states.some((text: string) => /Transaction submitted|Waiting for wallet|Checking confirmation|Confirming|Finishing your last step/i.test(text));
    }, { timeout: 15_000 }).toBe(true);
    const alerts = (await fixture.page.locator(".notice.error[role=alert], .transaction-state[role=alert]").allInnerTexts()).map((text: string) => text.trim()).filter(Boolean);
    expect(alerts).toEqual([]);
  }

  /** A buyer payment or public help step: the website review opens first, then the wallet. */
  async function transact(label: string, confirmName = `Confirm ${label.charAt(0).toLowerCase()}${label.slice(1)}`) {
    const trigger = await revealTrigger(label);
    await trigger.click();
    const confirm = fixture.page.getByRole("button", { name: confirmName, exact: true });
    await confirm.waitFor({ state: "visible", timeout: 15_000 });
    const review = confirm.locator("xpath=ancestor::section[contains(@class, 'transaction-review')]");
    await review.locator("summary", { hasText: "Transaction details" }).click();
    const reviewed = await review.innerText();
    const blockBeforeSubmit = await chain.client.getBlockNumber({ cacheTime: 0 });
    await review.getByRole("button", { name: confirmName, exact: true }).click();
    await settled(blockBeforeSubmit);
    return reviewed;
  }

  /** A seller step on the seller page: one click sends one exact call straight to the wallet, with no website review. */
  async function sendDirect(label: string, functionName: string, args: readonly unknown[]) {
    const trigger = await revealTrigger(label);
    const wallet = await watchWallet(fixture.page);
    const blockBeforeSubmit = await chain.client.getBlockNumber({ cacheTime: 0 });
    await trigger.click();
    await settled(blockBeforeSubmit);
    expect(await wallet.reviews()).toBe(0);
    const requests = await wallet.requests();
    expect(requests.map(request => request.method)).toEqual(["eth_sendTransaction"]);
    expect(requests[0].to).toBe(chain.raffle.address.toLowerCase());
    expect(decodeFunctionData({ abi: raffleAbi, data: requests[0].data as `0x${string}` })).toEqual({ functionName, args });
    return wallet;
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
    await fixture.page.getByRole("heading", { name: "Waiting for LABx review", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    const cancel = fixture.page.getByRole("button", { name: "Cancel draft", exact: true });
    expect(await cancel.isVisible()).toBe(false);
    const advanced = fixture.page.locator("summary").filter({ hasText: "Cancel draft" });
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
    await fixture.page.getByRole("button", { name: `Approve ${expectedTotal}`, exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const approval = await transact(`Approve ${expectedTotal}`, "Confirm approval");
    expect(approval).toContain(expectedTotal);
    expect(approval).toContain(chain.raffle.address);
    const agreements = fixture.page.locator(".agreements input[type=checkbox]");
    await agreements.first().waitFor({ state: "visible", timeout: 10_000 });
    for (const checkbox of await agreements.all()) await checkbox.check();
    await fixture.page.getByRole("button", { name: "Sign agreement", exact: true }).click();
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
    await purchase(id, "27.50 USDC");

    await chain.warp(BigInt(firstDeadline));
    await switchAccount(chain.seller);
    await goto(`/seller/${id.toString()}`, chain.seller);
    await sendDirect("Close sales", "close", [id]);
    await sendDirect("Count entries", "snapshot", [id, 100n]);
    await sendDirect("Start draw", "requestRandomness", [id]);
    await fixture.page.getByRole("heading", { name: "Drawing a winner", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.evaluate(() => {
      const scope = window as unknown as Window & { __pausedNoticeSeen: boolean };
      scope.__pausedNoticeSeen = false;
      new MutationObserver(() => { if (document.querySelector("#content")?.textContent?.includes("Actions are paused")) scope.__pausedNoticeSeen = true; })
        .observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const drawing = await chain.service.readRaffle({ id });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    // The waiting page re-reads the raffle by itself while visible, without a Refresh click or the paused-controls notice.
    const confirmDraw = fixture.page.getByRole("button", { name: "Confirm the draw", exact: true });
    await confirmDraw.waitFor({ state: "visible", timeout: 30_000 });
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __pausedNoticeSeen: boolean }).__pausedNoticeSeen)).toBe(false);
    // One click: the draw-setup signature, then the confirmation straight to the wallet.
    const drawWallet = await watchWallet(fixture.page);
    const beforeReveal = await chain.client.getBlockNumber({ cacheTime: 0 });
    await confirmDraw.click();
    await settled(beforeReveal);
    expect((await chain.service.readRaffle({ id })).raffle.revealed).toBe(true);
    expect(await drawWallet.reviews()).toBe(0);
    const drawRequests = await drawWallet.requests();
    expect(drawRequests.map(request => request.method)).toEqual(["personal_sign", "eth_sendTransaction"]);
    expect(drawRequests[1].to).toBe(chain.raffle.address.toLowerCase());
    const reveal = decodeFunctionData({ abi: raffleAbi, data: drawRequests[1].data as `0x${string}` });
    expect(reveal.functionName).toBe("reveal");
    expect(reveal.args?.[0]).toBe(id);
    await sendDirect("Finish raffle", "settle", [id]);

    await switchAccount(chain.buyer);
    await goto(`/piece/${id.toString()}`, chain.buyer);
    await transact("Claim your NFT");
    await switchAccount(chain.seller);
    await goto(`/seller/${id.toString()}`, chain.seller);
    await sendDirect("Claim 24.50 USDC", "claimProceeds", [id]);
    await switchAccount(chain.stranger);
    await goto(`/piece/${id.toString()}`, chain.stranger);
    await transact("Send LABx fees");

    expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [301n] })).toBe(chain.buyer);
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] })).toBe(sellerBefore + 24_500_000n);
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.treasury] })).toBe(treasuryBefore + 3_000_000n);
  }, 150_000);

  it("renders timed cancellation through exact buyer refund and seller NFT reclaim", async () => {
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await switchAccount(chain.seller);
    const id = await createDraft({ tokenId: 302n, title: "Rendered refund path", price: "40", supply: "2", deadline: secondDeadline });
    expect(id).toBe(2n);
    await escrowAndOpen(id);
    const buyerBefore = await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.buyer] });
    await purchase(id, "42.50 USDC");
    const snapshot = await chain.service.readRaffle({ id });
    await chain.write(chain.raffle, "setPaused", [true]);
    try {
      await chain.warp(snapshot.raffle.salesEnd + snapshot.drawStartGrace);
      await switchAccount(chain.seller);
      await goto(`/seller/${id.toString()}`, chain.seller);
      const refunds = await sendDirect("Enable refunds", "cancel", [id]);
      // Buyers need refunds first, so cancelling a raffle with sales never chains the NFT reclaim.
      await fixture.page.getByRole("button", { name: "Reclaim NFT", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      await fixture.page.waitForTimeout(1_000);
      expect((await refunds.requests()).length).toBe(1);
      expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [302n] })).toBe(chain.raffle.address);
      await switchAccount(chain.buyer);
      await goto(`/piece/${id.toString()}`, chain.buyer);
      await transact("Claim 40.00 USDC refund");
      await switchAccount(chain.seller);
      await goto(`/seller/${id.toString()}`, chain.seller);
      await sendDirect("Reclaim NFT", "reclaimPrize", [id]);
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
