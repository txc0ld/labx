import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { connectWallet } from "./fixtures/connect-wallet";
import { hash } from "../lib/chain/validation";
import { raffleAbi } from "../lib/chain/abi";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { fillStandardMembershipEconomics } from "./fixtures/membership-tiers";

const run = process.env.RUN_INDEPENDENT_TRANSACTION_LINEAGE_BROWSER === "1" ? describe : describe.skip;

run("rendered creation replacement lineage on isolated Anvil", () => {
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
    await connectWallet(page, page.locator("summary").filter({ hasText: /Create a raffle|Prepare a draft/ }));
  }

  async function fillDraft(page: Page) {
    await page.locator("summary").filter({ hasText: /Create a raffle|Prepare a draft/ }).click();
    const block = await chain.client.getBlock();
    await page.getByLabel("Raffle title").fill("Rendered replacement lineage");
    await page.getByLabel("NFT contract").fill(chain.nft.address);
    await page.getByLabel("Token ID").fill("9101");
    await page.getByLabel("Sales deadline in UTC").fill(new Date(Number(block.timestamp + 3600n) * 1000).toISOString().slice(0, 16));
    await fillStandardMembershipEconomics(page, () => ({ price: "1", bonusEntries: "1", supply: "10" }));
  }

  it("keeps a replaced Create step recoverable and never starts another send on reload", async () => {
    await openSeller(tabB);
    await openSeller(tabA);
    await fillDraft(tabA);
    await chain.rpc("evm_setAutomine", [false]);
    await tabA.getByRole("button", { name: "Create", exact: true }).click();

    const readJournal = () => tabA.evaluate(account => {
      const key = Object.keys(localStorage).find(candidate => candidate.startsWith("labx:pending:v1:") && candidate.includes(account.toLowerCase()));
      return key ? localStorage.getItem(key) : null;
    }, chain.seller);
    await expect.poll(readJournal, { timeout: 15_000 }).toMatch(/^\{.+\}$/);
    const journal = await readJournal();
    if (journal === null) throw new Error("Pending Create journal missing.");
    const parsed: unknown = JSON.parse(journal);
    if (!parsed || typeof parsed !== "object" || !("hash" in parsed) || typeof parsed.hash !== "string") throw new Error("Submitted Create hash missing.");
    const h1 = hash(parsed.hash);

    const original = await chain.client.getTransaction({ hash: h1 });
    const h2 = hash(await chain.rpc("eth_sendTransaction", [{ from: chain.seller, to: chain.seller, nonce: `0x${original.nonce.toString(16)}`, gasPrice: "0xb2d05e00", gas: "0x989680", value: "0x0", data: "0x" }]));
    await chain.mine();
    await chain.mine();
    await tabA.clock.fastForward(121_000);
    await tabA.getByRole("alert").filter({ hasText: /Creation stopped|canonical confirmation|replaced/ }).waitFor({ state: "visible", timeout: 15_000 });

    const createRecord = await tabA.evaluate(account => {
      const key = Object.keys(localStorage).find(candidate => candidate.startsWith("labx:create:v1:") && candidate.endsWith(account.toLowerCase()));
      return key ? localStorage.getItem(key) : null;
    }, chain.seller);
    expect(createRecord).not.toBeNull();
    expect(createRecord?.toLowerCase()).toContain(h1.toLowerCase());
    expect(createRecord?.toLowerCase()).not.toContain(h2.toLowerCase());
    expect(await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" })).toBe(1n);

    await tabA.reload({ waitUntil: "domcontentloaded" });
    await tabA.getByRole("button", { name: "Create", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await tabA.evaluate(() => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Scope = Window & { ethereum: { request: Request }; __lineageReloadSends: number };
      const scope = window as unknown as Scope;
      const originalRequest = scope.ethereum.request.bind(scope.ethereum);
      scope.__lineageReloadSends = 0;
      scope.ethereum.request = input => { if (input.method === "eth_sendTransaction") scope.__lineageReloadSends += 1; return originalRequest(input); };
    });
    await tabA.waitForTimeout(750);
    expect(await tabA.evaluate(() => (window as unknown as Window & { __lineageReloadSends: number }).__lineageReloadSends)).toBe(0);
    expect(await tabA.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  }, 150_000);
});
