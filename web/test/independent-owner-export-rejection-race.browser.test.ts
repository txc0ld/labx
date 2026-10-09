import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_INDEPENDENT_OWNER_EXPORT_REJECTION_RACE === "1" ? describe : describe.skip;

run("manual Safe export versus deferred provider rejection", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    const commitment = keccak256(toBytes("independent-owner-export-rejection"));
    await chain.write(chain.nft, "mint", [chain.seller, 9_901n]);
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      9_901n,
      block.timestamp + 86_400n,
      commitment,
      commitment,
      "Owner export rejection race",
      [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 9_901n], chain.seller);
    await chain.write(chain.raffle, "escrow", [1n], chain.seller);
    fixture = await browserChain(chain, chain.operator);
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  it("keeps the persisted exact intent after a manual export even when the original provider later rejects", async () => {
    await fixture.page.goto(`${fixture.baseUrl}/review/1`);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    const approvalHeading = fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true });
    await expect.poll(async () => await connect.isVisible().catch(() => false) || await approvalHeading.isVisible().catch(() => false), { timeout: 15_000 }).toBe(true);
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await approvalHeading.waitFor({ timeout: 15_000 });
    await fixture.page.evaluate(() => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Scope = Window & {
        ethereum: { request: Request };
        __independentRejectOwnerSend(): void;
        __independentOwnerSends: number;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      let rejectSend: ((reason: unknown) => void) | undefined;
      scope.__independentOwnerSends = 0;
      scope.__independentRejectOwnerSend = () => rejectSend?.(Object.assign(new Error("late provider rejection"), { code: 4001 }));
      scope.ethereum.request = input => {
        if (input.method !== "eth_sendTransaction") return original(input);
        scope.__independentOwnerSends++;
        return new Promise((_resolve, reject) => { rejectSend = reject; });
      };
    });

    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ timeout: 15_000 });
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __independentOwnerSends: number }).__independentOwnerSends)).toBe(1);
    const storageKey = `labx:owner-review:v1:31337:${chain.raffle.address.toLowerCase()}:${chain.manifest.runtimeCodeHash}:${chain.operator.toLowerCase()}:1`;
    const beforeExport = await fixture.page.evaluate(key => localStorage.getItem(key), storageKey);
    expect(beforeExport).not.toBeNull();

    const advanced = fixture.page.locator("details").filter({ hasText: "Advanced recovery" });
    await advanced.locator("summary").click();
    const downloaded = fixture.page.waitForEvent("download");
    await fixture.page.getByRole("button", { name: "Review and download call", exact: true }).click();
    await downloaded;
    expect(await fixture.page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(beforeExport);

    await fixture.page.evaluate(() => (window as unknown as Window & { __independentRejectOwnerSend(): void }).__independentRejectOwnerSend());
    await fixture.page.waitForTimeout(250);

    expect(await fixture.page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(beforeExport);
    expect(await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).isVisible()).toBe(true);
    expect(await fixture.page.getByRole("button", { name: "Approve", exact: true }).count()).toBe(0);
  }, 45_000);

  it("retires an exact persisted intent when the session changes before the provider is reached", async () => {
    await fixture.page.goto(`${fixture.baseUrl}/review/1`, { waitUntil: "domcontentloaded" });
    await fixture.switchAccount(chain.operator);
    await fixture.page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("labx:owner-review:")) localStorage.removeItem(key);
    });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    const approvalHeading = fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true });
    await expect.poll(async () => await connect.isVisible().catch(() => false) || await approvalHeading.isVisible().catch(() => false), { timeout: 15_000 }).toBe(true);
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await approvalHeading.waitFor({ timeout: 15_000 });
    const storageKey = `labx:owner-review:v1:31337:${chain.raffle.address.toLowerCase()}:${chain.manifest.runtimeCodeHash}:${chain.operator.toLowerCase()}:1`;
    await fixture.page.evaluate(({ buyer, storageKey }) => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Scope = Window & {
        ethereum: { request: Request };
        __labxSetAccount(next: string): Promise<void>;
        __independentOwnerPredispatchSends: number;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      let invalidated = false;
      scope.__independentOwnerPredispatchSends = 0;
      scope.ethereum.request = async input => {
        if (input.method === "eth_sendTransaction") {
          scope.__independentOwnerPredispatchSends += 1;
          return original(input);
        }
        if (input.method === "eth_accounts" && !invalidated && localStorage.getItem(storageKey) !== null) {
          invalidated = true;
          await scope.__labxSetAccount(buyer);
          return [buyer];
        }
        return original(input);
      };
    }, { buyer: chain.buyer, storageKey });

    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __independentOwnerPredispatchSends: number }).__independentOwnerPredispatchSends), { timeout: 10_000 }).toBe(0);
    await fixture.page.waitForTimeout(500);

    expect(await fixture.page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __independentOwnerPredispatchSends: number }).__independentOwnerPredispatchSends)).toBe(0);
  }, 45_000);

  it("recovers its controls when the handoff marker succeeds but primary intent storage fails before dispatch", async () => {
    await fixture.page.goto(`${fixture.baseUrl}/review/1`, { waitUntil: "domcontentloaded" });
    await fixture.switchAccount(chain.operator);
    await fixture.page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("labx:owner-review:")) localStorage.removeItem(key);
    });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    const approvalHeading = fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true });
    await expect.poll(async () => await connect.isVisible().catch(() => false) || await approvalHeading.isVisible().catch(() => false), { timeout: 15_000 }).toBe(true);
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await approvalHeading.waitFor({ timeout: 15_000 });
    const storageKey = `labx:owner-review:v1:31337:${chain.raffle.address.toLowerCase()}:${chain.manifest.runtimeCodeHash}:${chain.operator.toLowerCase()}:1`;
    await fixture.page.evaluate(storageKey => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Scope = Window & {
        ethereum: { request: Request };
        __independentOwnerStorageFailureSends: number;
        __restoreOwnerStorage(): void;
      };
      const scope = window as unknown as Scope;
      const request = scope.ethereum.request.bind(scope.ethereum);
      scope.__independentOwnerStorageFailureSends = 0;
      scope.ethereum.request = input => {
        if (input.method === "eth_sendTransaction") scope.__independentOwnerStorageFailureSends += 1;
        return request(input);
      };
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === storageKey) throw new DOMException("primary owner intent storage unavailable", "QuotaExceededError");
        return setItem.call(this, key, value);
      };
      scope.__restoreOwnerStorage = () => { Storage.prototype.setItem = setItem; };
    }, storageKey);

    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await fixture.page.waitForTimeout(750);
    await fixture.page.evaluate(() => (window as unknown as Window & { __restoreOwnerStorage(): void }).__restoreOwnerStorage());

    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __independentOwnerStorageFailureSends: number }).__independentOwnerStorageFailureSends)).toBe(0);
    expect(await fixture.page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
    const directRetry = fixture.page.getByRole("button", { name: "Approve", exact: true });
    const returnToActions = fixture.page.getByRole("button", { name: "Return to owner actions", exact: true });
    await expect.poll(async () => await directRetry.isEnabled().catch(() => false) || await returnToActions.isEnabled().catch(() => false), { timeout: 5_000 }).toBe(true);
  }, 45_000);
});
