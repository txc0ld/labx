import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, erc721Abi, keccak256, toBytes } from "viem";
import { hashCommitment } from "../lib/commitment";
import { raffleAbi } from "../lib/chain/abi";
import type { WalletSessionPort } from "../lib/chain/ports";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { STANDARD_MEMBERSHIP_TIERS } from "../lib/membership-tiers";
import { fillStandardMembershipEconomics } from "./fixtures/membership-tiers";
import { connectWallet } from "./fixtures/connect-wallet";
import { localDeadlineValue, openCreatePanel } from "./fixtures/seller-create";
import { formatDate } from "../components/workflow/format";

const run = process.env.RUN_SELLER_PORTAL_BROWSER === "1" ? describe : describe.skip;

run("rendered seller portal on isolated Anvil", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let buyerWallet: WalletSessionPort;
  const longPackName = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let evidenceDir: string;

  beforeAll(async () => {
    evidenceDir = process.env.LABX_SELLER_EVIDENCE_DIR ? resolve(process.env.LABX_SELLER_EVIDENCE_DIR) : mkdtempSync(resolve(tmpdir(), "labx-seller-portal-"));
    mkdirSync(evidenceDir, { recursive: true });
    chain = await localChain();
    const block = await chain.client.getBlock();
    for (let offset = 0; offset < 26; offset += 1) {
      const id = BigInt(offset + 1);
      const owner = offset === 0 ? chain.stranger : chain.seller;
      const tokenId = 800n + id;
      const commitment = keccak256(toBytes(`seller-portal-${id}`));
      await chain.write(chain.nft, "mint", [owner, tokenId]);
      await chain.write(chain.raffle, "createRaffle", [
        chain.nft.address,
        tokenId,
        block.timestamp + (id === 26n ? 60n * 86_400n : 86_400n),
        commitment,
        commitment,
        offset === 0 ? "Another seller raffle" : `Seller portfolio ${id}`,
        [{
          name: id === 26n ? longPackName : "Membership",
          priceUsdc: id === 26n ? 1_000_000_000_000n : 25_000_000n,
          bonusEntries: 2,
          maxSupply: 100
        }]
      ], owner);
    }
    await chain.write(chain.nft, "approve", [chain.raffle.address, 802n], chain.seller);
    await chain.write(chain.raffle, "escrow", [2n], chain.seller);
    await chain.admit(2n);
    await chain.write(chain.raffle, "open", [2n], chain.seller);
    await chain.write(chain.usdc, "mint", [chain.seller, 100_000_000n]);
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 27_500_000n], chain.seller);
    await chain.write(chain.raffle, "buyPack", [2n, 0, 1, PUBLISHED_TERMS_HASH], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 826n], chain.seller);
    await chain.write(chain.raffle, "escrow", [26n], chain.seller);
    await chain.admit(26n);
    await chain.write(chain.raffle, "open", [26n], chain.seller);
    const refundable = await chain.service.readRaffle({ id: 2n });
    await chain.warp(refundable.raffle.salesEnd + refundable.drawStartGrace);
    await chain.write(chain.raffle, "cancel", [2n], chain.seller);
    await chain.write(chain.raffle, "reclaimPrize", [2n], chain.seller);

    buyerWallet = chain.wallet(chain.buyer).session;
    await buyerWallet.connect();
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
    async function purchasedClosedRaffle(id: bigint, salesEnd: bigint) {
      const tokenId = 900n + id;
      const commitment = keccak256(toBytes(`permissionless-draw-${id}`));
      await chain.write(chain.nft, "mint", [chain.stranger, tokenId]);
      await chain.write(chain.raffle, "createRaffle", [
        chain.nft.address,
        tokenId,
        salesEnd,
        commitment,
        commitment,
        `Permissionless draw ${id}`,
        [{ name: "Membership", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 }]
      ], chain.stranger);
      await chain.write(chain.nft, "approve", [chain.raffle.address, tokenId], chain.stranger);
      await chain.write(chain.raffle, "escrow", [id], chain.stranger);
      await chain.admit(id);
      await chain.write(chain.raffle, "open", [id], chain.stranger);
      await chain.write(chain.usdc, "approve", [chain.raffle.address, 3_500_000n], chain.buyer);
      await chain.write(chain.raffle, "buyPack", [id, 0, 1, PUBLISHED_TERMS_HASH], chain.buyer);
      await chain.warp(salesEnd);
      await chain.write(chain.raffle, "close", [id], chain.buyer);
    }

    let now = (await chain.client.getBlock()).timestamp;
    await purchasedClosedRaffle(27n, now + 600n);
    now = (await chain.client.getBlock()).timestamp;
    await purchasedClosedRaffle(28n, now + 600n);
    await chain.write(chain.raffle, "snapshot", [28n, 100n], chain.buyer);
    const expiring = await chain.service.readRaffle({ id: 28n });
    await chain.warp(expiring.raffle.salesEnd + expiring.drawStartGrace);
    now = (await chain.client.getBlock()).timestamp;
    await purchasedClosedRaffle(29n, now + 600n);
    await chain.write(chain.raffle, "snapshot", [29n, 100n], chain.buyer);

    now = (await chain.client.getBlock()).timestamp;
    const nonce = keccak256(toBytes("seller-winner-nonce"));
    const publicHash = keccak256(toBytes("seller winner public note"));
    const privateHash = keccak256(toBytes("seller winner private value"));
    const salt = keccak256(toBytes("seller-winner-salt"));
    const commit = hashCommitment({
      chainId: 31337n,
      labx: chain.raffle.address,
      nonce,
      nft: chain.nft.address,
      tokenId: 930n,
      publicHash,
      privateHash,
      salt
    });
    await chain.write(chain.nft, "mint", [chain.seller, 930n]);
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      930n,
      now + 600n,
      nonce,
      commit,
      "Seller is the winner",
      [{ name: "Solo membership", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 1 }]
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 930n], chain.seller);
    await chain.write(chain.raffle, "escrow", [30n], chain.seller);
    await chain.admit(30n);
    await chain.write(chain.raffle, "open", [30n], chain.seller);
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 3_500_000n], chain.seller);
    await chain.write(chain.raffle, "buyPack", [30n, 0, 1, PUBLISHED_TERMS_HASH], chain.seller);
    await chain.warp(now + 600n);
    await chain.write(chain.raffle, "close", [30n], chain.buyer);
    await chain.write(chain.raffle, "snapshot", [30n, 100n], chain.buyer);
    await chain.write(chain.raffle, "requestRandomness", [30n], chain.buyer);
    const sellerWinner = await chain.service.readRaffle({ id: 30n });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, sellerWinner.raffle.vrfRequestId, 0n]);
    await chain.write(chain.raffle, "reveal", [30n, publicHash, privateHash, salt], chain.seller);
    await chain.write(chain.raffle, "settle", [30n], chain.buyer);
    await chain.write(chain.raffle, "claimProceeds", [30n], chain.seller);

    await chain.rpc("anvil_mine", ["0x7d0"]);
    fixture = await browserChain(chain);
    fixture.page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    fixture.page.on("console", (message: { type(): string; text(): string }) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  async function connectSeller(path = "/seller") {
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.getByText("26 total", { exact: true }));
  }

  async function transact(label: string) {
    const trigger = fixture.page.getByRole("button", { name: label, exact: true }).first();
    await trigger.waitFor({ state: "visible", timeout: 15_000 });
    await trigger.click();
    const review = fixture.page.locator(".transaction-review").first();
    await review.waitFor({ state: "visible", timeout: 10_000 });
    const blockBeforeSubmit = await chain.client.getBlockNumber({ cacheTime: 0 });
    await review.getByRole("button", { name: `Confirm ${label.charAt(0).toLowerCase()}${label.slice(1)}`, exact: true }).click();
    await expect.poll(async () => chain.client.getBlockNumber({ cacheTime: 0 }), { timeout: 15_000 }).toBeGreaterThan(blockBeforeSubmit);
    await expect.poll(async () => fixture.page.locator(".transaction-review").count(), { timeout: 15_000 }).toBe(0);
  }

  it("keeps the complete seller workspace and draft form aligned across supported widths", async () => {
    await fixture.page.setViewportSize({ width: 1440, height: 900 });
    await fixture.page.emulateMedia({ reducedMotion: "reduce" });
    await connectSeller();
    await fixture.page.getByText("Revenue", { exact: true }).click();
    await expect.poll(async () => fixture.page.getByText("Paid to you", { exact: true }).isVisible(), { timeout: 15_000 }).toBe(true);
    const raffleList = fixture.page.locator("section[aria-labelledby='seller-raffles-title'] ol");
    expect(await raffleList.getByRole("link").count()).toBe(26);
    expect(await raffleList.getByRole("link", { name: /^View: Seller portfolio (?:[3-9]|1\d|2[0-5])$/ }).count()).toBe(23);
    expect(await raffleList.getByText("Sales deadline passed", { exact: true }).count()).toBe(23);
    expect(await raffleList.getByRole("link", { name: "View: Seller portfolio 2", exact: true }).getAttribute("href")).toBe("/seller/2");
    expect(await raffleList.getByRole("link", { name: "View: Seller portfolio 26", exact: true }).getAttribute("href")).toBe("/seller/26");
    expect(await raffleList.getByRole("link", { name: "View: Seller is the winner", exact: true }).getAttribute("href")).toBe("/seller/30");
    expect(await raffleList.locator("li", { hasText: "Seller portfolio 2" }).filter({ hasText: "Raffle cancelled" }).getByText("Owed to buyers", { exact: true }).count()).toBe(1);
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const summary = fixture.page.locator("summary").filter({ hasText: "Create a raffle" });
    await summary.focus();
    await fixture.page.keyboard.press("Enter");
    await fixture.page.getByLabel("Raffle title").waitFor({ state: "visible" });

    for (const name of ["Raffle details", "Prize NFT", "Membership packs"]) {
      await fixture.page.getByRole("group", { name }).waitFor({ state: "visible" });
    }
    for (const [index, tier] of STANDARD_MEMBERSHIP_TIERS.entries()) {
      await fixture.page.getByRole("group", { name: `Membership ${index + 1}: ${tier}`, exact: true }).waitFor({ state: "visible" });
    }
    expect(await fixture.page.getByRole("button", { name: "Choose from wallet", exact: true }).count()).toBe(0);
    expect(await fixture.page.getByRole("region", { name: "Wallet NFTs" }).count()).toBe(0);
    await fixture.page.getByText("Automatic NFT discovery is disabled for isolated local-chain fixtures. Manual entry remains available.", { exact: true }).waitFor({ state: "visible" });
    expect(await fixture.page.getByLabel("NFT contract").isEnabled()).toBe(true);
    expect(await fixture.page.getByLabel("Token ID").isEnabled()).toBe(true);
    expect(await fixture.page.getByText("Set a price for each tier. Bonus entries and supply are suggestions you can change.", { exact: true }).count()).toBe(1);
    expect(await fixture.page.getByLabel("Name", { exact: true }).count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: /Add membership|Remove membership/ }).count()).toBe(0);
    const suggested = [["", "1", "100"], ["", "3", "50"], ["", "5", "25"], ["", "10", "10"], ["", "25", "5"]];
    for (const [index, tier] of STANDARD_MEMBERSHIP_TIERS.entries()) {
      const group = fixture.page.getByRole("group", { name: `Membership ${index + 1}: ${tier}`, exact: true });
      expect(await group.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(suggested[index]);
    }
    await fillStandardMembershipEconomics(fixture.page, (_tier, index) => ({ price: String((index + 1) * 10), bonusEntries: String(index + 1), supply: String((index + 1) * 10) }));

    async function computedAccessibility(selector: string) {
      const session = await fixture.page.context().newCDPSession(fixture.page);
      try {
        const { root } = await session.send("DOM.getDocument");
        const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        const { node } = await session.send("DOM.describeNode", { nodeId });
        const tree = await session.send("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false });
        const accessible = tree.nodes.find((candidate) => candidate.backendDOMNodeId === node.backendNodeId) ?? tree.nodes[0];
        return { name: String(accessible?.name?.value ?? ""), description: String(accessible?.description?.value ?? "") };
      } finally {
        await session.detach();
      }
    }

    expect(await fixture.page.getByLabel("Sales deadline (your time)", { exact: true }).count()).toBe(1);
    expect(await fixture.page.getByLabel("Public commitment note", { exact: true }).count()).toBe(0);
    expect(await fixture.page.getByLabel("Private commitment", { exact: true }).count()).toBe(0);

    const futureDeadline = Number((await chain.client.getBlock()).timestamp + 86_400n);
    await fixture.page.getByLabel("Raffle title").fill("Responsive seller draft");
    await fixture.page.getByLabel("NFT contract").fill(chain.nft.address);
    await fixture.page.getByLabel("Token ID").fill("999");
    await fixture.page.getByLabel("Sales deadline (your time)").fill(await localDeadlineValue(fixture.page, futureDeadline));
    expect(await computedAccessibility("#draft-close")).toEqual({ name: "Sales deadline (your time)", description: `(${formatDate(BigInt(futureDeadline - futureDeadline % 60))} UTC)` });
    expect(await fixture.page.getByRole("button", { name: "Create", exact: true }).isEnabled()).toBe(true);
    expect(await fixture.page.getByRole("button", { name: "Sign to prepare raffle", exact: true }).count()).toBe(0);
    await fixture.page.getByLabel("Raffle title").focus();
    expect(await fixture.page.locator("form").filter({ has: fixture.page.getByLabel("Raffle title") }).locator("input, textarea").evaluateAll((controls) => controls.map((control) => control.id).filter(Boolean).slice(0, 4))).toEqual(["draft-title", "draft-close", "draft-nft", "draft-token"]);
    await fixture.page.keyboard.press("Tab");
    expect(await fixture.page.evaluate(() => document.activeElement?.id)).toBe("draft-close");

    const createPanel = fixture.page.locator("section[aria-label='Create a raffle draft']");
    for (const width of [320, 390, 768, 1024, 1440, 1680]) {
      await fixture.page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
      expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const clippedControls = await createPanel.locator("input:visible, textarea:visible, button:visible").evaluateAll((controls, panel) => {
        const panelBounds = (panel as Element).getBoundingClientRect();
        return controls.filter((control) => {
          const bounds = control.getBoundingClientRect();
          return bounds.left < panelBounds.left - 1 || bounds.right > panelBounds.right + 1 || bounds.left < -1 || bounds.right > document.documentElement.clientWidth + 1;
        }).map((control) => (control as HTMLElement).outerHTML);
      }, await createPanel.elementHandle());
      expect(clippedControls).toEqual([]);
      await createPanel.screenshot({ path: resolve(evidenceDir, `seller-create-${width}.png`) });
      await fixture.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await createPanel.evaluate((panel) => {
        const bounds = panel.getBoundingClientRect();
        window.scrollTo({ top: window.scrollY + bounds.top - 120 });
      });
      await fixture.page.screenshot({ path: resolve(evidenceDir, `seller-create-${width}-viewport.png`), fullPage: false });
    }

    await fixture.page.setViewportSize({ width: 768, height: 900 });
    await fixture.page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await createPanel.screenshot({ path: resolve(evidenceDir, "seller-create-768-zoom-200.png") });
    await fixture.page.evaluate(() => { document.documentElement.style.zoom = ""; });

    await fixture.page.emulateMedia({ reducedMotion: "reduce" });
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    const overview = fixture.page.locator("details").filter({ has: fixture.page.locator("summary", { hasText: /^Revenue$/ }) });
    const columns = await overview.locator("dl").first().evaluate((element: Element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(2);
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await fixture.page.screenshot({ path: resolve(evidenceDir, "seller-workspace-390.png"), fullPage: false });

    const longPackResponse = await fixture.page.goto(`${fixture.baseUrl}/piece/26`, { waitUntil: "domcontentloaded" });
    expect(longPackResponse?.status()).toBe(200);
    await fixture.page.getByText(longPackName, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.getByRole("radiogroup", { name: "Membership packs" }).getByText("1,000,000.00 USDC", { exact: true }).waitFor({ state: "visible" });
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }, 60_000);

  it("keeps private setup out of errors and persistence, and recovers an ambiguous preparation without a second POST", async () => {
    await fixture.switchAccount(chain.seller);
    await fixture.page.goto(`${fixture.baseUrl}/seller`, { waitUntil: "domcontentloaded" });
    const create = fixture.page.locator("summary").filter({ hasText: "Create a raffle" });
    await connectWallet(fixture.page, create);
    await openCreatePanel(fixture.page);
    const block = await chain.client.getBlock();
    await fixture.page.getByLabel("Raffle title").fill("Private preparation failure");
    await fixture.page.getByLabel("NFT contract").fill(chain.nft.address);
    await fixture.page.getByLabel("Token ID").fill("999");
    await fixture.page.getByLabel("Sales deadline (your time)").fill(await localDeadlineValue(fixture.page, block.timestamp + 86_400n));
    await fillStandardMembershipEconomics(fixture.page, () => ({ price: "1", bonusEntries: "1", supply: "10" }));
    let posts = 0, secret = "";
    await fixture.page.route("**/api/reserve", async route => {
      posts++;
      secret = route.request().postDataJSON().input.privateCommitment;
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: `Untrusted failure ${secret}` }) });
    });
    await fixture.page.evaluate(() => (window as unknown as { __labxRejectNextSignature(code: number, message: string): void }).__labxRejectNextSignature(4001, "Rejected private input"));
    await fixture.page.getByRole("button", { name: "Create", exact: true }).click();
    await fixture.page.getByText("The wallet request was cancelled. Press Create to continue when you're ready.", { exact: true }).waitFor();
    expect(posts).toBe(0);
    await fixture.page.getByRole("button", { name: "Create", exact: true }).click();
    await fixture.page.getByText("Couldn't save the raffle setup. Press Create to try again.", { exact: true }).waitFor();
    expect(posts).toBe(1);
    expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await fixture.page.locator("body").innerText()).not.toContain(secret);
    expect(await fixture.page.evaluate(() => Object.values(localStorage).join("\n"))).not.toContain(secret);
    await fixture.page.getByRole("button", { name: "Create", exact: true }).click();
    await fixture.page.getByText(/Preparation recovery is unavailable/).waitFor();
    expect(posts).toBe(1);
    expect(await chain.client.getBlockNumber()).toBe(block.number);
    await fixture.page.unroute("**/api/reserve");
    // Isolated fixture cleanup: its intercepted request never reached storage or chain.
    await fixture.page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("labx:create:")) localStorage.removeItem(key); });
  }, 45_000);

  it("fails closed before storage or transaction review when browser entropy fails", async () => {
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const create = fixture.page.locator("summary").filter({ hasText: "Create a raffle" });
    await connectWallet(fixture.page, create);
    await openCreatePanel(fixture.page);
    const block = await chain.client.getBlock();
    await fixture.page.getByLabel("Raffle title").fill("Entropy failure");
    await fixture.page.getByLabel("NFT contract").fill(chain.nft.address);
    await fixture.page.getByLabel("Token ID").fill("997");
    await fixture.page.getByLabel("Sales deadline (your time)").fill(await localDeadlineValue(fixture.page, block.timestamp + 86_400n));
    await fillStandardMembershipEconomics(fixture.page, () => ({ price: "1", bonusEntries: "1", supply: "1" }));
    let reserveRequests = 0;
    await fixture.page.route("**/api/reserve", async route => { reserveRequests += 1; await route.abort("failed"); });
    await fixture.page.evaluate(() => {
      Object.defineProperty(window.crypto, "getRandomValues", { configurable: true, value: () => { throw new Error("entropy disabled for test"); } });
    });
    await fixture.page.getByRole("button", { name: "Create", exact: true }).click();
    await fixture.page.getByText("Secure random generation failed. This raffle cannot be prepared safely.", { exact: true }).waitFor({ state: "visible" });
    expect(reserveRequests).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Sign to prepare raffle", exact: true }).count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Create raffle draft", exact: true }).count()).toBe(0);
    expect(await fixture.page.locator(".transaction-review").count()).toBe(0);
    await fixture.page.unroute("**/api/reserve");
  }, 30_000);

  it("retains the chain commitment for canonically unchanged and escrowed NFT drafts without entropy", async () => {
    let reserveRequests = 0;
    await fixture.page.route("**/api/reserve", async route => { reserveRequests += 1; await route.abort("failed"); });

    await fixture.switchAccount(chain.seller);
    let response = await fixture.page.goto(`${fixture.baseUrl}/seller/3`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.locator("summary").filter({ hasText: "Edit draft" }));
    const beforeUnescrowed = await chain.service.readRaffle({ id: 3n });
    await fixture.page.locator("summary").filter({ hasText: "Edit draft" }).click();
    await fixture.page.getByText("1 existing membership", { exact: true }).waitFor({ state: "visible" });
    const existingPack = fixture.page.getByRole("group", { name: "Membership 1: Membership", exact: true });
    expect(await existingPack.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["25", "2", "100"]);
    expect(await fixture.page.getByLabel("Name", { exact: true }).count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: /Add membership|Remove membership/ }).count()).toBe(0);
    const block = await chain.client.getBlock();
    await fixture.page.getByLabel("Raffle title").fill("Canonical NFT retention");
    await fixture.page.getByLabel("Token ID").fill("0803");
    await fixture.page.getByLabel("Sales deadline (your time)").fill(await localDeadlineValue(fixture.page, block.timestamp + 86_400n));
    await fixture.page.evaluate(() => {
      Object.defineProperty(window.crypto, "getRandomValues", { configurable: true, value: () => { throw new Error("entropy disabled for retention test"); } });
    });
    await fixture.page.getByRole("button", { name: "Save changes", exact: true }).click();
    await fixture.page.getByText("Your saved draw setup stays the same, so no signature is needed. Saving sends your raffle back to LABx for review.", { exact: true }).waitFor({ state: "visible" });
    await fixture.page.evaluate(() => { Reflect.deleteProperty(window.crypto, "getRandomValues"); });
    await transact("Save changes");
    const afterUnescrowed = await chain.service.readRaffle({ id: 3n });
    expect(afterUnescrowed.raffle.reserveNonce).toBe(beforeUnescrowed.raffle.reserveNonce);
    expect(afterUnescrowed.raffle.reserveCommit).toBe(beforeUnescrowed.raffle.reserveCommit);

    const escrowBlock = await chain.client.getBlock();
    const legacyDeadline = escrowBlock.timestamp + 60n;
    const legacyCommitment = keccak256(toBytes("legacy escrowed automatic retention"));
    await chain.write(chain.nft, "mint", [chain.seller, 931n]);
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      931n,
      legacyDeadline,
      legacyCommitment,
      legacyCommitment,
      "Legacy escrowed draft",
      [
        { name: "eNTRY", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 },
        { name: "BASIC", priceUsdc: 7_000_000n, bonusEntries: 5, maxSupply: 11 }
      ]
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 931n], chain.seller);
    await chain.write(chain.raffle, "escrow", [31n], chain.seller);
    await chain.warp(legacyDeadline);
    const beforeEscrowed = await chain.service.readRaffle({ id: 31n });

    response = await fixture.page.goto(`${fixture.baseUrl}/seller/31`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.locator("summary").filter({ hasText: "Edit draft" }));
    await fixture.page.locator("summary").filter({ hasText: "Edit draft" }).click();
    expect(await fixture.page.getByLabel("NFT contract").isDisabled()).toBe(true);
    expect(await fixture.page.getByLabel("Token ID").isDisabled()).toBe(true);
    await fixture.page.getByText("2 existing memberships", { exact: true }).waitFor({ state: "visible" });
    const entryPack = fixture.page.getByRole("group", { name: "Membership 1: eNTRY", exact: true });
    const basicPack = fixture.page.getByRole("group", { name: "Membership 2: BASIC", exact: true });
    expect(await entryPack.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["1", "1", "10"]);
    expect(await basicPack.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["7", "5", "11"]);
    expect(await fixture.page.getByRole("button", { name: /Add membership|Remove membership/ }).count()).toBe(0);
    await fixture.page.getByLabel("Raffle title").fill("Legacy escrowed draft retained");
    const recoveryBlock = await chain.client.getBlock();
    await fixture.page.getByLabel("Sales deadline (your time)").fill(await localDeadlineValue(fixture.page, recoveryBlock.timestamp + 86_400n));
    await basicPack.getByLabel("Price in USDC", { exact: true }).fill("8");
    await basicPack.getByLabel("Bonus entries", { exact: true }).fill("6");
    await basicPack.getByLabel("Supply", { exact: true }).fill("12");
    await fixture.page.evaluate(() => {
      Object.defineProperty(window.crypto, "getRandomValues", { configurable: true, value: () => { throw new Error("entropy disabled for escrow retention test"); } });
    });
    await fixture.page.getByRole("button", { name: "Save changes", exact: true }).click();
    await fixture.page.getByText("Your saved draw setup stays the same, so no signature is needed. Saving sends your raffle back to LABx for review.", { exact: true }).waitFor({ state: "visible" });
    await fixture.page.evaluate(() => { Reflect.deleteProperty(window.crypto, "getRandomValues"); });
    await transact("Save changes");
    const afterEscrowed = await chain.service.readRaffle({ id: 31n });
    expect(afterEscrowed.raffle.reserveNonce).toBe(beforeEscrowed.raffle.reserveNonce);
    expect(afterEscrowed.raffle.reserveCommit).toBe(beforeEscrowed.raffle.reserveCommit);
    expect(afterEscrowed.packs.map((pack) => ({ name: pack.name, priceUsdc: pack.priceUsdc, bonusEntries: pack.bonusEntries, maxSupply: pack.maxSupply }))).toEqual([
      { name: "eNTRY", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 },
      { name: "BASIC", priceUsdc: 8_000_000n, bonusEntries: 6, maxSupply: 12 }
    ]);
    expect(reserveRequests).toBe(0);
    await fixture.page.unroute("**/api/reserve");
  }, 60_000);

  it("gates a direct seller route immediately after the wallet changes", async () => {
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller/2`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.getByRole("heading", { name: "Seller portfolio 2" }));
    await fixture.page.locator("summary").filter({ hasText: "Earnings" }).click();
    await fixture.page.getByText("Refunds not yet claimed", { exact: true }).waitFor({ state: "visible" });
    await fixture.page.screenshot({ path: resolve(evidenceDir, "seller-detail-mobile.png"), fullPage: true });
    await fixture.switchAccount(chain.stranger);
    await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet." }).waitFor({ state: "visible", timeout: 5_000 });
    expect(await fixture.page.getByText(/List your raffle|Approve NFT|Lock NFT/).count()).toBe(0);

    await fixture.switchAccount(chain.operator);
    await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet." }).waitFor({ state: "visible", timeout: 5_000 });
    expect(await fixture.page.getByRole("button", { name: /Approve NFT|Lock NFT|^Claim [\d.,]+ USDC$/ }).count()).toBe(0);
  }, 30_000);

  it("keeps earlier activity through a later-page failure and an empty final retry", async () => {
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}/seller/2`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.locator("summary").filter({ hasText: "Sales and payouts" }).click();
    const activity = fixture.page.locator("section[aria-label='Sales and payouts']");
    const purchased = `${chain.seller.slice(0, 6)}…${chain.seller.slice(-4)} bought 1 membership`;
    await activity.getByText(purchased, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await activity.getByText(purchased, { exact: true }).count()).toBe(1);
    expect(await activity.getByRole("button", { name: "Load more", exact: true }).count()).toBe(1);

    let failuresRemaining = 1;
    await fixture.page.route(`${chain.url}/`, async (route: {
      request(): { postDataJSON(): unknown };
      continue(): Promise<void>;
      fulfill(input: { status: number; contentType: string; body: string }): Promise<void>;
    }) => {
      const payload = route.request().postDataJSON();
      if (failuresRemaining > 0 && payload && typeof payload === "object" && "method" in payload && payload.method === "eth_getLogs") {
        failuresRemaining -= 1;
        const id = "id" in payload ? payload.id : null;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "transient activity RPC failure" } })
        });
        return;
      }
      await route.continue();
    });

    await activity.getByRole("button", { name: "Load more", exact: true }).click();
    await activity.getByText("Couldn’t load all sales and payouts", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(failuresRemaining).toBe(0);
    expect(await activity.getByText(purchased, { exact: true }).count()).toBe(1);
    expect(await activity.getByRole("button", { name: "Load more", exact: true }).count()).toBe(0);

    await activity.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(async () => activity.getByText("Couldn’t load all sales and payouts", { exact: true }).count(), { timeout: 15_000 }).toBe(0);
    await expect.poll(async () => activity.getByRole("button", { name: "Load more", exact: true }).count(), { timeout: 15_000 }).toBe(0);
    expect(await activity.getByText(purchased, { exact: true }).count()).toBe(1);
    await fixture.page.unroute(`${chain.url}/`);
  }, 45_000);

  it("keeps a seller's buyer refund on the public piece and out of seller-only controls", async () => {
    const beforeRefund = await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] });
    await fixture.switchAccount(chain.seller);
    let response = await fixture.page.goto(`${fixture.baseUrl}/seller/2`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.getByRole("heading", { name: "Seller portfolio 2" }));
    expect(await fixture.page.getByRole("button", { name: /^Claim [\d.,]+ USDC refund$/ }).count()).toBe(0);

    response = await fixture.page.goto(`${fixture.baseUrl}/piece/2`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.getByRole("button", { name: "Claim 25.00 USDC refund", exact: true }).first());
    expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [802n] })).toBe(chain.seller);
    await transact("Claim 25.00 USDC refund");
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] })).toBe(beforeRefund + 25_000_000n);
    expect((await chain.service.readAccount({ id: 2n, account: chain.seller })).principal).toBe(0n);
  }, 30_000);

  it("keeps a seller-winner prize claim in the public flow after proceeds are claimed", async () => {
    await fixture.switchAccount(chain.seller);
    let response = await fixture.page.goto(`${fixture.baseUrl}/seller/30`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.getByRole("heading", { name: "Seller is the winner" }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: "Claim your NFT", exact: true }).count()).toBe(0);

    response = await fixture.page.goto(`${fixture.baseUrl}/piece/30`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.getByRole("button", { name: "Claim your NFT", exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    await transact("Claim your NFT");
    expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [930n] })).toBe(chain.seller);
  }, 30_000);

  it("keeps permissionless draw preparation blocked until snapshot completion and before the deadline", async () => {
    await expect(chain.service.prepare({ action: { kind: "requestRandomness", id: 27n }, wallet: buyerWallet })).rejects.toThrow(/unavailable/);
    await expect(chain.service.prepare({ action: { kind: "requestRandomness", id: 28n }, wallet: buyerWallet })).rejects.toThrow(/deadline/);
  });

  it("renders one permissionless draw review for an eligible non-seller and submits fixed arguments", async () => {
    await fixture.switchAccount(chain.buyer);
    const response = await fixture.page.goto(`${fixture.baseUrl}/piece/29`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const start = fixture.page.getByRole("button", { name: "Start draw", exact: true });
    const help = fixture.page.locator("summary").filter({ hasText: "Help finish this raffle" });
    await connectWallet(fixture.page, help);
    expect(await start.isVisible()).toBe(false);
    await help.click();
    await start.waitFor({ state: "visible" });
    expect(await start.count()).toBe(1);
    await start.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible" });
    expect(await review.innerText()).toContain(`LABx raffle ${chain.raffle.address.slice(0, 6)}…${chain.raffle.address.slice(-4)}`);
    await review.locator("summary", { hasText: "Transaction details" }).click();
    expect(await review.innerText()).toContain(chain.raffle.address);
    await review.getByRole("button", { name: "Confirm start draw", exact: true }).click();
    await expect.poll(async () => (await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "getRaffle", args: [29n] })).phase, { timeout: 15_000 }).toBe(3);
    const drawing = await chain.service.readRaffle({ id: 29n });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    const sellerRoute = await fixture.page.goto(`${fixture.baseUrl}/seller/29`, { waitUntil: "domcontentloaded" });
    expect(sellerRoute?.status()).toBe(200);
    await fixture.page.getByRole("heading", { name: "This raffle belongs to another wallet." }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: /Confirm the draw|Finish raffle|^Claim [\d.,]+ USDC$/ }).count()).toBe(0);
  }, 30_000);
});
