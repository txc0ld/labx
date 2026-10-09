import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toBytes, zeroHash, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_INDEPENDENT_SELLER_SIMPLIFICATION_BROWSER === "1" ? describe : describe.skip;

type RpcTrace = { method: string; params?: readonly unknown[] };

run("independent seller simplification boundaries", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let evidenceDir: string;

  beforeAll(async () => {
    evidenceDir = resolve(process.env.LABX_SELLER_SIMPLIFICATION_EVIDENCE_DIR ?? "../artifacts/workflow-simplification-20261010/verification/screenshots");
    mkdirSync(evidenceDir, { recursive: true });
    chain = await localChain();
    const block = await chain.client.getBlock();
    for (const id of [1n, 2n, 3n, 4n]) {
      const tokenId = 1_100n + id;
      const commitment = keccak256(toBytes(`independent-seller-simplification-${id.toString()}`));
      await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
      await chain.write(chain.raffle, "createRaffle", [
        chain.nft.address,
        tokenId,
        block.timestamp + 86_400n,
        commitment,
        commitment,
        `Independent seller simplification ${id.toString()}`,
        [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]
      ], chain.seller);
      if (id >= 2n) {
        await chain.write(chain.nft, "approve", [chain.raffle.address, tokenId], chain.seller);
        await chain.write(chain.raffle, "escrow", [id], chain.seller);
      }
      if (id >= 3n) await chain.admit(id);
    }
    fixture = await browserChain(chain, chain.seller);
    await fixture.page.emulateMedia({ reducedMotion: "reduce" });
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  async function instrumentProvider() {
    await fixture.page.evaluate(() => {
      type Request = (input: RpcTrace) => Promise<unknown>;
      type Scope = Window & {
        ethereum: { request: Request };
        __sellerRpcTrace: RpcTrace[];
        __sellerBadHash: boolean;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      scope.__sellerRpcTrace = [];
      scope.__sellerBadHash = false;
      scope.ethereum.request = async input => {
        scope.__sellerRpcTrace.push({ method: input.method, params: input.params });
        if (input.method === "eth_sendTransaction" && scope.__sellerBadHash) return "invalid-provider-hash";
        return original(input);
      };
    });
  }

  async function providerCalls() {
    return fixture.page.evaluate(() =>
      (window as unknown as Window & { __sellerRpcTrace: RpcTrace[] }).__sellerRpcTrace.map(call => call.method));
  }

  async function openSeller(id: bigint) {
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller/${id.toString()}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await instrumentProvider();
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await fixture.page.getByRole("heading", { name: `Independent seller simplification ${id.toString()}`, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  }

  function pendingKey(account: Address) {
    return `labx:pending:v1:${chain.manifest.chainId}:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${account.toLowerCase()}`;
  }

  async function screenshot(name: string, width: number) {
    await fixture.page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await fixture.page.evaluate(async () => {
      window.scrollTo(0, 0);
      await new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())));
    });
    await expect.poll(() => fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await fixture.page.screenshot({ path: resolve(evidenceDir, `${name}-${width}.png`), fullPage: true });
  }

  it("lets a saved pending intent and a storage-read failure win before automatic preparation", async () => {
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.evaluate(({ key, intentHash }) => {
      localStorage.setItem(key, JSON.stringify({ id: "held-before-prepare", intentHash, nonce: 77, startedBlock: "1", hash: null }));
    }, { key: pendingKey(chain.seller), intentHash: zeroHash });
    await instrumentProvider();
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await fixture.page.getByText("Reconcile pending wallet activity", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction" || method === "personal_sign" || method === "eth_sign" || method === "wallet_switchEthereumChain")).toEqual([]);

    await fixture.page.evaluate(key => localStorage.removeItem(key), pendingKey(chain.seller));
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await instrumentProvider();
    await fixture.page.evaluate(() => {
      const original = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        if (key.startsWith("labx:pending:v1:")) throw new Error("independent pending storage read failure");
        return original.call(this, key);
      };
    });
    const reconnect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await reconnect.isVisible().catch(() => false)) await reconnect.click();
    await fixture.page.getByRole("alert").filter({ hasText: "independent pending storage read failure" }).first().waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction" || method === "personal_sign" || method === "eth_sign")).toEqual([]);
  }, 45_000);

  it("auto-prepares once per wallet scope, discards an A-to-B-to-A stale result, and never sends before Confirm", async () => {
    await openSeller(1n);
    const firstReview = fixture.page.locator(".transaction-review");
    await firstReview.waitFor({ state: "visible", timeout: 15_000 });
    await firstReview.getByRole("heading", { name: "Approve NFT", exact: true }).waitFor({ state: "visible" });
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction" || method === "personal_sign" || method === "eth_sign")).toEqual([]);

    await firstReview.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    await expect.poll(() => fixture.page.locator(".transaction-review").count()).toBe(0);
    await fixture.page.waitForTimeout(500);
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Approve NFT", exact: true }).count()).toBe(1);

    await fixture.page.evaluate(() => {
      type Request = (input: RpcTrace) => Promise<unknown>;
      type Held = { input: RpcTrace; resolve(value: unknown): void; reject(reason: unknown): void };
      type Scope = Window & {
        ethereum: { request: Request };
        __sellerHeldAccounts: number;
        __sellerReleaseAccounts(): void;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      const held: Held[] = [];
      let holding = true;
      scope.__sellerHeldAccounts = 0;
      scope.ethereum.request = input => {
        if (!holding || input.method !== "eth_accounts") return original(input);
        scope.__sellerHeldAccounts += 1;
        return new Promise((resolve, reject) => held.push({ input, resolve, reject }));
      };
      scope.__sellerReleaseAccounts = () => {
        holding = false;
        for (const call of held.splice(0)) void original(call.input).then(call.resolve, call.reject);
      };
    });
    await fixture.page.getByRole("button", { name: "Approve NFT", exact: true }).click();
    await expect.poll(() => fixture.page.evaluate(() =>
      (window as unknown as Window & { __sellerHeldAccounts: number }).__sellerHeldAccounts), { timeout: 5_000 }).toBeGreaterThan(0);
    await fixture.switchAccount(chain.stranger);
    await fixture.page.evaluate(() =>
      (window as unknown as Window & { __sellerReleaseAccounts(): void }).__sellerReleaseAccounts());
    await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet.", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);

    await fixture.switchAccount(chain.seller);
    await firstReview.waitFor({ state: "visible", timeout: 15_000 });
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction" || method === "personal_sign" || method === "eth_sign")).toEqual([]);

    await chain.rpc("anvil_setCode", [chain.seller, "0x6001600055"]);
    await firstReview.getByRole("button", { name: "Confirm approve nft", exact: true }).click();
    await fixture.page.getByText("Action unavailable", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction")).toEqual([]);
    await chain.rpc("anvil_setCode", [chain.seller, "0x"]);

    const activity = fixture.page.locator(".resume-transaction details").filter({ has: fixture.page.locator("summary", { hasText: /^Activity \(/ }) });
    await activity.waitFor({ state: "visible", timeout: 15_000 });
    expect(await activity.getAttribute("open")).toBeNull();
    await screenshot("activity-collapsed", 390);
    await activity.locator("summary").focus();
    await fixture.page.keyboard.press("Enter");
    await activity.getByText("Transaction needs attention", { exact: true }).waitFor({ state: "visible" });
    await screenshot("activity-expanded", 390);
    await fixture.page.setViewportSize({ width: 1440, height: 900 });
    await activity.locator("summary").press("Enter");
    await screenshot("activity-collapsed", 1440);
    await activity.locator("summary").press("Enter");
    await screenshot("activity-expanded", 1440);
  }, 60_000);

  it("keeps an ambiguous no-hash provider response and its journal prominent", async () => {
    await openSeller(1n);
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.evaluate(() => {
      (window as unknown as Window & { __sellerBadHash: boolean }).__sellerBadHash = true;
    });
    await review.getByRole("button", { name: "Confirm approve nft", exact: true }).click();
    await fixture.page.getByText("Reconcile pending wallet activity", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction")).toHaveLength(1);
    const raw = await fixture.page.evaluate(key => localStorage.getItem(key), pendingKey(chain.seller));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "null")).toMatchObject({ hash: null });
    const unresolved = fixture.page.locator(".resume-transaction > .transaction-outcome").filter({ hasText: "Transaction needs attention" });
    await unresolved.waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.locator(".resume-transaction details").filter({ has: unresolved }).count()).toBe(0);
    await fixture.page.evaluate(key => localStorage.removeItem(key), pendingKey(chain.seller));
  }, 45_000);

  it("shows truthful seller next steps and exact opening review at narrow and desktop widths", async () => {
    await openSeller(2n);
    await fixture.page.getByRole("heading", { name: "Awaiting LABx review", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("heading", { name: "Cancel draft", exact: true }).count()).toBe(0);
    const advanced = fixture.page.locator("details").filter({ has: fixture.page.locator("summary", { hasText: /^Advanced \(/ }) });
    await advanced.locator("summary").focus();
    await fixture.page.keyboard.press("Enter");
    await advanced.getByRole("heading", { name: "Cancel draft", exact: true }).waitFor({ state: "visible" });
    await advanced.locator("summary").press("Enter");
    for (const width of [320, 390, 768, 1440]) {
      await screenshot("awaiting-review", width);
    }

    await openSeller(3n);
    await fixture.page.getByRole("heading", { name: "Open memberships", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.getByText(chain.manifest.expectedPolicy.treasury, { exact: true }).waitFor({ state: "visible" });
    await fixture.page.getByText(chain.manifest.expectedPolicy.coordinator, { exact: true }).waitFor({ state: "visible" });
    await fixture.page.getByText(chain.manifest.expectedPolicy.termsHash, { exact: true }).waitFor({ state: "visible" });
    await fixture.page.getByText("Greater of 2.5 USDC or 2% per purchase call; retained after a successful purchase", { exact: true }).waitFor({ state: "visible" });
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction" || method === "personal_sign" || method === "eth_sign")).toEqual([]);
    for (const width of [320, 390, 768, 1440]) await screenshot("approved-open-review", width);

    await review.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    await expect.poll(() => fixture.page.locator(".transaction-review").count()).toBe(0);
    await fixture.page.waitForTimeout(500);
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Open memberships", exact: true }).count()).toBe(1);
  }, 60_000);

  it("does not loop a failed opening-policy read and discards its delayed result after a wallet change", async () => {
    const policySelector = encodeFunctionData({ abi: raffleAbi, functionName: "openingPolicyHash" }).slice(0, 10);
    let failPolicy = false;
    let failures = 0;
    let holdPolicy = false;
    const held: Array<() => void> = [];
    await fixture.page.route(`${chain.url}/`, async route => {
      const payload = route.request().postDataJSON() as { id?: number; method?: string; params?: Array<{ data?: Hex }> } | undefined;
      const policyCall = payload?.method === "eth_call" && payload.params?.[0]?.data?.startsWith(policySelector);
      if (policyCall && failPolicy) {
        failPolicy = false;
        failures += 1;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: payload?.id, error: { code: -32_000, message: "independent opening policy failure" } }) });
        return;
      }
      if (policyCall && holdPolicy) {
        await new Promise<void>(resolveHeld => held.push(resolveHeld));
      }
      await route.continue();
    });
    try {
      await openSeller(4n);
      await fixture.page.locator(".transaction-review").waitFor({ state: "visible", timeout: 15_000 });
      failPolicy = true;
      await fixture.page.getByRole("button", { name: "Refresh policy review", exact: true }).click();
      await fixture.page.getByRole("alert").filter({ hasText: "independent opening policy failure" }).waitFor({ state: "visible", timeout: 15_000 });
      await fixture.page.waitForTimeout(750);
      expect(failures).toBe(1);
      expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
      await fixture.page.getByRole("button", { name: "Retry opening policy", exact: true }).press("Enter");
      await fixture.page.locator(".transaction-review").waitFor({ state: "visible", timeout: 15_000 });

      holdPolicy = true;
      await fixture.page.getByRole("button", { name: "Refresh policy review", exact: true }).click();
      await expect.poll(() => held.length, { timeout: 5_000 }).toBeGreaterThan(0);
      await fixture.switchAccount(chain.stranger);
      for (const release of held.splice(0)) release();
      holdPolicy = false;
      await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet.", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      await fixture.page.waitForTimeout(500);
      expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    } finally {
      holdPolicy = false;
      for (const release of held.splice(0)) release();
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 60_000);
});
