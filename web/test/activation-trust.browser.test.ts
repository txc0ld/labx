import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toHex, type Address } from "viem";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { workflowMessage } from "../lib/chain/messages";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { hash } from "../lib/chain/validation";

const run = process.env.RUN_BROWSER_ACCEPTANCE === "1" ? describe : describe.skip;
run("activation drift beside browser recovery", () => {
  let c: LocalChain, fixture: Awaited<ReturnType<typeof browserChain>>;
  let commit: ReturnType<typeof hash>;
  beforeAll(async () => {
    c = await localChain(); fixture = await browserChain(c, c.operator);
    for (const id of [1n, 2n]) await c.write(c.nft, "mint", [c.seller, id]);
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
    for (const id of [1n, 2n]) {
      await c.write(c.raffle, "createRaffle", [c.nft.address, id, now + 86400n, id === 2n ? hash(record.nonce) : keccak256("0x12"), id === 2n ? commit : keccak256("0x12"), `Activation ${id}`, [{ name: "Entry", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]], c.seller);
      await c.write(c.nft, "approve", [c.raffle.address, id], c.seller); await c.write(c.raffle, "escrow", [id], c.seller); await c.admit(id);
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
    await visit("/review/1", c.operator);
    await fixture.page.getByText(/reviewed deployment has a pending ownership transfer/).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: "Current draft approved", exact: true }).isDisabled()).toBe(true);
    expect(await fixture.page.getByRole("button", { name: "Prepare revocation", exact: true }).isEnabled()).toBe(true);
    await viewport(375);
    expect(await fixture.page.getByRole("button", { name: "Current draft approved", exact: true }).isDisabled()).toBe(true);
    await fixture.page.getByRole("button", { name: "Prepare revocation", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Prepare exact revocation", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Execute the reviewed call in Safe", exact: true }).waitFor({ timeout: 15_000 });
    const review = await c.service.readAdmission({ id: 1n });
    if (!review.snapshot.admission.reviewHash) throw new Error("Missing revocation hash.");
    const receipt = await c.write(c.raffle, "revokeRaffleApproval", [1n, review.snapshot.admission.reviewHash]); await c.mine();
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
});
