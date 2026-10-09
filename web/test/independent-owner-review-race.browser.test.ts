import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { connectWallet } from "./fixtures/connect-wallet";

const run = process.env.RUN_INDEPENDENT_OWNER_REVIEW_RACE_BROWSER === "1" ? describe : describe.skip;
type RpcRequest = { method: string; params?: readonly unknown[] };

run("independent owner review race verification", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    const commitment = keccak256(toBytes("independent-owner-review-race"));
    for (const id of [1n, 2n, 3n, 4n, 5n]) {
      const tokenId = 880n + id;
      await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
      await chain.write(chain.raffle, "createRaffle", [chain.nft.address, tokenId, block.timestamp + 86_400n, commitment, commitment, `Independent owner review ${id.toString()}`, [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]], chain.seller);
      await chain.write(chain.nft, "approve", [chain.raffle.address, tokenId], chain.seller);
      await chain.write(chain.raffle, "escrow", [id], chain.seller);
    }
    fixture = await browserChain(chain, chain.operator);
  }, 60_000);

  afterAll(async () => { await fixture?.close(); chain?.close(); });

  async function openApproval(id: bigint) {
    const response = await fixture.page.goto(`${fixture.baseUrl}/review/${id.toString()}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:owner-review:v1:")).forEach(key => localStorage.removeItem(key)));
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await connectWallet(fixture.page, fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true }));
    expect(await fixture.page.getByRole("checkbox").count()).toBe(0);
  }
  async function ownerStorageKeys() {
    return fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:owner-review:v1:")));
  }
  async function hideAutomaticDiscovery() {
    await fixture.page.route(`${chain.url}/`, async route => {
      const body = route.request().postDataJSON() as { id?: number; method?: string } | undefined;
      if (body?.method === "eth_getLogs") await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }) });
      else await route.continue();
    });
  }
  async function restoreAutomaticDiscovery() { await fixture.page.unroute(`${chain.url}/`); }

  it("retires a rejected pre-dispatch request and permits a fresh explicit Approve", async () => {
    await openApproval(1n);
    await fixture.page.evaluate(() => {
      type Scope = Window & { ethereum: { request(input: RpcRequest): Promise<unknown> }; __ownerRejectOnce: boolean; __ownerSends: number };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      scope.__ownerRejectOnce = true;
      scope.__ownerSends = 0;
      scope.ethereum.request = input => {
        if (input.method !== "eth_sendTransaction") return original(input);
        scope.__ownerSends += 1;
        if (scope.__ownerRejectOnce) { scope.__ownerRejectOnce = false; return Promise.reject(Object.assign(new Error("request rejected"), { code: 4001 })); }
        return original(input);
      };
    });
    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await fixture.page.getByRole("alert").filter({ hasText: /cancelled/ }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await ownerStorageKeys()).toEqual([]);
    await fixture.page.getByRole("button", { name: "Return to owner actions", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Approval recorded", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __ownerSends: number }).__ownerSends)).toBe(2);
  }, 30_000);

  it("retires a delayed request after the connected account changes", async () => {
    await openApproval(2n);
    await fixture.page.evaluate(() => {
      type Held = { input: RpcRequest; resolve(value: unknown): void; reject(reason: unknown): void };
      type Scope = Window & { ethereum: { request(input: RpcRequest): Promise<unknown> }; __ownerHeld: number; __ownerSends: number; __releaseOwner(): void };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      const held: Held[] = [];
      let holding = true;
      scope.__ownerHeld = 0;
      scope.__ownerSends = 0;
      scope.ethereum.request = input => {
        if (input.method === "eth_sendTransaction") scope.__ownerSends += 1;
        if (!holding || input.method !== "eth_accounts") return original(input);
        scope.__ownerHeld += 1;
        return new Promise((resolve, reject) => held.push({ input, resolve, reject }));
      };
      scope.__releaseOwner = () => { holding = false; for (const call of held.splice(0)) void original(call.input).then(call.resolve, call.reject); };
    });
    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __ownerHeld: number }).__ownerHeld)).toBeGreaterThan(0);
    await fixture.switchAccount(chain.stranger);
    await fixture.page.evaluate(() => (window as unknown as Window & { __releaseOwner(): void }).__releaseOwner());
    await fixture.page.getByRole("heading", { name: "Connect the Safe to LABx", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __ownerSends: number }).__ownerSends)).toBe(0);
    expect(await ownerStorageKeys()).toEqual([]);
  }, 30_000);

  it("restores an accepted Safe request only for canonical observation", async () => {
    await fixture.switchAccount(chain.operator);
    await openApproval(3n);
    await hideAutomaticDiscovery();
    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await ownerStorageKeys()).toHaveLength(1);
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.evaluate(() => {
      type Scope = Window & { ethereum: { request(input: RpcRequest): Promise<unknown> }; __ownerReloadSends: number };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      scope.__ownerReloadSends = 0;
      scope.ethereum.request = input => { if (input.method === "eth_sendTransaction") scope.__ownerReloadSends += 1; return original(input); };
    });
    await fixture.page.waitForTimeout(500);
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __ownerReloadSends: number }).__ownerReloadSends)).toBe(0);
    await restoreAutomaticDiscovery();
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("heading", { name: "Approval recorded", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await ownerStorageKeys()).toEqual([]);
  }, 30_000);

  it("reports an executed approval as stale after the draft digest changes and requires a fresh click", async () => {
    await openApproval(4n);
    await hideAutomaticDiscovery();
    await fixture.page.evaluate(() => {
      type Scope = Window & { ethereum: { request(input: RpcRequest): Promise<unknown> }; __approvalExecutionHash: string };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      scope.__approvalExecutionHash = "";
      scope.ethereum.request = async input => {
        const result = await original(input);
        if (input.method === "eth_sendTransaction" && typeof result === "string") scope.__approvalExecutionHash = result;
        return result;
      };
    });
    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __approvalExecutionHash: string }).__approvalExecutionHash), { timeout: 10_000 }).toMatch(/^0x[0-9a-f]{64}$/i);
    const executionHash = await fixture.page.evaluate(() => (window as unknown as Window & { __approvalExecutionHash: string }).__approvalExecutionHash);
    const before = await chain.service.readAdmission({ id: 4n });
    await chain.write(chain.raffle, "updateDraft", [4n, chain.nft.address, 884n, before.snapshot.raffle.salesEnd, before.snapshot.raffle.reserveNonce, before.snapshot.raffle.reserveCommit, "Changed after owner request", [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]], chain.seller);
    await restoreAutomaticDiscovery();
    await fixture.page.getByRole("button", { name: "Refresh exact state", exact: true }).click();
    await fixture.page.getByText("Advanced: executed Ethereum transaction hash", { exact: true }).click();
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(executionHash);
    await fixture.page.getByRole("button", { name: "Confirm canonical execution", exact: true }).click();
    try {
      await fixture.page.getByRole("heading", { name: "Stale at confirmation", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    } catch (error) {
      throw new Error(`Stale confirmation diagnostic: ${JSON.stringify({ executionHash, storage: await ownerStorageKeys(), admission: (await chain.service.readAdmission({ id: 4n })).snapshot.admission, rendered: await fixture.page.locator("#content").innerText() }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}`, { cause: error });
    }
    await fixture.page.getByRole("button", { name: "Review current state", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByRole("checkbox").count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Approve", exact: true }).isEnabled()).toBe(true);
  }, 30_000);

  it("keeps executed revocation recovery confirmation-only across reload", async () => {
    const review = await chain.service.readAdmission({ id: 5n });
    if (review.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    await chain.write(chain.raffle, "approveRaffle", [5n, review.snapshot.admission.reviewHash]);
    await fixture.page.goto(`${fixture.baseUrl}/review/5`, { waitUntil: "domcontentloaded" });
    await fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:owner-review:v1:")).forEach(key => localStorage.removeItem(key)));
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("button", { name: "Prepare revocation", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Download revocation file", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the revocation in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(ownerStorageKeys, { timeout: 10_000 }).toHaveLength(1);
    await hideAutomaticDiscovery();
    const current = await chain.service.readAdmission({ id: 5n });
    if (current.snapshot.admission.reviewHash === null) throw new Error("Approved review hash missing.");
    const receipt = await chain.write(chain.raffle, "revokeRaffleApproval", [5n, current.snapshot.admission.reviewHash]);
    await chain.mine();
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("heading", { name: "Confirm the recorded revocation", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByRole("button", { name: /Download (?:approval|revocation)/ }).count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Copy exact call fields", exact: true }).count()).toBe(0);
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);
    await fixture.page.getByRole("button", { name: "Confirm recorded revocation", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Approval revoked", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await restoreAutomaticDiscovery();
  }, 30_000);
});
