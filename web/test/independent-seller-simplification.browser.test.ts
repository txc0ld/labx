import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toBytes, zeroHash, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { connectWallet } from "./fixtures/connect-wallet";

const run = process.env.RUN_INDEPENDENT_SELLER_SIMPLIFICATION_BROWSER === "1" ? describe : describe.skip;
type RpcTrace = { method: string; params?: readonly unknown[] };

run("independent seller simplification boundaries", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let evidenceDir: string;

  beforeAll(async () => {
    evidenceDir = resolve(process.env.LABX_SELLER_SIMPLIFICATION_EVIDENCE_DIR ?? "../artifacts/three-action-flow-20261010/legacy/screenshots");
    mkdirSync(evidenceDir, { recursive: true });
    chain = await localChain();
    const block = await chain.client.getBlock();
    for (const id of [1n, 2n, 3n, 4n, 5n]) {
      const tokenId = 1_100n + id;
      const commitment = keccak256(toBytes(`independent-seller-simplification-${id.toString()}`));
      await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
      await chain.write(chain.raffle, "createRaffle", [chain.nft.address, tokenId, block.timestamp + 86_400n, commitment, commitment, `Independent seller simplification ${id.toString()}`, [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]], chain.seller);
      if (id >= 2n && id <= 4n) {
        await chain.write(chain.nft, "approve", [chain.raffle.address, tokenId], chain.seller);
        await chain.write(chain.raffle, "escrow", [id], chain.seller);
      }
      if (id === 3n || id === 4n) await chain.admit(id);
    }
    fixture = await browserChain(chain, chain.seller);
    await fixture.page.emulateMedia({ reducedMotion: "reduce" });
  }, 120_000);

  afterAll(async () => { await fixture?.close(); chain?.close(); });

  async function instrumentProvider() {
    await fixture.page.evaluate(() => {
      type Scope = Window & { ethereum: { request(input: RpcTrace): Promise<unknown> }; __sellerRpcTrace: RpcTrace[]; __sellerBadHash: boolean };
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
    return fixture.page.evaluate(() => (window as unknown as Window & { __sellerRpcTrace: RpcTrace[] }).__sellerRpcTrace.map(call => call.method));
  }
  async function openSeller(id: bigint) {
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller/${id.toString()}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await instrumentProvider();
    await connectWallet(fixture.page, fixture.page.getByRole("heading", { name: `Independent seller simplification ${id.toString()}`, exact: true }));
  }
  function pendingKey(account: Address) {
    return `labx:pending:v1:${chain.manifest.chainId}:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${account.toLowerCase()}`;
  }
  async function screenshot(name: string, width: number) {
    await fixture.page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await fixture.page.evaluate(async () => { window.scrollTo(0, 0); await new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))); });
    await expect.poll(() => fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await fixture.page.screenshot({ path: resolve(evidenceDir, `${name}-${width}.png`), fullPage: true });
  }

  it("lets a saved pending intent and a storage-read failure win before Create", async () => {
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.evaluate(({ key, intentHash }) => localStorage.setItem(key, JSON.stringify({ id: "held-before-create", intentHash, nonce: 77, startedBlock: "1", hash: null })), { key: pendingKey(chain.seller), intentHash: zeroHash });
    await instrumentProvider();
    const advanced = fixture.page.locator("details.workflow-details > summary").filter({ hasText: "Cancel draft" });
    await connectWallet(fixture.page, advanced);
    await advanced.click();
    await fixture.page.getByText("Your last transaction needs a check", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction" || method === "personal_sign" || method === "eth_sign")).toEqual([]);

    await fixture.page.evaluate(key => localStorage.removeItem(key), pendingKey(chain.seller));
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await instrumentProvider();
    await fixture.page.evaluate(() => {
      const original = Storage.prototype.getItem;
      (window as unknown as Window & { __restorePendingRead(): void }).__restorePendingRead = () => { Storage.prototype.getItem = original; };
      Storage.prototype.getItem = function (key: string) { if (key.startsWith("labx:pending:v1:")) throw new Error("independent pending storage read failure"); return original.call(this, key); };
    });
    try {
      await connectWallet(fixture.page, fixture.page.getByRole("alert").filter({ hasText: "independent pending storage read failure" }).first());
      expect((await providerCalls()).filter(method => method === "eth_sendTransaction" || method === "personal_sign" || method === "eth_sign")).toEqual([]);
    } finally {
      await fixture.page.evaluate(() => (window as unknown as Window & { __restorePendingRead(): void }).__restorePendingRead());
    }
  }, 45_000);

  it("requires one Create activation, coalesces double clicks and locks the exact NFT", async () => {
    await openSeller(1n);
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction")).toEqual([]);
    await fixture.page.getByRole("button", { name: "Create", exact: true }).dblclick();
    await fixture.page.getByRole("heading", { name: "Waiting for LABx review", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction")).toHaveLength(2);
    const snapshot = await chain.service.readRaffle({ id: 1n });
    expect(snapshot.raffle.escrowed).toBe(true);
    expect(snapshot.raffle.tokenId).toBe(1_101n);
  }, 45_000);

  it("keeps an ambiguous no-hash Create response and its journal prominent", async () => {
    await openSeller(5n);
    await fixture.page.evaluate(() => { (window as unknown as Window & { __sellerBadHash: boolean }).__sellerBadHash = true; });
    await fixture.page.getByRole("button", { name: "Create", exact: true }).click();
    await fixture.page.getByRole("alert").filter({ hasText: "The wallet response is uncertain" }).waitFor({ state: "visible", timeout: 15_000 });
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction")).toHaveLength(1);
    const raw = await fixture.page.evaluate(key => localStorage.getItem(key), pendingKey(chain.seller));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "null")).toMatchObject({ hash: null });
    expect(await fixture.page.getByRole("button", { name: "Create", exact: true }).count()).toBe(1);
    await fixture.page.evaluate(key => localStorage.removeItem(key), pendingKey(chain.seller));
  }, 45_000);

  it("shows the visible opening policy and submits List directly at all target widths", async () => {
    await openSeller(3n);
    await fixture.page.getByRole("heading", { name: "List your raffle", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.locator("details.workflow-details > summary").filter({ hasText: "Listing details" }).click();
    await fixture.page.getByText(chain.manifest.expectedPolicy.treasury, { exact: true }).waitFor({ state: "visible" });
    await fixture.page.getByText(chain.manifest.expectedPolicy.coordinator, { exact: true }).waitFor({ state: "visible" });
    await fixture.page.getByText(chain.manifest.expectedPolicy.termsHash, { exact: true }).waitFor({ state: "visible" });
    await fixture.page.getByText("Buyers can join as soon as it’s listed. Fees are fixed from here: buyers pay 2% or 2.50 USDC per purchase, whichever is more; you pay 2% of sales when the raffle completes.", { exact: true }).waitFor({ state: "visible" });
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction")).toEqual([]);
    for (const width of [320, 390, 768, 1440]) await screenshot("approved-list", width);
    await fixture.page.getByRole("button", { name: "List", exact: true }).click();
    await expect.poll(async () => (await chain.service.readRaffle({ id: 3n })).raffle.phase, { timeout: 15_000 }).toBe(1);
    expect((await providerCalls()).filter(method => method === "eth_sendTransaction")).toHaveLength(1);
    await expect.poll(() => fixture.page.locator(".transaction-review").count(), { timeout: 15_000 }).toBe(0);
  }, 60_000);

  it("does not loop a failed opening-policy read and discards its delayed result after a wallet change", async () => {
    await openSeller(4n);
    await fixture.page.getByRole("button", { name: "List", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.locator("details.workflow-details > summary").filter({ hasText: "Listing details" }).click();
    const policySelector = encodeFunctionData({ abi: raffleAbi, functionName: "openingPolicyHash" }).slice(0, 10);
    let failPolicy = true;
    let failures = 0;
    let holdPolicy = false;
    const held: Array<() => void> = [];
    await fixture.page.route(`${chain.url}/`, async route => {
      const payload = route.request().postDataJSON() as { id?: number; method?: string; params?: Array<{ data?: Hex }> } | undefined;
      const policyCall = payload?.method === "eth_call" && payload.params?.[0]?.data?.startsWith(policySelector);
      if (policyCall && failPolicy) {
        failPolicy = false; failures += 1;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: payload?.id, error: { code: -32_000, message: "independent opening policy failure" } }) });
        return;
      }
      if (policyCall && holdPolicy) await new Promise<void>(resolveHeld => held.push(resolveHeld));
      await route.continue();
    });
    try {
      await fixture.page.getByRole("button", { name: "Refresh policy review", exact: true }).click();
      await fixture.page.getByRole("alert").filter({ hasText: "independent opening policy failure" }).waitFor({ state: "visible", timeout: 15_000 });
      await fixture.page.waitForTimeout(750);
      expect(failures).toBe(1);
      expect(await fixture.page.getByRole("button", { name: "List", exact: true }).count()).toBe(0);
      await fixture.page.getByRole("button", { name: "Try again", exact: true }).press("Enter");
      await fixture.page.getByRole("button", { name: "List", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      holdPolicy = true;
      await fixture.page.locator("details.workflow-details > summary").filter({ hasText: "Listing details" }).click();
      await fixture.page.getByRole("button", { name: "Refresh policy review", exact: true }).click();
      await expect.poll(() => held.length, { timeout: 5_000 }).toBeGreaterThan(0);
      await fixture.switchAccount(chain.stranger);
      for (const release of held.splice(0)) release();
      holdPolicy = false;
      await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet.", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      await fixture.page.waitForTimeout(500);
      expect(await fixture.page.getByRole("button", { name: "List", exact: true }).count()).toBe(0);
    } finally {
      holdPolicy = false;
      for (const release of held.splice(0)) release();
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 60_000);
});
