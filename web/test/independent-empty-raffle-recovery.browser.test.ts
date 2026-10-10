import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc721Abi, keccak256, toBytes, type Address } from "viem";
import type { Locator } from "playwright";
import { raffleAbi } from "../lib/chain/abi";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";

describe.runIf(process.env.RUN_INDEPENDENT_EMPTY_RECOVERY_BROWSER === "1")("independent empty raffle recovery in a rendered browser", () => {
  let chain: LocalChain;
  let service: RaffleService;
  let seller: WalletSessionPort;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let pageErrors: string[];
  let consoleErrors: string[];
  let expiredId: bigint;
  let earlyId: bigint;
  let publicCancelId: bigint;

  async function act(action: WorkflowAction, wallet: WalletSessionPort) {
    const prepared = await service.prepare({ action, wallet });
    const submitted = await service.submit({ prepared, wallet });
    await chain.mine();
    await chain.mine();
    expect(await service.confirm({ transaction: submitted, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
  }

  async function createOpenRaffle(tokenId: bigint, title: string, salesEnd: bigint) {
    const reserve = keccak256(toBytes(`empty-recovery-${tokenId.toString()}`));
    const draft: DraftInput = {
      nft: chain.nft.address,
      tokenId,
      salesEnd,
      reserveNonce: reserve,
      reserveCommit: reserve,
      title,
      packs: standardMembershipPacks(() => ({ priceUsdc: 10_000_000n, bonusEntries: 1, maxSupply: 20 }))
    };
    await act({ kind: "createDraft", draft }, seller);
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    await chain.admit(id);
    const policy = await service.openingPolicy();
    await act({ kind: "open", id, expectedPolicyHash: policy.hash }, seller);
    expect((await service.readRaffle({ id })).raffle.phase).toBe(1);
    return id;
  }

  async function ownerOf(tokenId: bigint) {
    return chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [tokenId] });
  }

  /** Opens a raffle route as `account` and waits until the wallet is connected and its account state has loaded. */
  async function openAs(path: string, account: Address) {
    await fixture.switchAccount(account);
    const response = await fixture.page.goto(`${fixture.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.locator("#content").waitFor({ state: "visible" });
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    const piece = fixture.page.locator(".chain-piece");
    // Closed public pages and seller pages render the wallet gate only while disconnected, so a rendered raffle without it is a connected one.
    await expect.poll(async () => {
      if (await connect.isVisible().catch(() => false)) await connect.click().catch(() => {});
      return await piece.isVisible().catch(() => false) && await connect.count() === 0;
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => fixture.page.evaluate(async () => {
      const provider = (window as unknown as Window & { ethereum: { request(input: { method: string }): Promise<unknown> } }).ethereum;
      return provider.request({ method: "eth_accounts" });
    }), { timeout: 5_000 }).toEqual([account]);
    await fixture.page.waitForTimeout(300);
    await expect.poll(async () => fixture.page.getByText(/^Loading (your account state|seller controls)…$/).count(), { timeout: 10_000 }).toBe(0);
  }

  async function reviewRows(review: Locator) {
    return review.locator(".review-list > div").evaluateAll(rows => rows.map(row => [row.querySelector("dt")?.textContent ?? "", row.querySelector("dd")?.textContent ?? ""] as const));
  }

  /** Opens the review from `trigger` and returns the exact confirm button and its review rows. */
  async function openReview(trigger: Locator, confirmName: string) {
    await trigger.click();
    const confirm = fixture.page.getByRole("button", { name: confirmName, exact: true });
    await confirm.waitFor({ state: "visible", timeout: 15_000 });
    const review = confirm.locator("xpath=ancestor::section[contains(@class, 'transaction-review')]");
    return { confirm, rows: await reviewRows(review) };
  }

  async function confirmReview(confirm: Locator) {
    const before = await chain.client.getBlockNumber({ cacheTime: 0 });
    await confirm.click();
    await expect.poll(async () => chain.client.getBlockNumber({ cacheTime: 0 }), { timeout: 15_000 }).toBeGreaterThan(before);
    await expect.poll(async () => {
      const states = await fixture.page.locator(".transaction-state").allInnerTexts();
      return await confirm.count() === 0 && !states.some((text: string) => /Transaction submitted|Waiting for wallet|Checking confirmation/i.test(text));
    }, { timeout: 15_000 }).toBe(true);
    const alerts = (await fixture.page.locator(".notice.error[role=alert], .transaction-state[role=alert]").allInnerTexts()).map((text: string) => text.trim()).filter(Boolean);
    expect(alerts).toEqual([]);
  }

  function buttonCount(name: string) {
    return fixture.page.getByRole("button", { name, exact: true, includeHidden: true }).count();
  }

  async function statusPill() {
    return (await fixture.page.locator(".piece-status").textContent())?.trim();
  }

  async function drawProgressTerms() {
    return fixture.page.locator("section[aria-label='Draw details'] .review-list > div > dt").allTextContents();
  }

  function noOverflow() {
    return fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  }

  beforeAll(async () => {
    chain = await localChain();
    service = chain.service;
    seller = chain.wallet(chain.seller).session;
    await seller.connect();
    await chain.write(chain.nft, "mint", [chain.seller, 1001n]);
    await chain.write(chain.nft, "mint", [chain.seller, 1002n]);
    await chain.write(chain.nft, "mint", [chain.seller, 1003n]);
    const latest = await chain.client.getBlock();
    const shortDeadline = latest.timestamp + 3_600n;
    expiredId = await createOpenRaffle(1001n, "Empty expired raffle", shortDeadline);
    earlyId = await createOpenRaffle(1002n, "Empty early raffle", latest.timestamp + 30n * 86_400n);
    publicCancelId = await createOpenRaffle(1003n, "Empty public recovery raffle", shortDeadline);
    // Past the sales deadline but inside the seven-day draw-start grace, so only the seller or operator may cancel.
    await chain.warp(shortDeadline + 60n);
    fixture = await browserChain(chain, chain.stranger);
    pageErrors = [];
    consoleErrors = [];
    fixture.page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    fixture.page.on("console", (message: { type(): string; text(): string }) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    const response = await fixture.page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    expect(response?.status()).toBe(200);
  }, 150_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  it("shows an expired empty raffle as ended to a stranger without draw or cancel controls", async () => {
    await openAs(`/piece/${expiredId.toString()}`, chain.stranger);
    await fixture.page.getByRole("heading", { name: "Empty expired raffle", exact: true, level: 1 }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await statusPill()).toBe("Sales ended");
    await fixture.page.getByRole("heading", { name: "Sales have ended", exact: true, level: 2 }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByText("No memberships were sold.", { exact: true }).isVisible()).toBe(true);
    expect(await fixture.page.locator(".notice.error[role=alert]").allInnerTexts()).toEqual([]);
    // Hold the absence across several renders after account state loaded.
    for (let check = 0; check < 3; check += 1) {
      expect(await buttonCount("Close sales")).toBe(0);
      expect(await buttonCount("Count entries")).toBe(0);
      expect(await buttonCount("Cancel raffle")).toBe(0);
      expect(await fixture.page.locator("section.workflow-next button").count()).toBe(0);
      await fixture.page.waitForTimeout(400);
    }
    expect((await service.readRaffle({ id: expiredId })).raffle.phase).toBe(1);
    expect(pageErrors).toEqual([]);
  }, 60_000);

  it("offers the operator Cancel raffle on the expired empty raffle's public page", async () => {
    await openAs(`/piece/${expiredId.toString()}`, chain.operator);
    await fixture.page.getByRole("heading", { name: "Empty expired raffle", exact: true, level: 1 }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await statusPill()).toBe("Sales ended");
    const cancelNow = fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: "Cancel raffle", exact: true, level: 2 }) });
    await cancelNow.getByRole("heading", { name: "Cancel raffle", exact: true, level: 2 }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await cancelNow.getByText("No memberships were sold. Cancel the raffle so the seller can reclaim the NFT.", { exact: true }).isVisible()).toBe(true);
    expect(await cancelNow.getByRole("button", { name: "Cancel raffle", exact: true }).isVisible()).toBe(true);
    expect(await buttonCount("Cancel raffle")).toBe(1);
    expect(await buttonCount("Close sales")).toBe(0);
    expect(await buttonCount("Count entries")).toBe(0);
    expect((await service.readRaffle({ id: expiredId })).raffle.phase).toBe(1);
    expect(pageErrors).toEqual([]);
  }, 60_000);

  it("promotes Cancel raffle as the seller's only step and confirms it without amount or recipient rows", async () => {
    await openAs(`/seller/${expiredId.toString()}`, chain.seller);
    const primary = fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: "Cancel raffle", exact: true, level: 2 }) });
    await primary.waitFor({ state: "visible", timeout: 15_000 });
    expect(await primary.locator("p.kicker").count()).toBe(0);
    expect(await primary.getByText("No memberships were sold. Cancel the raffle, then reclaim your NFT.", { exact: true }).isVisible()).toBe(true);
    expect(await statusPill()).toBe("Sales ended");
    expect(await fixture.page.locator("summary").filter({ hasText: "Advanced (" }).count()).toBe(0);
    expect(await buttonCount("Sign to continue")).toBe(0);
    expect(await buttonCount("Close sales")).toBe(0);
    expect(await buttonCount("Count entries")).toBe(0);

    const { confirm, rows } = await openReview(primary.getByRole("button", { name: "Cancel raffle", exact: true }), "Confirm cancel raffle");
    expect(rows.map(([term]) => term)).toEqual(["Wallet", "Network", "Contract"]);
    expect(rows.find(([term]) => term === "Wallet")?.[1]).toBe(`${chain.seller.slice(0, 6)}…${chain.seller.slice(-4)}`);
    expect(rows.find(([term]) => term === "Contract")?.[1].toLowerCase()).toBe(chain.raffle.address.toLowerCase());
    await confirmReview(confirm);
    await expect.poll(async () => (await service.readRaffle({ id: expiredId })).raffle.phase, { timeout: 15_000 }).toBe(6);
    expect(await ownerOf(1001n)).toBe(chain.raffle.address);
    expect(pageErrors).toEqual([]);
  }, 90_000);

  it("then promotes Reclaim NFT to the seller with the seller as recipient and returns the NFT", async () => {
    const primary = fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: "Reclaim NFT", exact: true, level: 2 }) });
    await primary.waitFor({ state: "visible", timeout: 15_000 });
    expect(await primary.getByText("The raffle is cancelled. Reclaim your NFT.", { exact: true }).isVisible()).toBe(true);
    await expect.poll(statusPill, { timeout: 10_000 }).toBe("Cancelled");
    expect(await fixture.page.locator("summary").filter({ hasText: "Advanced (" }).count()).toBe(0);
    expect(await drawProgressTerms()).not.toContain("Entries counted");

    const { confirm, rows } = await openReview(primary.getByRole("button", { name: "Reclaim NFT", exact: true }), "Confirm reclaim NFT");
    expect(rows.map(([term]) => term)).toEqual(["Wallet", "Network", "Recipient"]);
    expect(rows.find(([term]) => term === "Recipient")?.[1].toLowerCase()).toBe(chain.seller.toLowerCase());
    await confirmReview(confirm);
    await expect.poll(async () => ownerOf(1001n), { timeout: 15_000 }).toBe(chain.seller);
    expect((await service.readRaffle({ id: expiredId })).raffle.escrowed).toBe(false);

    const waiting = fixture.page.locator("section.workflow-next[role=status]").filter({ has: fixture.page.getByRole("heading", { name: "Raffle cancelled", exact: true }) });
    await waiting.waitFor({ state: "visible", timeout: 15_000 });
    expect(await waiting.getByText("No memberships were sold.", { exact: true }).isVisible()).toBe(true);
    expect(await buttonCount("Reclaim NFT")).toBe(0);
    expect(await statusPill()).toBe("Cancelled");
    const terms = await drawProgressTerms();
    expect(terms).toContain("Sales end");
    expect(terms).not.toContain("Entries counted");
    expect(terms).not.toContain("Entries in the draw");
    expect(pageErrors).toEqual([]);
  }, 90_000);

  it("offers the operator Cancel raffle before the deadline on the public page and backs out of the review without sending", async () => {
    await openAs(`/piece/${earlyId.toString()}`, chain.operator);
    await fixture.page.getByRole("heading", { name: "Empty early raffle", exact: true, level: 1 }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await statusPill()).toBe("Open");
    const cancelNow = fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: "Cancel raffle", exact: true, level: 2 }) });
    await cancelNow.getByRole("heading", { name: "Cancel raffle", exact: true, level: 2 }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await cancelNow.getByText("No memberships have been sold. Cancelling ends sales now so the seller can reclaim the NFT.", { exact: true }).isVisible()).toBe(true);
    const trigger = cancelNow.getByRole("button", { name: "Cancel raffle", exact: true });
    expect(await buttonCount("Cancel raffle")).toBe(1);

    const before = await chain.client.getBlockNumber({ cacheTime: 0 });
    const { confirm, rows } = await openReview(trigger, "Confirm cancel raffle");
    expect(rows.map(([term]) => term)).toEqual(["Wallet", "Network", "Contract"]);
    expect(rows.find(([term]) => term === "Wallet")?.[1]).toBe(`${chain.operator.slice(0, 6)}…${chain.operator.slice(-4)}`);
    const review = confirm.locator("xpath=ancestor::section[contains(@class, 'transaction-review')]");
    await review.getByRole("button", { name: "Back", exact: true }).click();
    await expect.poll(async () => fixture.page.locator("section.transaction-review").count(), { timeout: 10_000 }).toBe(0);
    expect(await buttonCount("Confirm cancel raffle")).toBe(0);
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    expect(await buttonCount("Cancel raffle")).toBe(1);
    expect(await chain.client.getBlockNumber({ cacheTime: 0 })).toBe(before);
    expect((await service.readRaffle({ id: earlyId })).raffle.phase).toBe(1);
    expect(pageErrors).toEqual([]);
  }, 90_000);

  it("keeps Cancel raffle inside Advanced before the deadline and off the public page", async () => {
    await openAs(`/seller/${earlyId.toString()}`, chain.seller);
    const waiting = fixture.page.locator("section.workflow-next[role=status]").filter({ has: fixture.page.getByRole("heading", { name: "Your raffle is live", exact: true }) });
    await waiting.waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("heading", { name: "Cancel raffle", exact: true, level: 2 }).count()).toBe(0);
    const advanced = fixture.page.locator("details.workflow-details").filter({ has: fixture.page.locator("summary").filter({ hasText: "Advanced (" }) });
    expect(await advanced.count()).toBe(1);
    expect(await advanced.locator("summary").textContent()).toMatch(/^Advanced \(\d+\)$/);
    const cancel = advanced.getByRole("button", { name: "Cancel raffle", exact: true, includeHidden: true });
    expect(await cancel.count()).toBe(1);
    expect(await buttonCount("Cancel raffle")).toBe(1);
    expect(await cancel.isVisible()).toBe(false);
    await advanced.locator("summary").click();
    await cancel.waitFor({ state: "visible", timeout: 5_000 });
    expect(await statusPill()).toBe("Open");

    await openAs(`/piece/${earlyId.toString()}`, chain.seller);
    await fixture.page.getByText("Not enough USDC. You need 12.50 USDC.", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await statusPill()).toBe("Open");
    for (let check = 0; check < 3; check += 1) {
      expect(await buttonCount("Cancel raffle")).toBe(0);
      expect(await fixture.page.locator("section.workflow-next button").count()).toBe(0);
      await fixture.page.waitForTimeout(400);
    }
    expect((await service.readRaffle({ id: earlyId })).raffle.phase).toBe(1);
    expect(pageErrors).toEqual([]);
  }, 90_000);

  it("lets the seller cancel and reclaim from the public page at 390px without overflow or page errors", async () => {
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await openAs(`/piece/${publicCancelId.toString()}`, chain.seller);
    await fixture.page.getByRole("heading", { name: "Empty public recovery raffle", exact: true, level: 1 }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await statusPill()).toBe("Sales ended");
    const cancelNow = fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: "Cancel raffle", exact: true, level: 2 }) });
    await cancelNow.getByRole("heading", { name: "Cancel raffle", exact: true, level: 2 }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await cancelNow.getByText("No memberships were sold. Cancel the raffle, then reclaim your NFT.", { exact: true }).isVisible()).toBe(true);
    expect(await buttonCount("Close sales")).toBe(0);
    expect(await buttonCount("Count entries")).toBe(0);
    expect(await noOverflow()).toBe(true);

    const cancelled = await openReview(cancelNow.getByRole("button", { name: "Cancel raffle", exact: true }), "Confirm cancel raffle");
    expect(cancelled.rows.map(([term]) => term)).toEqual(["Wallet", "Network", "Contract"]);
    expect(await noOverflow()).toBe(true);
    await confirmReview(cancelled.confirm);
    await expect.poll(async () => (await service.readRaffle({ id: publicCancelId })).raffle.phase, { timeout: 15_000 }).toBe(6);

    const reclaimNow = fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: "Reclaim NFT", exact: true, level: 2 }) });
    await reclaimNow.getByRole("heading", { name: "Reclaim NFT", exact: true, level: 2 }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await reclaimNow.getByText("The raffle is cancelled. Reclaim your NFT.", { exact: true }).isVisible()).toBe(true);
    await expect.poll(statusPill, { timeout: 10_000 }).toBe("Cancelled");
    expect(await drawProgressTerms()).not.toContain("Entries counted");
    expect(await noOverflow()).toBe(true);

    const reclaimed = await openReview(reclaimNow.getByRole("button", { name: "Reclaim NFT", exact: true }), "Confirm reclaim NFT");
    expect(reclaimed.rows.map(([term]) => term)).toEqual(["Wallet", "Network", "Recipient"]);
    expect(reclaimed.rows.find(([term]) => term === "Recipient")?.[1].toLowerCase()).toBe(chain.seller.toLowerCase());
    expect(await noOverflow()).toBe(true);
    await confirmReview(reclaimed.confirm);
    await expect.poll(async () => ownerOf(1003n), { timeout: 15_000 }).toBe(chain.seller);
    await expect.poll(async () => buttonCount("Reclaim NFT"), { timeout: 15_000 }).toBe(0);

    expect(await noOverflow()).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }, 90_000);
});
