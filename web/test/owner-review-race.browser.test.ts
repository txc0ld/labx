import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import type { Route } from "playwright";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_OWNER_REVIEW_RACE_BROWSER === "1" ? describe : describe.skip;

run("owner review async lifetimes", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    const commitment = keccak256(toBytes("owner-review-race"));
    await chain.write(chain.nft, "mint", [chain.seller, 771n]);
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      771n,
      block.timestamp + 86_400n,
      commitment,
      commitment,
      "Owner review race",
      [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 771n], chain.seller);
    await chain.write(chain.raffle, "escrow", [1n], chain.seller);
    fixture = await browserChain(chain, chain.operator);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  async function openChecklist() {
    const response = await fixture.page.goto(`${fixture.baseUrl}/review/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    const review = fixture.page.getByRole("button", { name: "Review approval checklist", exact: true });
    await review.waitFor({ state: "visible", timeout: 10_000 });
    await review.click();
    for (const checkbox of await fixture.page.locator("fieldset input[type=checkbox]").all()) await checkbox.check();
  }

  async function prepareExport() {
    await fixture.page.getByRole("button", { name: "Prepare exact approval", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Execute the reviewed call in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  }

  it("does not resurrect a discarded export when an older clipboard write completes", async () => {
    await openChecklist();
    await prepareExport();
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("heading", { name: "Execute the reviewed call in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.evaluate(() => {
      let resolveCopy: (() => void) | undefined;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => new Promise<void>(resolve => { resolveCopy = resolve; }) }
      });
      (window as unknown as Window & { __resolveOwnerCopy(): void }).__resolveOwnerCopy = () => resolveCopy?.();
    });

    await fixture.page.getByRole("button", { name: "Copy exact call fields", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Discard exported review", exact: true }).click();
    await fixture.page.evaluate(() => (window as unknown as Window & { __resolveOwnerCopy(): void }).__resolveOwnerCopy());

    await fixture.page.getByRole("heading", { name: "Choose the current draft action", exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    await fixture.page.getByRole("button", { name: "Review approval checklist", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Approval checklist", exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    expect(await fixture.page.getByRole("heading", { name: "Execute the reviewed call in Safe", exact: true }).count()).toBe(0);
  }, 30_000);

  it("does not persist a delayed export after the wallet session changes", async () => {
    await openChecklist();
    await fixture.page.evaluate(() => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Scope = Window & {
        ethereum: { request: Request };
        __ownerHeldCalls: number;
        __stopHoldingOwnerCalls(): void;
        __releaseOwnerCalls(): void;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      const held: { input: { method: string; params?: readonly unknown[] }; resolve(value: unknown): void; reject(error: unknown): void }[] = [];
      let holding = true;
      scope.__ownerHeldCalls = 0;
      scope.ethereum.request = input => {
        if (!holding || input.method !== "eth_accounts") return original(input);
        scope.__ownerHeldCalls += 1;
        return new Promise((resolve, reject) => held.push({ input, resolve, reject }));
      };
      scope.__stopHoldingOwnerCalls = () => { holding = false; };
      scope.__releaseOwnerCalls = () => {
        holding = false;
        for (const call of held.splice(0)) void original(call.input).then(call.resolve, call.reject);
      };
    });

    await fixture.page.getByRole("button", { name: "Prepare exact approval", exact: true }).click();
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __ownerHeldCalls: number }).__ownerHeldCalls), { timeout: 5_000 }).toBeGreaterThan(0);
    await fixture.page.evaluate(() => (window as unknown as Window & { __stopHoldingOwnerCalls(): void }).__stopHoldingOwnerCalls());
    await fixture.page.getByRole("link", { name: "Back to review queue", exact: true }).click();
    await fixture.page.waitForURL("**/review");
    await fixture.page.getByRole("heading", { name: "Review the exact draft before approval.", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.evaluate(() => (window as unknown as Window & { __releaseOwnerCalls(): void }).__releaseOwnerCalls());

    await fixture.page.waitForTimeout(500);
    const stored = await fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:owner-review:v1:")));
    expect(stored).toEqual([]);
    expect(fixture.page.url()).toMatch(/\/review$/);
  }, 30_000);

  it("does not let a delayed confirmation mutate storage or refresh an old route", async () => {
    await openChecklist();
    await prepareExport();
    const review = await chain.service.readAdmission({ id: 1n });
    if (review.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    const receipt = await chain.write(chain.raffle, "approveRaffle", [1n, review.snapshot.admission.reviewHash]);
    await chain.mine();
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);

    const held: Route[] = [];
    let holding = true;
    await fixture.page.route(`${chain.url}/`, async route => {
      if (holding) {
        held.push(route);
        return;
      }
      await route.continue();
    });
    await fixture.page.getByRole("button", { name: "Confirm canonical execution", exact: true }).click();
    await expect.poll(() => held.length, { timeout: 5_000 }).toBeGreaterThan(0);
    holding = false;
    await fixture.page.getByRole("link", { name: "Back to review queue", exact: true }).click();
    await fixture.page.waitForURL("**/review");
    await Promise.all(held.splice(0).map(route => route.continue()));
    await fixture.page.unroute(`${chain.url}/`);

    await fixture.page.waitForTimeout(500);
    const stored = await fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:owner-review:v1:")));
    expect(stored).toHaveLength(1);
    expect(fixture.page.url()).toMatch(/\/review$/);
  }, 30_000);

  it("reloads an executed revocation only as receipt confirmation recovery", async () => {
    await fixture.page.evaluate(() => localStorage.clear());
    const response = await fixture.page.goto(`${fixture.baseUrl}/review/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const prepare = fixture.page.getByRole("button", { name: "Prepare revocation", exact: true });
    await prepare.waitFor({ state: "visible", timeout: 10_000 });
    await prepare.click();
    await fixture.page.getByRole("button", { name: "Prepare exact revocation", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Execute the reviewed call in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    const review = await chain.service.readAdmission({ id: 1n });
    if (review.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    const receipt = await chain.write(chain.raffle, "revokeRaffleApproval", [1n, review.snapshot.admission.reviewHash]);
    await chain.mine();
    await fixture.page.getByRole("button", { name: "Refresh exact state", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Confirm the recorded revocation", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });

    await fixture.page.getByRole("heading", { name: "Confirm the recorded revocation", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByRole("button", { name: "Copy exact call fields", exact: true }).count()).toBe(0);
    expect(await fixture.page.getByRole("link", { name: /Open owner Safe/ }).count()).toBe(0);
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);
    await fixture.page.getByRole("button", { name: "Confirm recorded revocation", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Approval revoked", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    const stored = await fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:owner-review:v1:")));
    expect(stored).toEqual([]);
  }, 30_000);
});
