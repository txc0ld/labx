import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, erc20Abi, toHex, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { workflowMessage } from "../lib/chain/messages";
import { hash } from "../lib/chain/validation";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { browserChain } from "./fixtures/browser-chain";
import { connectWallet } from "./fixtures/connect-wallet";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { watchWallet } from "./fixtures/wallet-watch";

const DRAW = "LABx closes sales and starts the draw automatically. This usually takes a few minutes.";
const SETTLE = "LABx finishes the raffle automatically after you confirm the draw.";

// The draw runner itself is a server job. Here another local account stands in for it, so the page shows what the seller sees.
describe.runIf(process.env.RUN_SELLER_DRAW_RUNNER_BROWSER === "1")("seller page with the draw runner on", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let id: bigint;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  // The flag is compiled into the page, so this dev server gets its own build directory. Next rewrites these two files for it.
  const distPath = resolve(".next-seller-draw-runner");
  const nextEnvPath = resolve("next-env.d.ts");
  const tsconfigPath = resolve("tsconfig.json");
  let nextEnv = "";
  let tsconfig = "";

  beforeAll(async () => {
    nextEnv = readFileSync(nextEnvPath, "utf8");
    tsconfig = readFileSync(tsconfigPath, "utf8");
    chain = await localChain();
    fixture = await browserChain(chain, chain.seller, true, { NEXT_PUBLIC_LABX_DRAW_RUNNER: "1", LABX_NEXT_DIST_DIR: ".next-seller-draw-runner" });
    fixture.page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    fixture.page.on("console", (message: { type(): string; text(): string }) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await chain.write(chain.nft, "mint", [chain.seller, 501n]);
    await chain.write(chain.nft, "mint", [chain.seller, 502n]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
    const listed = await listSoldRaffle(501n, "Runner raffle");
    id = listed.id;
    await chain.warp(listed.salesEnd);
  }, 150_000);

  /** Saves a draw setup through the app, signed by the local seller account so Confirm the draw can load it later, then lists a raffle with one sale. */
  async function listSoldRaffle(tokenId: bigint, title: string) {
    const input = { nft: chain.nft.address, tokenId: tokenId.toString(), publicSummary: title, privateCommitment: `${title} private commitment` };
    const deadline = String(Math.floor(Date.now() / 1000) + 300);
    const context = { origin: fixture.baseUrl, chainId: chain.manifest.chainId, contract: chain.raffle.address, termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
    const signature = await chain.rpc("personal_sign", [toHex(workflowMessage("commitment", context, chain.seller, input, deadline)), chain.seller]);
    const response = await fetch(`${fixture.baseUrl}/api/reserve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: chain.seller, input, deadline, signature }) });
    expect(response.status).toBe(200);
    const record: unknown = await response.json();
    if (!record || typeof record !== "object" || !("commit" in record) || !("nonce" in record)) throw new Error("Missing saved draw setup.");
    const salesEnd = (await chain.client.getBlock()).timestamp + 3_600n;
    const raffleId = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await chain.write(chain.raffle, "createRaffle", [chain.nft.address, tokenId, salesEnd, hash(record.nonce), hash(record.commit), title, [{ name: "Entry", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, tokenId], chain.seller);
    await chain.write(chain.raffle, "escrow", [raffleId], chain.seller);
    await chain.admit(raffleId);
    await chain.write(chain.raffle, "open", [raffleId], chain.seller);
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 27_500_000n], chain.buyer);
    await chain.write(chain.raffle, "buyPack", [raffleId, 0, 1, PUBLISHED_TERMS_HASH], chain.buyer);
    return { id: raffleId, salesEnd };
  }

  afterAll(async () => {
    try {
      await fixture?.close();
      chain?.close();
    } finally {
      rmSync(distPath, { recursive: true, force: true });
      if (nextEnv) writeFileSync(nextEnvPath, nextEnv);
      if (tsconfig) writeFileSync(tsconfigPath, tsconfig);
    }
  });

  async function open(path: string, ready: string) {
    await fixture.switchAccount(chain.seller);
    const response = await fixture.page.goto(`${fixture.baseUrl}${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.getByText(ready, { exact: true }).first(), 30_000);
  }

  async function refresh() {
    await fixture.page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => fixture.page.getByRole("button", { name: "Updating…", exact: true }).count(), { timeout: 15_000 }).toBe(0);
  }

  function automaticCard(title: string) {
    return fixture.page.locator("section.workflow-next[role=status]").filter({ has: fixture.page.getByRole("heading", { name: title, exact: true, level: 2 }) });
  }

  /** Full-page screenshots only when LABX_SELLER_DRAW_RUNNER_EVIDENCE_DIR is set. */
  async function evidence(name: string) {
    const dir = process.env.LABX_SELLER_DRAW_RUNNER_EVIDENCE_DIR;
    if (!dir) return;
    mkdirSync(resolve(dir), { recursive: true });
    await fixture.page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
  }

  function visibleButton(name: string) {
    return fixture.page.getByRole("button", { name, exact: true }).filter({ visible: true });
  }

  async function phase() {
    return (await chain.service.readRaffle({ id })).raffle.phase;
  }

  it("shows the runner message on the Studio card instead of Close sales", async () => {
    await open("/seller", DRAW);
    const card = fixture.page.locator("section[aria-labelledby='seller-raffles-title'] li").filter({ hasText: "Runner raffle" });
    expect(await card.getByText(DRAW, { exact: true }).isVisible()).toBe(true);
    expect(await card.getByRole("link").getAttribute("aria-label")).toBe("View: Runner raffle");
    expect(await fixture.page.getByRole("link", { name: /^Close sales:/ }).count()).toBe(0);
    await evidence("studio-card-1280");
  }, 90_000);

  it("leaves closing, counting and starting the draw to LABx with a closed Run it yourself fallback", async () => {
    await open(`/seller/${id.toString()}`, DRAW);
    const closing = automaticCard("Sales ended");
    expect(await closing.getByText(DRAW, { exact: true }).isVisible()).toBe(true);
    expect(await visibleButton("Close sales").count()).toBe(0);
    expect(await fixture.page.locator("section[aria-label='Raffle progress'] .raffle-timeline li").count()).toBe(4);
    const fallback = fixture.page.locator("details.workflow-details").filter({ has: fixture.page.locator("summary", { hasText: /^Run it yourself$/ }) });
    expect(await fallback.count()).toBe(1);
    expect(await fallback.getAttribute("open")).toBeNull();
    expect(await fallback.getByRole("button", { name: "Close sales", exact: true, includeHidden: true }).count()).toBe(1);
    await evidence("sales-ended-1280");
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await evidence("sales-ended-390");
    await fixture.page.setViewportSize({ width: 1280, height: 900 });

    // The runner closes sales. The waiting page re-reads the raffle by itself.
    await chain.write(chain.raffle, "close", [id], chain.stranger);
    const counting = automaticCard("Sales closed");
    await counting.waitFor({ state: "visible", timeout: 40_000 });
    expect(await counting.getByText(DRAW, { exact: true }).isVisible()).toBe(true);
    expect(await visibleButton("Count entries").count()).toBe(0);

    // The fallback still works: one click sends the exact call straight to the wallet.
    await fixture.page.locator("summary", { hasText: /^Run it yourself$/ }).click();
    const wallet = await watchWallet(fixture.page);
    await visibleButton("Count entries").click();
    await automaticCard("Entries counted").waitFor({ state: "visible", timeout: 20_000 });
    expect((await chain.service.readRaffle({ id })).raffle.snapshotted).toBe(true);
    expect(await wallet.reviews()).toBe(0);
    const requests = await wallet.requests();
    expect(requests.map(request => request.method)).toEqual(["eth_sendTransaction"]);
    expect(decodeFunctionData({ abi: raffleAbi, data: requests[0].data as Hex })).toEqual({ functionName: "snapshot", args: [id, 100n] });
    expect(await automaticCard("Entries counted").getByText(DRAW, { exact: true }).isVisible()).toBe(true);
    expect(await visibleButton("Start draw").count()).toBe(0);
  }, 120_000);

  it("keeps Confirm the draw and the claim with the seller and leaves finishing to LABx", async () => {
    await chain.write(chain.raffle, "requestRandomness", [id], chain.stranger);
    const drawing = await chain.service.readRaffle({ id });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    await refresh();
    const confirmDraw = fixture.page.getByRole("button", { name: "Confirm the draw", exact: true });
    await confirmDraw.waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.locator("summary", { hasText: /^Run it yourself$/ }).count()).toBe(0);

    const wallet = await watchWallet(fixture.page);
    await confirmDraw.click();
    const finishing = automaticCard("Draw confirmed");
    await finishing.waitFor({ state: "visible", timeout: 30_000 });
    expect((await chain.service.readRaffle({ id })).raffle.revealed).toBe(true);
    expect(await wallet.reviews()).toBe(0);
    expect((await wallet.requests()).map(request => request.method)).toEqual(["personal_sign", "eth_sendTransaction"]);
    expect(await finishing.getByText(SETTLE, { exact: true }).isVisible()).toBe(true);
    expect(await visibleButton("Finish raffle").count()).toBe(0);
    await evidence("draw-confirmed-1280");
    expect(await fixture.page.getByRole("button", { name: "Finish raffle", exact: true, includeHidden: true }).count()).toBe(1);

    // The runner finishes the raffle; claiming stays the seller's step.
    await chain.write(chain.raffle, "settle", [id], chain.stranger);
    expect(await phase()).toBe(5);
    await refresh();
    const claim = fixture.page.getByRole("button", { name: "Claim 24.50 USDC", exact: true });
    await claim.waitFor({ state: "visible", timeout: 15_000 });
    const before = await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] });
    const claimWallet = await watchWallet(fixture.page);
    await claim.click();
    await expect.poll(async () => chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [chain.seller] }), { timeout: 15_000 }).toBe(before + 24_500_000n);
    expect(await claimWallet.reviews()).toBe(0);
    await automaticCard("Raffle complete").waitFor({ state: "visible", timeout: 15_000 });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }, 120_000);

  it("holds the background re-read while Confirm the draw waits for its signature, so the control is never remounted", async () => {
    // A second raffle, drawn and past its 7-day confirmation window: LABx's finish step is pending, so the page re-reads itself,
    // and Confirm the draw sits under Advanced.
    const listed = await listSoldRaffle(502n, "Held confirmation raffle");
    await chain.warp(listed.salesEnd);
    for (const step of ["close", "snapshot", "requestRandomness"] as const) await chain.write(chain.raffle, step, step === "snapshot" ? [listed.id, 100n] : [listed.id], chain.stranger);
    const drawing = await chain.service.readRaffle({ id: listed.id });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    const drawn = await chain.service.readRaffle({ id: listed.id });
    await chain.warp(drawn.raffle.drawnAt + drawn.revealGrace);

    await open(`/seller/${listed.id.toString()}`, SETTLE);
    expect(await automaticCard("Winner drawn").getByText(SETTLE, { exact: true }).isVisible()).toBe(true);
    const read = encodeFunctionData({ abi: raffleAbi, functionName: "getRaffle", args: [listed.id] });
    let reads = 0;
    await fixture.page.route(`${chain.url}/`, async route => {
      const body: unknown = route.request().postDataJSON();
      for (const request of Array.isArray(body) ? body : [body]) {
        if (!request || typeof request !== "object" || !("method" in request) || request.method !== "eth_call" || !("params" in request) || !Array.isArray(request.params)) continue;
        const call: unknown = request.params[0];
        if (call && typeof call === "object" && "data" in call && typeof call.data === "string" && call.data.toLowerCase() === read.toLowerCase()) reads++;
      }
      await route.continue();
    });
    try {
      // The waiting page re-reads by itself.
      await expect.poll(() => reads, { timeout: 25_000 }).toBeGreaterThan(0);

      await fixture.page.locator("summary", { hasText: /^Advanced \(/ }).click();
      await fixture.page.evaluate(() => {
        type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
        const scope = window as unknown as Window & { ethereum: { request: Request }; __heldSignatures: number; __releaseSignature(): void };
        const original = scope.ethereum.request.bind(scope.ethereum);
        let release = () => {};
        const held = new Promise<void>(resolve => { release = resolve; });
        scope.__heldSignatures = 0;
        scope.__releaseSignature = () => release();
        scope.ethereum.request = async input => {
          if (input.method === "personal_sign") { scope.__heldSignatures += 1; await held; }
          return original(input);
        };
      });
      const wallet = await watchWallet(fixture.page);
      await visibleButton("Confirm the draw").click();
      await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __heldSignatures: number }).__heldSignatures), { timeout: 10_000 }).toBe(1);
      const waiting = fixture.page.getByRole("button", { name: "Waiting for signature…", exact: true });
      const control = await waiting.elementHandle();
      if (!control) throw new Error("The signature step is not shown.");

      // A real change on the raffle while the signature is open. Without the hold, the next re-read would apply it and
      // reload the seller controls, dropping the signature step.
      await chain.write(chain.raffle, "setPaused", [true]);
      reads = 0;
      await fixture.page.waitForTimeout(35_000);
      expect(reads).toBe(0);
      expect(await control.evaluate(element => element.isConnected && element.getAttribute("aria-busy"))).toBe("true");

      await fixture.page.evaluate(() => (window as unknown as Window & { __releaseSignature(): void }).__releaseSignature());
      await expect.poll(async () => (await chain.service.readRaffle({ id: listed.id })).raffle.revealed, { timeout: 30_000 }).toBe(true);
      expect((await wallet.requests()).map(request => request.method)).toEqual(["personal_sign", "eth_sendTransaction"]);
      expect(await wallet.reviews()).toBe(0);
    } finally {
      await fixture.page.evaluate(() => (window as unknown as Window & { __releaseSignature?(): void }).__releaseSignature?.()).catch(() => {});
      await fixture.page.unroute(`${chain.url}/`);
      await chain.write(chain.raffle, "setPaused", [false]);
    }
    expect(pageErrors).toEqual([]);
  }, 150_000);
});
