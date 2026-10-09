import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { workflowMessage } from "../lib/chain/messages";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { hash } from "../lib/chain/validation";
import { raffleAbi } from "../lib/chain/abi";
import { transactionIntent } from "../lib/chain/pending-journal";

const run = process.env.RUN_BROWSER_ACCEPTANCE === "1" ? describe : describe.skip;
run("activation drift beside browser recovery", () => {
  let c: LocalChain, fixture: Awaited<ReturnType<typeof browserChain>>;
  let commit: ReturnType<typeof hash>;
  beforeAll(async () => {
    c = await localChain(); fixture = await browserChain(c, c.operator);
    for (const id of [1n, 2n, 3n]) await c.write(c.nft, "mint", [c.seller, id]);
    const input = { nft: c.nft.address, tokenId: "2", publicSummary: "Activation recovery", privateCommitment: "Private activation commitment" };
    const deadline = String(Math.floor(Date.now() / 1000) + 300);
    const context = { origin: fixture.baseUrl, chainId: c.manifest.chainId, contract: c.raffle.address, termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
    const signature = await c.rpc("personal_sign", [toHex(workflowMessage("commitment", context, c.seller, input, deadline)), c.seller]);
    const response = await fetch(`${fixture.baseUrl}/api/reserve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: c.seller, input, deadline, signature }) });
    expect(response.status).toBe(200);
    const record: unknown = await response.json();
    if (!record || typeof record !== "object" || !("commit" in record) || !("nonce" in record)) throw new Error("Missing saved commitment.");
    commit = hash(record.commit);
    const now = (await c.client.getBlock()).timestamp;
    for (const id of [1n, 2n, 3n]) {
      await c.write(c.raffle, "createRaffle", [c.nft.address, id, now + 86400n, id === 2n ? hash(record.nonce) : keccak256("0x12"), id === 2n ? commit : keccak256("0x12"), `Activation ${id}`, [{ name: "Entry", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]], c.seller);
      await c.write(c.nft, "approve", [c.raffle.address, id], c.seller); await c.write(c.raffle, "escrow", [id], c.seller); if (id !== 3n) await c.admit(id);
    }
    await c.write(c.raffle, "open", [2n], c.seller);
    await c.write(c.raffle, "transferOwnership", [c.stranger]);
  }, 90_000);
  afterAll(async () => { await fixture?.close(); c?.close(); });
  async function visit(path: string, account: Address) {
    await fixture.page.goto(`${fixture.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
    await fixture.switchAccount(account);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
  }
  async function viewport(width: number) {
    await fixture.page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  it("blocks owner approval at desktop and mobile widths while allowing revocation and confirmation", async () => {
    await viewport(1440);
    await visit("/review/3", c.operator);
    await fixture.page.getByText(/reviewed deployment has a pending ownership transfer/).waitFor({ state: "visible", timeout: 15_000 });
    const approveDraft = fixture.page.getByRole("button", { name: "Review approval checklist", exact: true });
    expect(await approveDraft.isDisabled()).toBe(true);
    expect(await fixture.page.getByText(/Approval requires an escrowed NFT/).count()).toBe(0);
    await viewport(375);
    expect(await approveDraft.isDisabled()).toBe(true);
    await c.write(c.raffle, "transferOwnership", [c.operator]); await c.write(c.raffle, "acceptOwnership");
    await fixture.page.getByRole("button", { name: "Refresh exact state", exact: true }).click();
    await expect.poll(() => approveDraft.isEnabled(), { timeout: 15_000 }).toBe(true);
    await c.admit(1n); await c.write(c.raffle, "transferOwnership", [c.stranger]);
    await visit("/review/1", c.operator);
    await fixture.page.getByText(/reviewed deployment has a pending ownership transfer/).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: "Current draft approved", exact: true }).isDisabled()).toBe(true);
    expect(await fixture.page.getByRole("button", { name: "Prepare revocation", exact: true }).isEnabled()).toBe(true);
    await viewport(375);
    expect(await fixture.page.getByRole("button", { name: "Current draft approved", exact: true }).isDisabled()).toBe(true);
    await fixture.page.getByRole("button", { name: "Prepare revocation", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Download revocation file", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the revocation in Safe", exact: true }).waitFor({ timeout: 15_000 });
    const review = await c.service.readAdmission({ id: 1n });
    if (!review.snapshot.admission.reviewHash) throw new Error("Missing revocation hash.");
    const receipt = await c.write(c.raffle, "revokeRaffleApproval", [1n, review.snapshot.admission.reviewHash]); await c.mine();
    await fixture.page.getByText("I already have the executed Ethereum transaction hash", { exact: true }).click();
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);
    await fixture.page.getByRole("button", { name: "Confirm canonical execution", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Approval revoked", exact: true }).waitFor({ timeout: 15_000 });
  }, 40_000);
  it("shows purchase blocking at desktop and mobile widths beside working private recovery", async () => {
    await viewport(1440);
    await visit("/piece/2", c.buyer);
    await fixture.page.getByText(/reviewed deployment has a pending ownership transfer/).first().waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: "Approve exact USDC", exact: true }).count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).count()).toBe(0);
    await viewport(375);
    expect(await fixture.page.getByText(/Existing recovery and receipt controls remain available/).isVisible()).toBe(true);
    await visit("/seller/2", c.seller);
    await fixture.page.getByText(/Existing recovery and receipt controls remain available/).waitFor({ timeout: 15_000 });
    const recover = fixture.page.getByRole("button", { name: "Sign to recover commitment", exact: true });
    const secondary = fixture.page.locator("summary").filter({ hasText: "Other available seller actions" });
    if (!await recover.isVisible().catch(() => false) && await secondary.isVisible().catch(() => false)) await secondary.click();
    await recover.click();
    await fixture.page.getByText("Commitment recovered", { exact: true }).waitFor({ timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: "Reveal commitment", exact: true }).isEnabled()).toBe(true);
    await viewport(1440);
    expect(await fixture.page.getByRole("button", { name: "Reveal commitment", exact: true }).isEnabled()).toBe(true);
    expect((await fetch(`${fixture.baseUrl}/api/workflow/context`)).status).toBe(200);
  }, 40_000);
  it("preserves explicit approval refresh and automatic recognized-raffle refresh during cold receipt recovery", async () => {
    await c.write(c.raffle, "transferOwnership", [c.operator]); await c.write(c.raffle, "acceptOwnership");
    await c.write(c.usdc, "mint", [c.buyer, 100_000_000n]);
    await visit("/piece/2", c.buyer);
    await fixture.page.getByRole("button", { name: "Approve exact USDC", exact: true }).waitFor({ timeout: 15_000 });
    const selector = encodeFunctionData({ abi: raffleAbi, functionName: "getRaffle", args: [2n] }).slice(0, 10);
    let raffleReads = 0;
    await fixture.page.route(`${c.url}/`, async route => {
      const body: unknown = route.request().postDataJSON();
      for (const request of Array.isArray(body) ? body : [body]) {
        if (!request || typeof request !== "object" || !("method" in request) || request.method !== "eth_call" || !("params" in request) || !Array.isArray(request.params)) continue;
        const call: unknown = request.params[0];
        if (call && typeof call === "object" && "data" in call && typeof call.data === "string" && call.data.startsWith(selector)) raffleReads++;
      }
      await route.continue();
    });
    async function recoverReceipt(account: Address, txHash: Hex) {
      const key = `labx:outcome:v1:${c.manifest.chainId}:${c.manifest.address.toLowerCase()}:${c.manifest.runtimeCodeHash.toLowerCase()}:${account.toLowerCase()}:${txHash.toLowerCase()}`;
      await fixture.page.evaluate(({ key, txHash }) => {
        localStorage.setItem(key, txHash);
        window.dispatchEvent(new StorageEvent("storage", { key, newValue: txHash, storageArea: localStorage }));
      }, { key, txHash });
      const receipt = fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: txHash });
      await receipt.getByText(/^(Transaction confirmed|Purchase confirmed for raffle #2)$/).waitFor({ timeout: 15_000 });
      await fixture.page.waitForLoadState("networkidle");
    }
    try {
      const approval = await c.write(c.usdc, "approve", [c.raffle.address, 27_500_000n], c.buyer); await c.mine();
      raffleReads = 0;
      await recoverReceipt(c.buyer, approval.transactionHash);
      expect(raffleReads).toBe(0);
      await fixture.page.getByRole("button", { name: "Refresh state", exact: true }).click();
      await expect.poll(() => raffleReads, { timeout: 15_000 }).toBeGreaterThan(0);
      await fixture.page.waitForLoadState("networkidle");
      await fixture.page.locator(".agreements input[type=checkbox]").first().waitFor({ timeout: 15_000 });
      expect(raffleReads).toBeGreaterThan(0);
      await expect.poll(() => fixture.page.locator(".order-total").innerText(), { timeout: 15_000 }).toMatch(/27\.5/);
      await expect.poll(() => fixture.page.getByRole("button", { name: "Approve exact USDC", exact: true }).count(), { timeout: 15_000 }).toBe(0);
      for (const checkbox of await fixture.page.locator(".agreements input[type=checkbox]").all()) await checkbox.check();
      await fixture.page.getByRole("button", { name: "Sign and record agreement", exact: true }).click();
      await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).waitFor({ timeout: 15_000 });
      const purchase = await c.write(c.raffle, "buyPack", [2n, 0, 1, PUBLISHED_TERMS_HASH], c.buyer); await c.mine();
      raffleReads = 0;
      await recoverReceipt(c.buyer, purchase.transactionHash);
      await expect.poll(() => raffleReads, { timeout: 15_000 }).toBeGreaterThan(0);
      await expect.poll(() => fixture.page.getByRole("button", { name: "Buy again", exact: true }).isEnabled(), { timeout: 15_000 }).toBe(true);

      await c.write(c.nft, "mint", [c.seller, 4n]);
      const now = (await c.client.getBlock()).timestamp, digest = keccak256("0x5678");
      await c.write(c.raffle, "createRaffle", [c.nft.address, 4n, now + 86400n, digest, digest, "Cold NFT approval", [{ name: "Entry", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]], c.seller);
      await visit("/seller/4", c.seller);
      await fixture.page.getByRole("button", { name: "Approve NFT", exact: true }).waitFor({ timeout: 15_000 });
      const nftApproval = await c.write(c.nft, "approve", [c.raffle.address, 4n], c.seller); await c.mine();
      raffleReads = 0;
      await recoverReceipt(c.seller, nftApproval.transactionHash);
      expect(raffleReads).toBe(0);
      await fixture.page.getByRole("button", { name: "Refresh state", exact: true }).click();
      await fixture.page.getByRole("button", { name: "Escrow NFT", exact: true }).waitFor({ timeout: 15_000 });
      expect(raffleReads).toBeGreaterThan(0);
      await fixture.page.getByRole("button", { name: "Escrow NFT", exact: true }).click();
      await fixture.page.locator(".transaction-review").waitFor({ timeout: 15_000 });
    } finally { await fixture.page.unroute(`${c.url}/`); }
  }, 70_000);

  it("retains edited recovery and a newer journal when an earlier empty-journal response arrives", async () => {
    await c.write(c.raffle, "transferOwnership", [c.operator]); await c.write(c.raffle, "acceptOwnership");
    await c.write(c.usdc, "mint", [c.stranger, 100_000_000n]);
    await c.write(c.usdc, "approve", [c.raffle.address, 27_500_000n], c.stranger);
    const cancellationHash = hash(await c.rpc("eth_sendTransaction", [{ from: c.stranger, to: c.stranger, value: "0x0", data: "0x", gas: "0x5208" }]));
    const cancellationReceipt = await c.client.waitForTransactionReceipt({ hash: cancellationHash });
    await c.mine();
    expect(await c.client.getBlockNumber({ cacheTime: 0 })).toBeGreaterThanOrEqual(cancellationReceipt.blockNumber + 1n);
    const cancelled = await c.client.getTransaction({ hash: cancellationHash });
    const key = `labx:pending:v1:${c.manifest.chainId}:${c.manifest.address.toLowerCase()}:${c.manifest.runtimeCodeHash.toLowerCase()}:${c.stranger.toLowerCase()}`;
    const oldJournal = { id: "delayed-empty-journal", intentHash: transactionIntent({ to: c.stranger, data: "0x", value: 0n }), nonce: cancelled.nonce, startedBlock: cancellationReceipt.blockNumber.toString(), hash: cancellationHash };
    const newerHash = keccak256("0x9999");
    const newerJournal = JSON.stringify({ ...oldJournal, id: "newer-wallet-activity", nonce: cancelled.nonce + 1, hash: newerHash });
    const outcomeKey = `labx:outcome:v1:${c.manifest.chainId}:${c.manifest.address.toLowerCase()}:${c.manifest.runtimeCodeHash.toLowerCase()}:${c.stranger.toLowerCase()}:${cancellationHash}`;
    await fixture.page.addInitScript(({ key, txHash }) => localStorage.setItem(key, txHash), { key: outcomeKey, txHash: cancellationHash });
    await visit("/piece/2", c.stranger);
    const identity = fixture.page.locator(".wallet-identity", { hasText: `${c.stranger.slice(0, 6)}…${c.stranger.slice(-4)}` });
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    await expect.poll(async () => await identity.isVisible() || await connect.isVisible(), { timeout: 15_000 }).toBe(true);
    if (await connect.isVisible()) await connect.click();
    await identity.waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: cancellationHash }).getByText("Transaction confirmed", { exact: true }).waitFor({ timeout: 15_000 });
    await fixture.page.waitForLoadState("networkidle");
    await fixture.page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key, value: JSON.stringify(oldJournal) });
    await fixture.page.locator(".agreements input[type=checkbox]").first().waitFor({ timeout: 15_000 });
    for (const checkbox of await fixture.page.locator(".agreements input[type=checkbox]").all()) await checkbox.check();
    const localRecovery = fixture.page.locator(".buyer-flow .transaction-state", { hasText: "Reconcile pending wallet activity" });
    await fixture.page.evaluate(({ key, newerJournal, newerHash }) => {
      const originalGet = Storage.prototype.getItem;
      let armed = true;
      Storage.prototype.getItem = function (requestedKey: string) {
        const value = originalGet.call(this, requestedKey);
        const recoveryInput = document.querySelector(".buyer-flow .transaction-state input");
        if (armed && this === localStorage && requestedKey === key && recoveryInput instanceof HTMLInputElement) {
          armed = false;
          Storage.prototype.getItem = originalGet;
          localStorage.removeItem(key);
          const emptyJournal = originalGet.call(this, requestedKey);
          localStorage.setItem(key, newerJournal);
          queueMicrotask(() => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            if (!setter) throw new Error("Input value setter unavailable.");
            setter.call(recoveryInput, newerHash);
            recoveryInput.dispatchEvent(new Event("input", { bubbles: true }));
            document.documentElement.dataset.recoveryRace = "delivered";
          });
          return emptyJournal;
        }
        return value;
      };
    }, { key, newerJournal, newerHash });
    await fixture.page.getByRole("button", { name: "Sign and record agreement", exact: true }).click();
    await expect.poll(() => fixture.page.getAttribute("html", "data-recovery-race"), { timeout: 15_000 }).toBe("delivered");
    await fixture.page.waitForLoadState("networkidle");
    expect(await localRecovery.getByLabel("Transaction hash").inputValue()).toBe(newerHash);
    expect(await fixture.page.evaluate(key => localStorage.getItem(key), key)).toBe(newerJournal);
    expect(await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).count()).toBe(0);
  }, 45_000);

});
