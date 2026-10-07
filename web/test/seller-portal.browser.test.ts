import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_SELLER_PORTAL_BROWSER === "1" ? describe : describe.skip;

run("rendered seller portal on isolated Anvil", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
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
});
