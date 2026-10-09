import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_WALLET_RESTORE_BROWSER === "1" ? describe : describe.skip;
run("seller wallet restoration across a real page reload", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  beforeAll(async () => {
    chain = await localChain();
    fixture = await browserChain(chain);
    await fixture.page.context().addInitScript(() => {
      type Provider = { request(input: { method: string }): Promise<unknown> };
      const target = window as unknown as { ethereum?: Provider; __restoreRequests: string[] };
      target.__restoreRequests = [];
      const wrap = (provider: Provider | undefined) => {
        if (!provider) return provider;
        const request = provider.request.bind(provider);
        provider.request = input => { target.__restoreRequests.push(input.method); return request(input); };
        return provider;
      };
      let current = wrap(target.ethereum);
      Object.defineProperty(window, "ethereum", { configurable: true, get: () => current, set: (value: Provider) => { current = wrap(value); } });
    });
  }, 90_000);
  afterAll(async () => { await fixture?.close(); chain?.close(); });
  it("restores the seller twice with only account/network reads, then honors revoked consent on reload", async () => {
    const page = fixture.page;
    await page.goto(`${fixture.baseUrl}/seller`);
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    await page.locator(".wallet-identity").waitFor({ timeout: 15_000 });
    const identity = await page.locator(".wallet-identity").textContent();
    for (let reload = 0; reload < 2; reload++) {
      await page.reload();
      await page.locator(".wallet-identity").waitFor({ timeout: 15_000 });
      expect(await page.locator(".wallet-identity").textContent()).toBe(identity);
      const calls = await page.evaluate(() => (window as unknown as { __restoreRequests: string[] }).__restoreRequests);
      expect(calls.length).toBeGreaterThanOrEqual(4);
      expect(calls.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
    }
    // The session's explicit-disconnect tests cover revocation; this verifies the
    // persisted result is honored by the actual startup module on the next load.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("labx:wallet-consent:v1:")) localStorage.removeItem(key);
    });
    await page.reload();
    await page.getByRole("button", { name: "Connect wallet", exact: true }).waitFor();
    expect(await page.locator(".wallet-identity").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __restoreRequests: string[] }).__restoreRequests)).toEqual([]);
  }, 90_000);
});
