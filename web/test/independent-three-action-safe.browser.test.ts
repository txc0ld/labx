import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator } from "playwright";
import { keccak256, toBytes } from "viem";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { fillStandardMembershipEconomics, standardMembershipPacks } from "./fixtures/membership-tiers";

const run = process.env.RUN_INDEPENDENT_THREE_ACTION_BROWSER === "1" ? describe : describe.skip;

run("independent one-click Safe approval", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    const commitment = keccak256(toBytes("independent-deferred-safe-approval"));
    await chain.write(chain.nft, "mint", [chain.seller, 8_181n]);
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      8_181n,
      block.timestamp + 86_400n,
      commitment,
      commitment,
      "Deferred Safe approval",
      standardMembershipPacks((_tier, index) => ({ priceUsdc: 25_000_000n + BigInt(index), bonusEntries: index + 1, maxSupply: 10 }))
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 8_181n], chain.seller);
    await chain.write(chain.raffle, "escrow", [1n], chain.seller);
    fixture = await browserChain(chain, chain.operator);
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  async function connectUntilReady(ready: Locator) {
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    await expect.poll(async () => {
      if (await ready.isVisible().catch(() => false)) return true;
      if (await connect.isVisible().catch(() => false)) {
        try { await connect.click({ timeout: 2_000 }); }
        catch { /* Hydration may replace the disconnected control before the click settles. */ }
      }
      return ready.isVisible().catch(() => false);
    }, { timeout: 15_000, interval: 100 }).toBe(true);
  }

  async function openReview() {
    const response = await fixture.page.goto(`${fixture.baseUrl}/review/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const approval = fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true });
    await connectUntilReady(approval);
  }

  async function instrumentSellerProvider() {
    await fixture.page.evaluate(() => {
      type RpcRequest = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Scope = Window & { ethereum: { request: RpcRequest }; __independentSellerRpc: string[] };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      scope.__independentSellerRpc = [];
      scope.ethereum.request = async input => {
        scope.__independentSellerRpc.push(input.method);
        return original(input);
      };
    });
  }

  async function sellerRpc() {
    return fixture.page.evaluate(() => (window as unknown as Window & { __independentSellerRpc: string[] }).__independentSellerRpc);
  }

  async function settleAtPageTop() {
    await fixture.page.evaluate(async () => {
      window.scrollTo(0, 0);
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : image.decode().catch(() => undefined)));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await fixture.page.waitForTimeout(250);
  }

  async function fillCreate(tokenId: bigint, title: string) {
    await fixture.page.getByLabel("Raffle title", { exact: true }).fill(title);
    await fixture.page.getByLabel("Sales deadline in UTC", { exact: true }).fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
    await fixture.page.getByLabel("NFT contract", { exact: true }).fill(chain.nft.address);
    await fixture.page.getByLabel("Token ID", { exact: true }).fill(tokenId.toString());
    await fillStandardMembershipEconomics(fixture.page, (_tier, index) => ({ price: String(25 + index), bonusEntries: String(index + 1), supply: "10" }));
  }

  it("detects canonical execution while the wallet response is deferred and ignores its late rejection", async () => {
    await openReview();
    expect(await fixture.page.getByRole("checkbox").count()).toBe(0);
    expect(await fixture.page.getByText(/canonical collection provenance/i).isVisible()).toBe(true);
    expect(await fixture.page.getByText(/transfer restrictions and upgradability/i).isVisible()).toBe(true);
    expect(await fixture.page.getByText(/draw funding shown above/i).isVisible()).toBe(true);

    await fixture.page.evaluate(() => {
      type RpcRequest = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Scope = Window & {
        ethereum: { request: RpcRequest };
        __independentSafeSends: number;
        __rejectDeferredSafe(): void;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      let rejectDeferred: ((reason: unknown) => void) | null = null;
      scope.__independentSafeSends = 0;
      scope.__rejectDeferredSafe = () => rejectDeferred?.(Object.assign(new Error("late wallet rejection"), { code: 4001 }));
      scope.ethereum.request = async input => {
        if (input.method !== "eth_sendTransaction") return original(input);
        scope.__independentSafeSends += 1;
        await original(input);
        return new Promise((_resolve, reject) => { rejectDeferred = reject; });
      };
    });

    const approve = fixture.page.getByRole("button", { name: "Approve", exact: true });
    await expect.poll(() => approve.isEnabled(), { timeout: 15_000 }).toBe(true);
    await approve.focus();
    await fixture.page.keyboard.press("Enter");
    await fixture.page.getByRole("heading", { name: "Approval recorded", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __independentSafeSends: number }).__independentSafeSends)).toBe(1);

    await fixture.page.evaluate(() => (window as unknown as Window & { __rejectDeferredSafe(): void }).__rejectDeferredSafe());
    await fixture.page.waitForTimeout(750);
    expect(await fixture.page.getByRole("heading", { name: "Approval recorded", exact: true }).isVisible()).toBe(true);
    expect(await fixture.page.getByText(/late wallet rejection/i).count()).toBe(0);
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __independentSafeSends: number }).__independentSafeSends)).toBe(1);
  }, 45_000);

  it("creates two distinct raffles sequentially with one site activation each and no restored auto-send", async () => {
    const tokens = [8_282n, 8_283n] as const;
    for (const token of tokens) await chain.write(chain.nft, "mint", [chain.seller, token]);
    await fixture.switchAccount(chain.seller);

    for (const [index, token] of tokens.entries()) {
      const response = await fixture.page.goto(`${fixture.baseUrl}/seller`, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      const draftSummary = fixture.page.locator("summary").filter({ hasText: "Create a raffle" });
      await connectUntilReady(draftSummary);
      await draftSummary.click();
      await instrumentSellerProvider();
      await fixture.page.waitForTimeout(500);
      expect((await sellerRpc()).filter(method => method === "personal_sign" || method === "eth_sign" || method === "eth_sendTransaction")).toEqual([]);
      await fillCreate(token, `Independent sequential create ${index + 1}`);

      const create = fixture.page.getByRole("button", { name: "Create", exact: true });
      expect(await create.count()).toBe(1);
      expect(await fixture.page.getByText(/Create locks your NFT/i).isVisible()).toBe(true);
      expect(await fixture.page.getByText(/separate transaction confirmations/i).isVisible()).toBe(true);
      await create.click();
      await fixture.page.waitForURL(/\/seller\/\d+$/, { timeout: 60_000 });

      const calls = await sellerRpc();
      expect(calls.filter(method => method === "personal_sign")).toHaveLength(1);
      expect(calls.filter(method => method === "eth_sendTransaction")).toHaveLength(3);
      expect(await fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:create:v1:") && !key.includes(":completed:") && !key.endsWith(":generation")).length)).toBe(0);
    }

    expect(await chain.client.readContract({ address: chain.raffle.address, abi: chain.raffle.abi, functionName: "nextId" })).toBe(4n);
  }, 150_000);

  it("lists only on one explicit keyboard activation with the displayed policy visible and responsive", async () => {
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const listHeading = fixture.page.getByRole("heading", { name: "List your raffle", exact: true });
    await connectUntilReady(listHeading);
    await instrumentSellerProvider();
    await fixture.page.waitForTimeout(500);
    expect((await sellerRpc()).filter(method => method === "eth_sendTransaction")).toEqual([]);
    expect(await fixture.page.getByText(/buyers pay 2% or 2\.50 USDC per purchase, whichever is more/).isVisible()).toBe(true);
    const listingDetails = fixture.page.locator("details").filter({ has: fixture.page.getByText("Listing details", { exact: true }) });
    expect(await listingDetails.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    expect(await listingDetails.getByText(chain.manifest.expectedPolicy.treasury, { exact: true }).isVisible()).toBe(false);
    expect(await listingDetails.getByText(chain.manifest.expectedPolicy.coordinator, { exact: true }).isVisible()).toBe(false);
    expect(await listingDetails.getByText(chain.manifest.expectedPolicy.termsHash, { exact: true }).isVisible()).toBe(false);
    const listingDetailsText = await listingDetails.textContent();
    expect(listingDetailsText).toContain(chain.manifest.expectedPolicy.treasury);
    expect(listingDetailsText).toContain(chain.manifest.expectedPolicy.coordinator);
    expect(listingDetailsText).toContain(chain.manifest.expectedPolicy.termsHash);

    const evidence = resolve(process.env.LABX_THREE_ACTION_EVIDENCE_DIR ?? "/tmp/labx-three-action-evidence");
    mkdirSync(evidence, { recursive: true });
    for (const width of [320, 390, 768, 1440]) {
      await fixture.page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      const list = fixture.page.getByRole("button", { name: "List", exact: true });
      await list.scrollIntoViewIfNeeded();
      expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const box = await list.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? width) + (box?.width ?? width) <= width).toBe(true);
      await settleAtPageTop();
      await fixture.page.screenshot({ path: resolve(evidence, `list-${width}.png`), fullPage: true });
    }


    const focusedList = fixture.page.getByRole("button", { name: "List", exact: true });
    await focusedList.scrollIntoViewIfNeeded();
    await fixture.page.waitForTimeout(250);
    await fixture.page.screenshot({ path: resolve(evidence, "list-1440-action-viewport.png") });

    await fixture.page.setViewportSize({ width: 390, height: 844 });
    const cdp = await fixture.context.newCDPSession(fixture.page);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    expect(await fixture.page.getByRole("button", { name: "List", exact: true }).isVisible()).toBe(true);
    await settleAtPageTop();
    await fixture.page.screenshot({ path: resolve(evidence, "list-390-zoom-200.png"), fullPage: true });
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });

    await fixture.page.evaluate(() => { document.documentElement.dir = "rtl"; });
    expect(await fixture.page.getByRole("button", { name: "List", exact: true }).isVisible()).toBe(true);
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await settleAtPageTop();
    await fixture.page.screenshot({ path: resolve(evidence, "list-390-rtl.png"), fullPage: true });
    await fixture.page.evaluate(() => { document.documentElement.dir = "ltr"; });

    const list = fixture.page.getByRole("button", { name: "List", exact: true });
    expect(await list.count()).toBe(1);
    await list.focus();
    await fixture.page.keyboard.press("Enter");
    await expect.poll(async () => chain.client.readContract({ address: chain.raffle.address, abi: chain.raffle.abi, functionName: "getRaffle", args: [1n] }), { timeout: 20_000 })
      .toMatchObject({ phase: 1 });
    expect((await sellerRpc()).filter(method => method === "eth_sendTransaction")).toHaveLength(1);
  }, 90_000);
});
