import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, erc721Abi, keccak256, toBytes } from "viem";
import { hashCommitment } from "../lib/commitment";
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
  const longPackName = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let evidenceDir: string;

  beforeAll(async () => {
    evidenceDir = process.env.LABX_SELLER_EVIDENCE_DIR ? resolve(process.env.LABX_SELLER_EVIDENCE_DIR) : mkdtempSync(resolve(tmpdir(), "labx-seller-portal-"));
    mkdirSync(evidenceDir, { recursive: true });
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
        block.timestamp + (id === 26n ? 60n * 86_400n : 86_400n),
        commitment,
        commitment,
        offset === 0 ? "Another seller raffle" : `Seller portfolio ${id}`,
        [{
          name: id === 26n ? longPackName : "Membership",
          priceUsdc: id === 26n ? 1_000_000_000_000n : 25_000_000n,
          bonusEntries: 2,
          maxSupply: 100
        }]
      ], owner);
    }
    await chain.write(chain.nft, "approve", [chain.raffle.address, 802n], chain.seller);
    await chain.write(chain.raffle, "escrow", [2n], chain.seller);
    await chain.admit(2n);
    await chain.write(chain.raffle, "open", [2n], chain.seller);
    await chain.write(chain.usdc, "mint", [chain.seller, 100_000_000n]);
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 27_500_000n], chain.seller);
    await chain.write(chain.raffle, "buyPack", [2n, 0, 1, PUBLISHED_TERMS_HASH], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 826n], chain.seller);
    await chain.write(chain.raffle, "escrow", [26n], chain.seller);
    await chain.admit(26n);
    await chain.write(chain.raffle, "open", [26n], chain.seller);
    const refundable = await chain.service.readRaffle({ id: 2n });
    await chain.warp(refundable.raffle.salesEnd + refundable.drawStartGrace);
    await chain.write(chain.raffle, "cancel", [2n], chain.seller);
    await chain.write(chain.raffle, "reclaimPrize", [2n], chain.seller);

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
      await chain.admit(id);
      await chain.write(chain.raffle, "open", [id], chain.stranger);
      await chain.write(chain.usdc, "approve", [chain.raffle.address, 3_500_000n], chain.buyer);
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

    now = (await chain.client.getBlock()).timestamp;
    const nonce = keccak256(toBytes("seller-winner-nonce"));
    const publicHash = keccak256(toBytes("seller winner public note"));
    const privateHash = keccak256(toBytes("seller winner private value"));
    const salt = keccak256(toBytes("seller-winner-salt"));
    const commit = hashCommitment({
      chainId: 31337n,
      labx: chain.raffle.address,
      nonce,
      nft: chain.nft.address,
      tokenId: 930n,
      publicHash,
      privateHash,
      salt
    });
    await chain.write(chain.nft, "mint", [chain.seller, 930n]);
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      930n,
      now + 600n,
      nonce,
      commit,
      "Seller is the winner",
      [{ name: "Solo membership", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 1 }]
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 930n], chain.seller);
    await chain.write(chain.raffle, "escrow", [30n], chain.seller);
    await chain.admit(30n);
    await chain.write(chain.raffle, "open", [30n], chain.seller);
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 3_500_000n], chain.seller);
    await chain.write(chain.raffle, "buyPack", [30n, 0, 1, PUBLISHED_TERMS_HASH], chain.seller);
    await chain.warp(now + 600n);
    await chain.write(chain.raffle, "close", [30n], chain.buyer);
    await chain.write(chain.raffle, "snapshot", [30n, 100n], chain.buyer);
    await chain.write(chain.raffle, "requestRandomness", [30n], chain.buyer);
    const sellerWinner = await chain.service.readRaffle({ id: 30n });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, sellerWinner.raffle.vrfRequestId, 0n]);
    await chain.write(chain.raffle, "reveal", [30n, publicHash, privateHash, salt], chain.seller);
    await chain.write(chain.raffle, "settle", [30n], chain.buyer);
    await chain.write(chain.raffle, "claimProceeds", [30n], chain.seller);

    await chain.rpc("anvil_mine", ["0x7d0"]);
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
    await fixture.page.getByText("26 total", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  }

  async function transact(label: string) {
    const trigger = fixture.page.getByRole("button", { name: label, exact: true }).first();
    await trigger.waitFor({ state: "visible", timeout: 15_000 });
    await trigger.click();
    const review = fixture.page.locator(".transaction-review").first();
    await review.waitFor({ state: "visible", timeout: 10_000 });
    const blockBeforeSubmit = await chain.client.getBlockNumber({ cacheTime: 0 });
    await review.getByRole("button", { name: `Confirm ${label.toLowerCase()}`, exact: true }).click();
    await expect.poll(async () => chain.client.getBlockNumber({ cacheTime: 0 }), { timeout: 15_000 }).toBeGreaterThan(blockBeforeSubmit);
    await expect.poll(async () => fixture.page.locator(".transaction-review").count(), { timeout: 15_000 }).toBe(0);
  }

  it("keeps the complete seller workspace and draft form aligned across supported widths", async () => {
    await fixture.page.setViewportSize({ width: 1440, height: 900 });
    await fixture.page.emulateMedia({ reducedMotion: "reduce" });
    await connectSeller();
    await expect.poll(async () => fixture.page.getByText(/Complete at block/).isVisible(), { timeout: 15_000 }).toBe(true);
    expect(await fixture.page.getByRole("link", { name: /Manage raffle/ }).count()).toBe(26);
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const summary = fixture.page.locator("summary").filter({ hasText: "Prepare a draft" });
    await summary.focus();
    await fixture.page.keyboard.press("Enter");
    await fixture.page.getByLabel("Raffle title").waitFor({ state: "visible" });

    for (const name of ["Raffle details", "Prize NFT", "Draw commitment", "Membership packs", "Membership 1"]) {
      await fixture.page.getByRole("group", { name }).waitFor({ state: "visible" });
    }

    await fixture.page.getByRole("button", { name: "Add membership", exact: true }).focus();
    await fixture.page.keyboard.press("Enter");
    await fixture.page.getByRole("group", { name: "Membership 2" }).waitFor({ state: "visible" });
    await fixture.page.getByRole("button", { name: "Remove membership 2", exact: true }).focus();
    await fixture.page.keyboard.press("Enter");
    expect(await fixture.page.getByRole("group", { name: "Membership 2" }).count()).toBe(0);

    const futureDeadline = Number((await chain.client.getBlock()).timestamp + 86_400n);
    await fixture.page.getByLabel("Raffle title").fill("Responsive seller draft");
    await fixture.page.getByLabel("NFT contract").fill(chain.nft.address);
    await fixture.page.getByLabel("Token ID").fill("999");
    await fixture.page.getByLabel("Sales deadline in UTC").fill(new Date(futureDeadline * 1000).toISOString().slice(0, 16));
    await fixture.page.getByLabel("Public commitment note").fill("Public responsive layout review");
    await fixture.page.getByLabel("Private commitment").fill("Private responsive layout review");
    await fixture.page.getByLabel("Name", { exact: true }).fill("Standard membership");
    await fixture.page.getByLabel("Price in USDC").fill("25");
    await fixture.page.getByLabel("Bonus entries").fill("2");
    await fixture.page.getByLabel("Supply").fill("100");
    await fixture.page.getByRole("button", { name: "Review raffle draft", exact: true }).click();
    const reviewHeading = fixture.page.getByRole("heading", { name: "Review raffle draft", exact: true });
    await fixture.page.getByRole("button", { name: "Sign and save commitment", exact: true }).waitFor({ state: "visible" });
    await expect.poll(async () => reviewHeading.evaluate((heading) => {
      const bounds = heading.getBoundingClientRect();
      const headerBottom = document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
      return document.activeElement === heading && bounds.top >= headerBottom && bounds.bottom <= window.innerHeight;
    })).toBe(true);
    await fixture.page.screenshot({ path: resolve(evidenceDir, "seller-review-1440.png"), fullPage: false });
    await fixture.page.getByRole("button", { name: "Edit draft", exact: true }).click();

    await expect.poll(async () => fixture.page.evaluate(() => document.activeElement?.id)).toBe("draft-title");
    const editPosition = await fixture.page.locator("#draft-title").evaluate(async (input) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const bounds = input.getBoundingClientRect();
      const headerBottom = document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
      return {
        belowHeader: bounds.top >= headerBottom,
        inViewport: bounds.bottom <= window.innerHeight,
        unobscured: document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === input
      };
    });
    expect(editPosition).toEqual({ belowHeader: true, inViewport: true, unobscured: true });
    expect(await fixture.page.locator("form").filter({ has: fixture.page.getByLabel("Raffle title") }).locator("input, textarea").evaluateAll((controls) => controls.map((control) => control.id).filter(Boolean).slice(0, 6))).toEqual(["draft-title", "draft-close", "draft-nft", "draft-token", "draft-public", "draft-private"]);
    await fixture.page.keyboard.press("Tab");
    expect(await fixture.page.evaluate(() => document.activeElement?.id)).toBe("draft-close");

    const createPanel = fixture.page.locator("section[aria-label='Create a raffle draft']");
    for (const width of [320, 390, 768, 1024, 1440, 1680]) {
      await fixture.page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
      expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const clippedControls = await createPanel.locator("input:visible, textarea:visible, button:visible").evaluateAll((controls, panel) => {
        const panelBounds = (panel as Element).getBoundingClientRect();
        return controls.filter((control) => {
          const bounds = control.getBoundingClientRect();
          return bounds.left < panelBounds.left - 1 || bounds.right > panelBounds.right + 1 || bounds.left < -1 || bounds.right > document.documentElement.clientWidth + 1;
        }).map((control) => (control as HTMLElement).outerHTML);
      }, await createPanel.elementHandle());
      expect(clippedControls).toEqual([]);
      await createPanel.screenshot({ path: resolve(evidenceDir, `seller-create-${width}.png`) });
      await fixture.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await createPanel.evaluate((panel) => {
        const bounds = panel.getBoundingClientRect();
        window.scrollTo({ top: window.scrollY + bounds.top - 120 });
      });
      await fixture.page.screenshot({ path: resolve(evidenceDir, `seller-create-${width}-viewport.png`), fullPage: false });
    }

    await fixture.page.setViewportSize({ width: 768, height: 900 });
    await fixture.page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await createPanel.screenshot({ path: resolve(evidenceDir, "seller-create-768-zoom-200.png") });
    await fixture.page.evaluate(() => { document.documentElement.style.zoom = ""; });

    await fixture.page.emulateMedia({ reducedMotion: "reduce" });
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    const overview = fixture.page.getByRole("heading", { name: "Revenue at a glance" }).locator("xpath=ancestor::section[1]");
    const columns = await overview.locator("dl").first().evaluate((element: Element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(2);
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await fixture.page.screenshot({ path: resolve(evidenceDir, "seller-workspace-390.png"), fullPage: false });

    const longPackResponse = await fixture.page.goto(`${fixture.baseUrl}/piece/26`, { waitUntil: "domcontentloaded" });
    expect(longPackResponse?.status()).toBe(200);
    await fixture.page.getByText(longPackName, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.getByText("1,000,000 USDC", { exact: true }).waitFor({ state: "visible" });
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
    await fixture.page.screenshot({ path: resolve(process.cwd(), "../../artifacts/seller-portal-fees-20261007/portal-independent/seller-detail-mobile.png"), fullPage: true });
    await fixture.switchAccount(chain.stranger);
    await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet." }).waitFor({ state: "visible", timeout: 5_000 });
    expect(await fixture.page.getByText(/Opening policy|Approve NFT|Escrow NFT/).count()).toBe(0);

    await fixture.switchAccount(chain.operator);
    await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet." }).waitFor({ state: "visible", timeout: 5_000 });
    expect(await fixture.page.getByRole("button", { name: /Approve NFT|Escrow NFT|Claim proceeds/ }).count()).toBe(0);
  }, 30_000);

  it("keeps earlier activity through a later-page failure and an empty final retry", async () => {
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller/2`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const activity = fixture.page.getByRole("heading", { name: "On-chain money movements" }).locator("xpath=ancestor::section[1]");
    await activity.getByText("Membership purchased", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await activity.getByText("Membership purchased", { exact: true }).count()).toBe(1);
    expect(await activity.getByText("Complete", { exact: true }).count()).toBe(0);

    let failuresRemaining = 1;
    await fixture.page.route(`${chain.url}/`, async (route: {
      request(): { postDataJSON(): unknown };
      continue(): Promise<void>;
      fulfill(input: { status: number; contentType: string; body: string }): Promise<void>;
    }) => {
      const payload = route.request().postDataJSON();
      if (failuresRemaining > 0 && payload && typeof payload === "object" && "method" in payload && payload.method === "eth_getLogs") {
        failuresRemaining -= 1;
        const id = "id" in payload ? payload.id : null;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "transient activity RPC failure" } })
        });
        return;
      }
      await route.continue();
    });

    await activity.getByRole("button", { name: "Scan next 2,000 blocks", exact: true }).click();
    await activity.getByText("Activity scan stopped", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(failuresRemaining).toBe(0);
    expect(await activity.getByText("Membership purchased", { exact: true }).count()).toBe(1);
    expect(await activity.getByText("Complete", { exact: true }).count()).toBe(0);

    await activity.getByRole("button", { name: "Retry activity scan", exact: true }).click();
    await activity.getByText("Complete", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await activity.getByText("Membership purchased", { exact: true }).count()).toBe(1);
    await fixture.page.unroute(`${chain.url}/`);
  }, 45_000);

  it("keeps a seller's buyer refund on the public piece and out of seller-only controls", async () => {
    const beforeRefund = await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] });
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
    expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [802n] })).toBe(chain.seller);
    await transact("Claim refund");
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] })).toBe(beforeRefund + 25_000_000n);
    expect((await chain.service.readAccount({ id: 2n, account: chain.seller })).principal).toBe(0n);
  }, 30_000);

  it("keeps a seller-winner prize claim in the public flow after proceeds are claimed", async () => {
    await fixture.switchAccount(chain.seller);
    let response = await fixture.page.goto(`${fixture.baseUrl}/seller/30`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.getByRole("heading", { name: "Seller is the winner" }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: "Claim NFT", exact: true }).count()).toBe(0);

    response = await fixture.page.goto(`${fixture.baseUrl}/piece/30`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.getByRole("button", { name: "Claim NFT", exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    await transact("Claim NFT");
    expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [930n] })).toBe(chain.seller);
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
    const drawing = await chain.service.readRaffle({ id: 29n });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    const sellerRoute = await fixture.page.goto(`${fixture.baseUrl}/seller/29`, { waitUntil: "domcontentloaded" });
    expect(sellerRoute?.status()).toBe(200);
    await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet." }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: /Reveal commitment|Settle raffle|Claim proceeds/ }).count()).toBe(0);
  }, 30_000);
});
