import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_INDEPENDENT_WALLET_RESTORE_BROWSER === "1" ? describe : describe.skip;

run("independent wallet reload and explicit disconnect journey", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  beforeAll(async () => {
    chain = await localChain();
    fixture = await browserChain(chain);
    await fixture.page.context().addInitScript(() => {
      type Provider = { request(input: { method: string }): Promise<unknown> };
      const target = window as unknown as { ethereum?: Provider; __independentRestoreMethods: string[] };
      target.__independentRestoreMethods = [];
      const wrap = (provider: Provider | undefined) => {
        if (!provider) return provider;
        const request = provider.request.bind(provider);
        provider.request = input => {
          target.__independentRestoreMethods.push(input.method);
          return request(input);
        };
        return provider;
      };
      let current = wrap(target.ethereum);
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        get: () => current,
        set: (provider: Provider) => { current = wrap(provider); }
      });
    });
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  it("restores after a reload with reads only, then keeps an explicit disconnect across the next reload", async () => {
    const page = fixture.page;
    await page.goto(`${fixture.baseUrl}/seller`);
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    await page.locator(".wallet-identity").waitFor({ timeout: 15_000 });
    const originalIdentity = await page.locator(".wallet-identity").textContent();

    await page.reload();
    await page.locator(".wallet-identity").waitFor({ timeout: 15_000 });
    expect(await page.locator(".wallet-identity").textContent()).toBe(originalIdentity);
    const restorationMethods = await page.evaluate(() => (window as unknown as { __independentRestoreMethods: string[] }).__independentRestoreMethods);
    expect(restorationMethods.length).toBeGreaterThanOrEqual(4);
    expect(restorationMethods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);

    await page.goto(`${fixture.baseUrl}/profile`);
    await page.getByRole("button", { name: "Disconnect wallet", exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Disconnect wallet", exact: true }).click();
    await page.getByRole("button", { name: "Connect wallet", exact: true }).waitFor();
    expect(await page.locator(".wallet-identity").count()).toBe(0);

    await page.reload();
    await page.getByRole("button", { name: "Connect wallet", exact: true }).waitFor();
    expect(await page.locator(".wallet-identity").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __independentRestoreMethods: string[] }).__independentRestoreMethods)).toEqual([]);
  }, 90_000);
});
