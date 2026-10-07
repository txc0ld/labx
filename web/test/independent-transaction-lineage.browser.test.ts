import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import type { Hex } from "viem";
import { hash } from "../lib/chain/validation";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_INDEPENDENT_TRANSACTION_LINEAGE_BROWSER === "1" ? describe : describe.skip;

run("rendered cross-tab replacement lineage on isolated Anvil", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let tabA: Page;
  let tabB: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    chain = await localChain();
    await chain.write(chain.nft, "mint", [chain.seller, 9101n]);
    fixture = await browserChain(chain, chain.seller, false);
    tabA = fixture.page;
    tabB = await fixture.context.newPage();
    for (const page of [tabA, tabB]) page.on("pageerror", error => pageErrors.push(error.message));
    await tabA.setViewportSize({ width: 390, height: 844 });
    await tabB.setViewportSize({ width: 1440, height: 900 });
    await tabA.clock.install({ time: new Date() });
  }, 60_000);

  afterAll(async () => {
    await chain?.rpc("evm_setAutomine", [true]).catch(() => undefined);
    await fixture?.close();
    chain?.close();
  });

  async function openSeller(page: Page) {
    const response = await page.goto(`${fixture.baseUrl}/seller`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await page.locator("summary").filter({ hasText: "Prepare a draft" }).waitFor({ state: "visible", timeout: 15_000 });
  }

  async function prepareDraft(page: Page) {
    const summary = page.locator("summary").filter({ hasText: "Prepare a draft" });
    await summary.click();
    const block = await chain.client.getBlock();
    await page.getByLabel("Raffle title").fill("Rendered replacement lineage");
    await page.getByLabel("NFT contract").fill(chain.nft.address);
    await page.getByLabel("Token ID").fill("9101");
    await page.getByLabel("Sales deadline in UTC").fill(new Date(Number(block.timestamp + 3600n) * 1000).toISOString().slice(0, 16));
    await page.getByLabel("Public commitment note").fill("Rendered public replacement lineage");
    await page.getByLabel("Private commitment").fill("Rendered private replacement lineage");
    await page.getByLabel("Name", { exact: true }).fill("Entry");
    await page.getByLabel("Price in USDC", { exact: true }).fill("1");
    await page.getByLabel("Bonus entries", { exact: true }).fill("1");
    await page.getByLabel("Supply", { exact: true }).fill("10");
    await page.getByRole("button", { name: "Review raffle draft", exact: true }).click();
    await page.getByRole("button", { name: "Sign and save commitment", exact: true }).click();
    await page.getByRole("button", { name: "Create raffle draft", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("button", { name: "Create raffle draft", exact: true }).click();
    await page.locator(".transaction-review").getByRole("button", { name: "Confirm create raffle draft", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  }

  function transactionHash(text: string): Hex {
    const value = text.match(/0x[0-9a-fA-F]{64}/)?.[0];
    if (!value) throw new Error(`Transaction hash missing from rendered outcome: ${text}`);
    return hash(value);
  }

  it("keeps a prehydrated tab and stale seller check on canonical H2 without an orphan", async () => {
    // Tab B owns an already-hydrated empty outcome store before tab A submits H1.
    await openSeller(tabB);
    await openSeller(tabA);
    await prepareDraft(tabA);
    await chain.rpc("evm_setAutomine", [false]);

    await tabA.locator(".transaction-review").getByRole("button", { name: "Confirm create raffle draft", exact: true }).click();
    const submitted = tabA.locator(".resume-transaction .transaction-outcome", { hasText: "Transaction submitted" });
    await submitted.waitFor({ state: "visible", timeout: 10_000 });
    const h1 = transactionHash(await submitted.innerText());

    // Expire only tab A's real confirmation watcher; the on-chain transaction remains unmined.
    await tabA.clock.fastForward(61_000);
    const staleCheck = tabA.getByRole("button", { name: "Check confirmation", exact: true }).last();
    await staleCheck.waitFor({ state: "visible", timeout: 10_000 });

    const original = await chain.client.getTransaction({ hash: h1 });
    const h2 = hash(await chain.rpc("eth_sendTransaction", [{
      from: chain.seller,
      to: chain.seller,
      nonce: `0x${original.nonce.toString(16)}`,
      gasPrice: "0xb2d05e00",
      gas: "0x989680",
      value: "0x0",
      data: "0x"
    }]));
    await chain.mine();
    await chain.mine();

    const profile = await tabB.goto(`${fixture.baseUrl}/profile`, { waitUntil: "domcontentloaded" });
    expect(profile?.status()).toBe(200);
    const connectProfile = tabB.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connectProfile.isVisible().catch(() => false)) await connectProfile.click();
    const tabBRecovery = tabB.locator(".resume-transaction form");
    await tabBRecovery.waitFor({ state: "visible", timeout: 10_000 });
    await tabBRecovery.getByLabel("Transaction hash").fill(h2);
    await tabBRecovery.getByRole("button", { name: "Check transaction", exact: true }).click();
    const canonicalB = tabB.locator(".resume-transaction .transaction-outcome", { hasText: h2 });
    await canonicalB.getByText("Transaction replaced", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });

    await staleCheck.click();
    const staleResult = tabA.locator(".transaction-state", { hasText: h2 });
    await staleResult.getByText("Transaction replaced", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await tabA.getByRole("button", { name: "Confirm create raffle draft", exact: true }).count()).toBe(0);
    await tabA.getByRole("button", { name: "Review again", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    const checkpoints = await tabA.evaluate(account => Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return key === null ? null : [key, localStorage.getItem(key) ?? ""] as const;
    }).filter((entry): entry is readonly [string, string] => entry !== null
      && entry[0].startsWith("labx:outcome:")
      && entry[0].includes(account.toLowerCase())), chain.seller);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.[0]).toContain(chain.seller.toLowerCase());
    expect(checkpoints[0]?.[1].toLowerCase()).toContain(h2.toLowerCase());

    await tabA.reload({ waitUntil: "domcontentloaded" });
    const reloaded = tabA.locator(".resume-transaction .transaction-outcome", { hasText: h2 });
    await reloaded.getByText("Transaction replaced", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await tabA.getByText(/Saved transaction needs verification|Transaction needs attention/).count()).toBe(0);
    expect(await tabA.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await reloaded.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds && bounds.x >= -1 && bounds.x + bounds.width <= 391).toBe(true);
    const dismiss = reloaded.getByRole("button", { name: "Dismiss receipt", exact: true });
    await dismiss.waitFor({ state: "visible", timeout: 10_000 });
    expect(await dismiss.isEnabled()).toBe(true);
    expect(pageErrors).toEqual([]);
  }, 120_000);
});
