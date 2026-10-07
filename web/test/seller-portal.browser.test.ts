import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import type { WalletSessionPort } from "../lib/chain/ports";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_SELLER_PORTAL_BROWSER === "1" ? describe : describe.skip;

run("rendered seller portal on isolated Anvil", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let buyerWallet: WalletSessionPort;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    for (let offset = 0; offset < 26; offset += 1) {
      const id = BigInt(offset + 1);
      const owner = offset === 0 ? chain.stranger : chain.seller;
      const tokenId = 800n + id;
      const commitment = keccak256(toBytes(`seller-portal-${id}`));
      await chain.write(chain.nft, "mint", [owner, tokenId]);
      await chain.write(chain.raffle, "createRaffle", [
        chain.nft.address,
        tokenId,
        block.timestamp + 86_400n,
        commitment,
        commitment,
        offset === 0 ? "Another seller raffle" : `Seller portfolio ${id}`,
        [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 2, maxSupply: 100 }]
      ], owner);
    }
    await chain.write(chain.nft, "approve", [chain.raffle.address, 802n], chain.seller);
    await chain.write(chain.raffle, "escrow", [2n], chain.seller);
    await chain.write(chain.raffle, "open", [2n], chain.seller);
    await chain.write(chain.usdc, "mint", [chain.seller, 100_000_000n]);
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 25_500_000n], chain.seller);
    await chain.write(chain.raffle, "buyPack", [2n, 0, 1, PUBLISHED_TERMS_HASH], chain.seller);
    const refundable = await chain.service.readRaffle({ id: 2n });
    await chain.warp(refundable.raffle.salesEnd + refundable.drawStartGrace);
    await chain.write(chain.raffle, "cancel", [2n], chain.seller);

    buyerWallet = chain.wallet(chain.buyer).session;
    await buyerWallet.connect();
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
    async function purchasedClosedRaffle(id: bigint, salesEnd: bigint) {
      const tokenId = 900n + id;
      const commitment = keccak256(toBytes(`permissionless-draw-${id}`));
      await chain.write(chain.nft, "mint", [chain.stranger, tokenId]);
      await chain.write(chain.raffle, "createRaffle", [
        chain.nft.address,
        tokenId,
        salesEnd,
        commitment,
        commitment,
        `Permissionless draw ${id}`,
        [{ name: "Membership", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 }]
      ], chain.stranger);
      await chain.write(chain.nft, "approve", [chain.raffle.address, tokenId], chain.stranger);
      await chain.write(chain.raffle, "escrow", [id], chain.stranger);
      await chain.write(chain.raffle, "open", [id], chain.stranger);
      await chain.write(chain.usdc, "approve", [chain.raffle.address, 1_020_000n], chain.buyer);
      await chain.write(chain.raffle, "buyPack", [id, 0, 1, PUBLISHED_TERMS_HASH], chain.buyer);
      await chain.warp(salesEnd);
      await chain.write(chain.raffle, "close", [id], chain.buyer);
    }

    let now = (await chain.client.getBlock()).timestamp;
    await purchasedClosedRaffle(27n, now + 600n);
    now = (await chain.client.getBlock()).timestamp;
    await purchasedClosedRaffle(28n, now + 600n);
    await chain.write(chain.raffle, "snapshot", [28n, 100n], chain.buyer);
    const expiring = await chain.service.readRaffle({ id: 28n });
    await chain.warp(expiring.raffle.salesEnd + expiring.drawStartGrace);
    now = (await chain.client.getBlock()).timestamp;
    await purchasedClosedRaffle(29n, now + 600n);
    await chain.write(chain.raffle, "snapshot", [29n, 100n], chain.buyer);
    fixture = await browserChain(chain);
    fixture.page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    fixture.page.on("console", (message: { type(): string; text(): string }) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  async function connectSeller(path = "/seller") {
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await fixture.page.getByText("25 total", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  }

  it("renders a complete multi-page portfolio without horizontal overflow on desktop and mobile", async () => {
    await fixture.page.setViewportSize({ width: 1440, height: 900 });
    await connectSeller();
    await expect.poll(async () => fixture.page.getByText(/Complete at block/).isVisible(), { timeout: 15_000 }).toBe(true);
    expect(await fixture.page.getByRole("link", { name: /Manage raffle/ }).count()).toBe(25);
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const summary = fixture.page.locator("summary").filter({ hasText: "Prepare a draft" });
    await summary.focus();
    await fixture.page.keyboard.press("Enter");
    await fixture.page.getByLabel("Raffle title").waitFor({ state: "visible" });
    await fixture.page.screenshot({ path: resolve(process.cwd(), "../../artifacts/seller-portal-fees-20261007/portal-builder/seller-desktop.png"), fullPage: true });

    await fixture.page.emulateMedia({ reducedMotion: "reduce" });
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await connectSeller();
    const overview = fixture.page.getByRole("heading", { name: "Revenue at a glance" }).locator("xpath=ancestor::section[1]");
    const columns = await overview.locator("dl").evaluate((element: Element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(2);
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await fixture.page.screenshot({ path: resolve(process.cwd(), "../../artifacts/seller-portal-fees-20261007/portal-builder/seller-mobile.png"), fullPage: true });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }, 45_000);

  it("gates a direct seller route immediately after the wallet changes", async () => {
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller/2`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await fixture.page.getByRole("heading", { name: "Seller portfolio 2" }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.getByRole("heading", { name: "Revenue and obligations" }).waitFor({ state: "visible" });
    await fixture.page.screenshot({ path: resolve(process.cwd(), "../../artifacts/seller-portal-fees-20261007/portal-builder/seller-detail-mobile.png"), fullPage: true });
    await fixture.switchAccount(chain.stranger);
    await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet." }).waitFor({ state: "visible", timeout: 5_000 });
    expect(await fixture.page.getByText(/Opening policy|Approve NFT|Escrow NFT/).count()).toBe(0);
  }, 30_000);

  it("keeps a seller's buyer refund on the public piece and out of seller-only controls", async () => {
    await fixture.switchAccount(chain.seller);
    let response = await fixture.page.goto(`${fixture.baseUrl}/seller/2`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    let connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await fixture.page.getByRole("heading", { name: "Seller portfolio 2" }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: "Claim refund", exact: true }).count()).toBe(0);

    response = await fixture.page.goto(`${fixture.baseUrl}/piece/2`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await fixture.page.getByRole("button", { name: "Claim refund", exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  }, 30_000);

  it("keeps permissionless draw preparation blocked until snapshot completion and before the deadline", async () => {
    await expect(chain.service.prepare({ action: { kind: "requestRandomness", id: 27n }, wallet: buyerWallet })).rejects.toThrow(/unavailable/);
    await expect(chain.service.prepare({ action: { kind: "requestRandomness", id: 28n }, wallet: buyerWallet })).rejects.toThrow(/deadline/);
  });

  it("renders one permissionless draw review for an eligible non-seller and submits fixed arguments", async () => {
    await fixture.switchAccount(chain.buyer);
    const response = await fixture.page.goto(`${fixture.baseUrl}/piece/29`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    const start = fixture.page.getByRole("button", { name: "Start draw", exact: true });
    await start.waitFor({ state: "visible", timeout: 15_000 });
    expect(await start.count()).toBe(1);
    await start.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible" });
    expect(await review.innerText()).toContain(chain.raffle.address);
    await review.getByRole("button", { name: "Confirm start draw", exact: true }).click();
    await expect.poll(async () => (await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "getRaffle", args: [29n] })).phase, { timeout: 15_000 }).toBe(3);
  }, 30_000);
});
