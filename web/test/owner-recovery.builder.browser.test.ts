import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
const run = process.env.RUN_OWNER_RECOVERY_BROWSER === "1" ? describe : describe.skip;
run("explicit Advanced owner recovery", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    const hash = keccak256(toBytes("owner recovery"));
    for (const id of [1n, 2n, 3n, 4n]) {
      await chain.write(chain.nft, "mint", [chain.seller, 940n + id]);
      await chain.write(chain.raffle, "createRaffle", [chain.nft.address, 940n + id, block.timestamp + 86_400n, hash, hash, `Recovery ${id}`, [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]], chain.seller);
      await chain.write(chain.nft, "approve", [chain.raffle.address, 940n + id], chain.seller);
      await chain.write(chain.raffle, "escrow", [id], chain.seller);
    }
    fixture = await browserChain(chain, chain.operator);
  }, 90_000);
  afterAll(async () => { await fixture?.close(); chain?.close(); });
  const storageKey = (id: number) => `labx:owner-review:v1:31337:${chain.raffle.address.toLowerCase()}:${chain.manifest.runtimeCodeHash}:${chain.operator.toLowerCase()}:${id}`;
  async function saved(id: number) { return fixture.page.evaluate(key => localStorage.getItem(key), storageKey(id)); }
  async function connect() {
    const button = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    await expect.poll(async () => await button.isVisible() || await fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true }).isVisible(), { timeout: 15_000 }).toBe(true);
    if (await button.isVisible()) await button.click();
  }
  async function proposal(id: number) {
    await fixture.page.goto(`${fixture.baseUrl}/review/${id}`);
    await connect();
    await fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true }).waitFor();
    await fixture.page.evaluate(() => {
      const w = window as unknown as { ethereum: { request(input: { method: string }): Promise<unknown> }; ownerSends: number };
      const request = w.ethereum.request.bind(w.ethereum);
      w.ownerSends = 0;
      w.ethereum.request = async input => { if (input.method === "eth_sendTransaction") { w.ownerSends++; return `0x${"ab".repeat(32)}`; } return request(input); };
    });
    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor();
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as { ownerSends: number }).ownerSends)).toBe(1);
  }
  async function advanced() {
    const details = fixture.page.locator("details").filter({ has: fixture.page.getByText("Advanced recovery", { exact: true }) });
    if (!await details.getAttribute("open").then(value => value !== null)) await details.locator("summary").click();
    const button = fixture.page.getByRole("button", { name: "Review and download call", exact: true });
    await expect.poll(() => button.isEnabled()).toBe(true);
    return button;
  }
  it("downloads after reload while preserving the original observation block", async () => {
    await proposal(1);
    const original = await saved(1);
    await fixture.page.reload();
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor();
    await chain.mine();
    const button = await advanced();
    expect(await fixture.page.getByText(/By clicking Review and download call/).isVisible()).toBe(true);
    const downloaded = fixture.page.waitForEvent("download");
    await button.click();
    expect((await downloaded).suggestedFilename()).toMatch(/^labx-approve-raffle-1-/);
    expect(await saved(1)).toBe(original);
    expect(await fixture.page.getByRole("button", { name: "Approve", exact: true }).count()).toBe(0);
  }, 45_000);
  it("preserves uncertain history on failed storage then archives it before downloading the changed current digest", async () => {
    const original = await saved(1);
    const review = await chain.service.readAdmission({ id: 1n });
    const r = review.snapshot.raffle;
    await chain.write(chain.raffle, "updateDraft", [1n, r.nft, r.tokenId, r.salesEnd, r.reserveNonce, r.reserveCommit, "Changed recovery draft", review.snapshot.packs], chain.seller);
    await fixture.page.getByRole("button", { name: "Refresh exact state", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Changed recovery draft", exact: true }).waitFor();
    let downloads = 0;
    const count = () => { downloads++; };
    fixture.page.on("download", count);
    await fixture.page.evaluate(() => {
      const originalSet = Storage.prototype.setItem;
      (window as unknown as { restoreStorage(): void }).restoreStorage = () => { Storage.prototype.setItem = originalSet; };
      Storage.prototype.setItem = function(key, value) { if (key.includes(":history:")) throw new Error("Archive storage refused"); originalSet.call(this, key, value); };
    });
    await (await advanced()).click();
    await fixture.page.getByText("Archive storage refused", { exact: true }).waitFor();
    expect(downloads).toBe(0); expect(await saved(1)).toBe(original);
    await fixture.page.evaluate(() => (window as unknown as { restoreStorage(): void }).restoreStorage());
    const downloaded = fixture.page.waitForEvent("download");
    await (await advanced()).click(); await downloaded;
    const current = await saved(1);
    expect(current).not.toBe(original);
    const archives = await fixture.page.evaluate(key => Object.keys(localStorage).filter(item => item.startsWith(`${key}:history:`)).map(item => localStorage.getItem(item)), storageKey(1));
    expect(archives).toContain(original);
    fixture.page.off("download", count);
  }, 45_000);
  it("does not download or replace recovery when the wallet changes during preparation", async () => {
    const original = await saved(1);
    let release = () => {};
    let held = false;
    await fixture.page.route(`${chain.url}/`, async route => {
      const body = route.request().postDataJSON() as { method?: string };
      if (body.method === "eth_call" && !held) { held = true; await new Promise<void>(resolve => { release = resolve; }); }
      await route.continue();
    });
    let downloads = 0;
    const count = () => { downloads++; };
    fixture.page.on("download", count);
    await (await advanced()).click();
    await expect.poll(() => held).toBe(true);
    await fixture.switchAccount(chain.stranger);
    release();
    await fixture.page.getByRole("heading", { name: "Connect the Safe to LABx", exact: true }).waitFor();
    expect(downloads).toBe(0); expect(await saved(1)).toBe(original);
    await fixture.page.unroute(`${chain.url}/`); fixture.page.off("download", count);
    await fixture.switchAccount(chain.operator);
  }, 45_000);
  it("gives manual confirmation priority over deferred discovery and ignores the late discovery result", async () => {
    await proposal(2);
    const heading = fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true });
    await expect.poll(() => heading.locator("../..").getAttribute("aria-busy")).toBe("false");
    await fixture.page.getByText("Advanced: executed Ethereum transaction hash", { exact: true }).click();
    const review = await chain.service.readAdmission({ id: 2n });
    const receipt = await chain.write(chain.raffle, "approveRaffle", [2n, review.snapshot.admission.reviewHash]);
    await chain.mine(); await chain.mine();
    let release = () => {};
    let held = false;
    let handled = false;
    await fixture.page.route(`${chain.url}/`, async route => {
      const body = route.request().postDataJSON() as { method?: string; id: number };
      if (body.method !== "eth_getLogs" || held) return route.continue();
      held = true;
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }) });
      handled = true;
    });
    await fixture.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => held).toBe(true);
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);
    const confirm = fixture.page.getByRole("button", { name: "Confirm canonical execution", exact: true });
    expect(await confirm.isEnabled()).toBe(true);
    await confirm.click();
    const recorded = fixture.page.getByRole("heading", { name: "Approval recorded", exact: true });
    await recorded.waitFor({ timeout: 15_000 });
    release(); await expect.poll(() => handled).toBe(true); await fixture.page.unroute(`${chain.url}/`);
    expect(await recorded.isVisible()).toBe(true); expect(await saved(2)).toBeNull();
  }, 45_000);
  it("preserves a second tab's manual export after the original wallet rejects late", async () => {
    const page = fixture.page;
    await page.goto(`${fixture.baseUrl}/review/3`);
    await connect();
    await page.getByRole("heading", { name: "Approve this raffle", exact: true }).waitFor();
    await page.evaluate(() => {
      const w = window as unknown as { ethereum: { request(input: { method: string }): Promise<unknown> }; rejectOwnerRequest?: () => void };
      const request = w.ethereum.request.bind(w.ethereum);
      w.ethereum.request = input => input.method === "eth_sendTransaction" ? new Promise((_resolve, reject) => { w.rejectOwnerRequest = () => reject(Object.assign(new Error("Late wallet rejection"), { code: 4001 })); }) : request(input);
    });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor();
    await page.waitForFunction(() => typeof (window as unknown as { rejectOwnerRequest?: unknown }).rejectOwnerRequest === "function");
    const original = await saved(3);
    const other = await page.context().newPage();
    try {
      await other.goto(`${fixture.baseUrl}/review/3`);
      await other.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor();
      await other.getByText("Advanced recovery", { exact: true }).click();
      const button = other.getByRole("button", { name: "Review and download call", exact: true });
      await expect.poll(() => button.isEnabled()).toBe(true);
      const downloaded = other.waitForEvent("download");
      await button.click(); await downloaded;
      expect(await saved(3)).toBe(original);
      expect(await other.evaluate(key => localStorage.getItem(`${key}:manual-exposure`), storageKey(3))).not.toBeNull();
      await page.evaluate(() => (window as unknown as { rejectOwnerRequest(): void }).rejectOwnerRequest());
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await saved(3)).toBe(original);
      expect(await page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).isVisible()).toBe(true);
      await other.reload();
      await other.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor();
      expect(await saved(3)).toBe(original);
    } finally { await other.close(); }
  }, 45_000);

  it("retires a definite rejection with no manual exposure so explicit retry remains available", async () => {
    const page = fixture.page;
    await page.goto(`${fixture.baseUrl}/review/4`); await connect();
    await page.getByRole("heading", { name: "Approve this raffle", exact: true }).waitFor();
    await page.evaluate(() => {
      const w = window as unknown as { ethereum: { request(input: { method: string }): Promise<unknown> } };
      const request = w.ethereum.request.bind(w.ethereum);
      w.ethereum.request = async input => { if (input.method === "eth_sendTransaction") throw Object.assign(new Error("Rejected"), { code: 4001 }); return request(input); };
    });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByRole("heading", { name: "Owner action unavailable", exact: true }).waitFor();
    expect(await saved(4)).toBeNull();
    await page.getByRole("button", { name: "Return to owner actions", exact: true }).click();
    expect(await page.getByRole("button", { name: "Approve", exact: true }).isEnabled()).toBe(true);
  }, 30_000);

  it("keeps file-based revocation import instructions after download and reload", async () => {
    const page = fixture.page;
    await page.goto(`${fixture.baseUrl}/review/2`);
    const prepare = page.getByRole("button", { name: "Prepare revocation", exact: true });
    await prepare.waitFor(); await prepare.click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download revocation file", exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/revoke/);
    await page.getByRole("heading", { name: "Finish the revocation in Safe", exact: true }).waitFor();
    const instructions = page.getByText(/import the downloaded JSON file with Transaction Builder/);
    expect(await instructions.isVisible()).toBe(true);
    expect(await page.getByText(/Complete the signatures and execution in your connected Safe/).count()).toBe(0);
    await page.reload();
    await page.getByRole("heading", { name: "Finish the revocation in Safe", exact: true }).waitFor();
    expect(await instructions.isVisible()).toBe(true);
    const again = page.waitForEvent("download");
    await (await advanced()).click(); await again;
  }, 30_000);

});
