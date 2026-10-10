import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeEventTopics, encodeFunctionData, erc20Abi, getAbiItem, toHex, zeroHash, type Hex } from "viem";
import type { Route } from "playwright";
import { raffleAbi } from "../lib/chain/abi";
import { workflowMessage } from "../lib/chain/messages";
import { hash } from "../lib/chain/validation";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { browserChain } from "./fixtures/browser-chain";
import { connectWallet } from "./fixtures/connect-wallet";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { watchWallet } from "./fixtures/wallet-watch";

const DRAW = "LABx closes sales and starts the draw automatically. This usually takes a few minutes.";
const SETTLE = "LABx finishes the raffle automatically. This usually takes a few minutes.";
const LATE = "LABx hasn’t run this step yet. You can run it yourself.";

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
    for (const tokenId of [503n, 504n, 505n, 506n, 507n]) await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    // One 27.50 USDC purchase for each listed raffle.
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
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

  /** Lists a sold raffle and runs it, as the runner would, to a drawn winner whose draw is not confirmed yet. */
  async function drawnRaffle(tokenId: bigint, title: string) {
    const listed = await listSoldRaffle(tokenId, title);
    await chain.warp(listed.salesEnd);
    for (const step of ["close", "snapshot", "requestRandomness"] as const) await chain.write(chain.raffle, step, step === "snapshot" ? [listed.id, 100n] : [listed.id], chain.stranger);
    const drawing = await chain.service.readRaffle({ id: listed.id });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 0n]);
    return listed.id;
  }

  /** Holds the first page read of raffle `raffleId` pinned after block `after` until release(). Other reads pass through. */
  async function holdNextRaffleRead(raffleId: bigint, after: bigint) {
    const read = encodeFunctionData({ abi: raffleAbi, functionName: "getRaffle", args: [raffleId] }).toLowerCase();
    let held = false, release = () => {}, continued = Promise.resolve();
    const released = new Promise<void>(resolve => { release = resolve; });
    const handler = async (route: Route) => {
      const body: unknown = route.request().postDataJSON();
      const match = !held && (Array.isArray(body) ? body : [body]).some((request: unknown) => {
        if (!request || typeof request !== "object" || !("method" in request) || request.method !== "eth_call" || !("params" in request) || !Array.isArray(request.params)) return false;
        const [call, block]: unknown[] = request.params;
        return !!call && typeof call === "object" && "data" in call && typeof call.data === "string" && call.data.toLowerCase() === read
          && typeof block === "string" && block.startsWith("0x") && BigInt(block) > after;
      });
      if (!match) return route.continue();
      held = true;
      continued = released.then(() => route.continue());
      await continued;
    };
    await fixture.page.route(`${chain.url}/`, handler);
    return {
      held: () => held,
      async release() {
        release();
        await continued.catch(() => {});
        await fixture.page.unroute(`${chain.url}/`, handler);
      }
    };
  }

  /** Holds every wallet transaction request until window.__releaseSends() runs. */
  async function holdSends() {
    await fixture.page.evaluate(() => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      const scope = window as unknown as Window & { ethereum: { request: Request }; __heldSends: number; __releaseSends(): void };
      const original = scope.ethereum.request.bind(scope.ethereum);
      let release = () => {};
      const held = new Promise<void>(resolve => { release = resolve; });
      scope.__heldSends = 0;
      scope.__releaseSends = () => release();
      scope.ethereum.request = async input => {
        if (input.method === "eth_sendTransaction") { scope.__heldSends += 1; await held; }
        return original(input);
      };
    });
    return {
      count: () => fixture.page.evaluate(() => (window as unknown as Window & { __heldSends: number }).__heldSends),
      release: () => fixture.page.evaluate(() => (window as unknown as Window & { __releaseSends?(): void }).__releaseSends?.())
    };
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
  describe("Confirm the draw stops at every failure and retries only on a click", () => {
    let confirmId: bigint;
    const revealSelector = encodeFunctionData({ abi: raffleAbi, functionName: "reveal", args: [0n, zeroHash, zeroHash, zeroHash] }).slice(0, 10);

    function confirmCard() {
      return fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: "Confirm the draw", exact: true, level: 2 }) });
    }

    async function revealed() {
      return (await chain.service.readRaffle({ id: confirmId })).raffle.revealed;
    }

    beforeAll(async () => {
      confirmId = await drawnRaffle(503n, "Confirm failures raffle");
    }, 120_000);

    it("leaves the step to retry when the draw-setup signature is rejected", async () => {
      await open(`/seller/${confirmId.toString()}`, "Confirm the draw");
      const confirm = confirmCard().getByRole("button", { name: "Confirm the draw", exact: true });
      await confirm.waitFor({ state: "visible", timeout: 15_000 });
      const wallet = await watchWallet(fixture.page);
      await fixture.page.evaluate(() => (window as unknown as { __labxRejectNextSignature(code: number, message: string): void }).__labxRejectNextSignature(4001, "Rejected draw setup"));
      await confirm.click();
      await confirmCard().getByText("Cancelled in your wallet. Nothing was sent.", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      await fixture.page.waitForTimeout(1_500);
      expect((await wallet.requests()).map(request => request.method)).toEqual(["personal_sign"]);
      expect(await wallet.reviews()).toBe(0);
      expect(await confirm.isEnabled()).toBe(true);
      expect(await revealed()).toBe(false);
    }, 90_000);

    it("sends nothing when the saved draw setup fails its integrity check", async () => {
      await open(`/seller/${confirmId.toString()}`, "Confirm the draw");
      const confirm = confirmCard().getByRole("button", { name: "Confirm the draw", exact: true });
      await confirm.waitFor({ state: "visible", timeout: 15_000 });
      let tampered = 0;
      const tamper = async (route: Route) => {
        const response = await route.fetch();
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || !("salt" in body)) throw new Error("The draw setup response has no salt.");
        tampered += 1;
        await route.fulfill({ response, json: { ...body, salt: `0x${"11".repeat(32)}` } });
      };
      await fixture.page.route(`${fixture.baseUrl}/api/reserve/reveal`, tamper);
      try {
        const wallet = await watchWallet(fixture.page);
        await confirm.click();
        await confirmCard().getByText("Recovered commitment failed its integrity check.", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
        await fixture.page.waitForTimeout(1_500);
        expect(tampered).toBe(1);
        expect((await wallet.requests()).map(request => request.method)).toEqual(["personal_sign"]);
        expect(await wallet.reviews()).toBe(0);
        expect(await confirm.isEnabled()).toBe(true);
        expect(await revealed()).toBe(false);
      } finally { await fixture.page.unroute(`${fixture.baseUrl}/api/reserve/reveal`, tamper); }
    }, 90_000);

    it("stops at a rejected confirmation and sends it again only when the seller clicks", async () => {
      await open(`/seller/${confirmId.toString()}`, "Confirm the draw");
      const confirm = confirmCard().getByRole("button", { name: "Confirm the draw", exact: true });
      await confirm.waitFor({ state: "visible", timeout: 15_000 });
      const wallet = await watchWallet(fixture.page);
      await wallet.reject(revealSelector);
      await confirm.click();
      await confirmCard().getByText("Cancelled in your wallet. Nothing was sent.", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      await fixture.page.waitForTimeout(2_000);
      expect((await wallet.requests()).map(request => request.method)).toEqual(["personal_sign", "eth_sendTransaction"]);
      expect(await revealed()).toBe(false);

      await confirmCard().getByRole("button", { name: "Try again", exact: true }).click();
      const retry = confirmCard().getByRole("button", { name: "Confirm the draw", exact: true });
      await retry.waitFor({ state: "visible", timeout: 10_000 });
      await fixture.page.waitForTimeout(2_000);
      expect((await wallet.requests()).map(request => request.method)).toEqual(["personal_sign", "eth_sendTransaction"]);
      expect(await revealed()).toBe(false);

      // The loaded draw setup is reused, so the retry is one wallet confirmation without a new signature.
      await retry.click();
      await expect.poll(revealed, { timeout: 30_000 }).toBe(true);
      const requests = await wallet.requests();
      expect(requests.map(request => request.method)).toEqual(["personal_sign", "eth_sendTransaction", "eth_sendTransaction"]);
      expect(requests[2].data?.startsWith(revealSelector)).toBe(true);
      expect(await wallet.reviews()).toBe(0);
      await automaticCard("Draw confirmed").waitFor({ state: "visible", timeout: 30_000 });
      expect(pageErrors).toEqual([]);
    }, 120_000);
  });

  it("drops a background re-read that lands while Count entries waits for the wallet, so the control is not remounted", async () => {
    const listed = await listSoldRaffle(504n, "Held count raffle");
    await chain.warp(listed.salesEnd);
    await chain.write(chain.raffle, "close", [listed.id], chain.stranger);
    await open(`/seller/${listed.id.toString()}`, DRAW);
    await automaticCard("Sales closed").waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.locator("summary", { hasText: /^Run it yourself$/ }).click();
    const count = visibleButton("Count entries");
    await count.waitFor({ state: "visible", timeout: 10_000 });
    const sends = await holdSends();
    const wallet = await watchWallet(fixture.page);

    // A real change on the raffle, then hold the page's next re-read of it so it lands only after the click.
    const before = await chain.client.getBlockNumber({ cacheTime: 0 });
    const read = await holdNextRaffleRead(listed.id, before);
    try {
      await chain.write(chain.raffle, "setPaused", [true]);
      await expect.poll(() => read.held(), { timeout: 25_000 }).toBe(true);
      await count.click();
      await expect.poll(() => sends.count(), { timeout: 10_000 }).toBe(1);
      const control = await fixture.page.getByRole("button", { name: "Waiting for wallet…", exact: true }).elementHandle();
      if (!control) throw new Error("The wallet step is not shown.");
      await read.release();
      await fixture.page.waitForTimeout(4_000);
      expect(await control.evaluate(element => element.isConnected && element.getAttribute("aria-busy"))).toBe("true");

      await sends.release();
      await expect.poll(async () => (await chain.service.readRaffle({ id: listed.id })).raffle.snapshotted, { timeout: 30_000 }).toBe(true);
      const requests = await wallet.requests();
      expect(requests.map(request => request.method)).toEqual(["eth_sendTransaction"]);
      expect(decodeFunctionData({ abi: raffleAbi, data: requests[0].data as Hex })).toEqual({ functionName: "snapshot", args: [listed.id, 100n] });
      expect(await wallet.reviews()).toBe(0);
      await automaticCard("Entries counted").waitFor({ state: "visible", timeout: 30_000 });
    } finally {
      await sends.release().catch(() => {});
      await read.release().catch(() => {});
      await chain.write(chain.raffle, "setPaused", [false]);
    }
    expect(pageErrors).toEqual([]);
  }, 150_000);

  it("gives a draw step back to the seller once LABx is 30 minutes late, on the raffle page and the Studio card", async () => {
    const listed = await listSoldRaffle(505n, "Overdue raffle");
    await chain.warp(listed.salesEnd + 1_800n);
    await open(`/seller/${listed.id.toString()}`, LATE);
    const closing = fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: "Close sales", exact: true, level: 2 }) });
    expect(await closing.getByText(LATE, { exact: true }).isVisible()).toBe(true);
    expect(await fixture.page.locator("summary", { hasText: /^Run it yourself$/ }).count()).toBe(0);
    expect(await fixture.page.getByText(DRAW, { exact: true }).count()).toBe(0);
    await evidence("runner-late-1280");

    const wallet = await watchWallet(fixture.page);
    await closing.getByRole("button", { name: "Close sales", exact: true }).click();
    const counting = fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: "Count entries", exact: true, level: 2 }) });
    await counting.getByText(LATE, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    expect((await chain.service.readRaffle({ id: listed.id })).raffle.phase).toBe(2);
    const requests = await wallet.requests();
    expect(requests.map(request => request.method)).toEqual(["eth_sendTransaction"]);
    expect(decodeFunctionData({ abi: raffleAbi, data: requests[0].data as Hex })).toEqual({ functionName: "close", args: [listed.id] });
    expect(await wallet.reviews()).toBe(0);

    await open("/seller", "Overdue raffle");
    const card = fixture.page.locator("section[aria-labelledby='seller-raffles-title'] li").filter({ hasText: "Overdue raffle" });
    expect(await card.getByRole("link").getAttribute("aria-label")).toBe("Count entries: Overdue raffle");
    expect(await card.getByText(DRAW, { exact: true }).count()).toBe(0);
    expect(pageErrors).toEqual([]);
  }, 120_000);

  /** Marks the open page, so a later check can tell it was never reloaded. */
  async function markPage() {
    await fixture.page.evaluate(() => { (window as unknown as Window & { __labxStayedOpen?: boolean }).__labxStayedOpen = true; });
    return async () => fixture.page.evaluate(() => (window as unknown as Window & { __labxStayedOpen?: boolean }).__labxStayedOpen === true);
  }

  function stepCard(title: string) {
    return fixture.page.locator("section.workflow-next").filter({ has: fixture.page.getByRole("heading", { name: title, exact: true, level: 2 }) });
  }

  it("gives a draw step back to the seller on a page that stays open past the 30 minutes", async () => {
    const listed = await listSoldRaffle(506n, "Open page raffle");
    await chain.warp(listed.salesEnd);
    await open(`/seller/${listed.id.toString()}`, DRAW);
    await automaticCard("Sales ended").waitFor({ state: "visible", timeout: 15_000 });
    const stayedOpen = await markPage();

    // Chain time passes the 30 minutes while the page stays open. Nobody presses Refresh.
    await chain.warp(listed.salesEnd + 1_800n);
    await stepCard("Close sales").getByText(LATE, { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    expect(await stayedOpen()).toBe(true);
    expect(await fixture.page.getByText(DRAW, { exact: true }).count()).toBe(0);
    expect(await fixture.page.locator("summary", { hasText: /^Run it yourself$/ }).count()).toBe(0);
    expect(await visibleButton("Close sales").count()).toBe(1);
    expect((await chain.service.readRaffle({ id: listed.id })).raffle.phase).toBe(1);
    expect(pageErrors).toEqual([]);
  }, 120_000);

  it("leaves finishing to LABx for 30 minutes after the page sees a late confirmation, then gives it back on the open page", async () => {
    const raffleId = await drawnRaffle(507n, "Late confirmation raffle");
    const drawn = await chain.service.readRaffle({ id: raffleId });
    // The seller confirms the draw a day after it, long past the draw's own 30 minutes.
    await chain.warp(drawn.raffle.drawnAt + 86_400n);
    await open(`/seller/${raffleId.toString()}`, "Confirm the draw");
    await stepCard("Confirm the draw").getByRole("button", { name: "Confirm the draw", exact: true }).click();
    const finishing = automaticCard("Draw confirmed");
    await finishing.waitFor({ state: "visible", timeout: 30_000 });
    expect((await chain.service.readRaffle({ id: raffleId })).raffle.revealed).toBe(true);
    expect(await finishing.getByText(SETTLE, { exact: true }).isVisible()).toBe(true);
    expect(await fixture.page.getByText(LATE, { exact: true }).count()).toBe(0);
    expect(await visibleButton("Finish raffle").count()).toBe(0);
    const stayedOpen = await markPage();

    // The page read the confirmation at or before the latest block, so 30 minutes after that block the step is late.
    const seen = (await chain.client.getBlock({ blockTag: "latest" })).timestamp;
    await chain.warp(seen + 1_800n);
    await stepCard("Finish raffle").getByText(LATE, { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    expect(await stayedOpen()).toBe(true);
    expect(await fixture.page.getByText(SETTLE, { exact: true }).count()).toBe(0);
    expect((await chain.service.readRaffle({ id: raffleId })).raffle.phase).toBe(4);
    expect(pageErrors).toEqual([]);
  }, 150_000);

  /** Answers the page's reads of Revealed events with a node error until release(). Other reads pass through. */
  async function failRevealReads() {
    const revealed = encodeEventTopics({ abi: raffleAbi, eventName: "Revealed" })[0].toLowerCase();
    let failed = 0;
    const handler = async (route: Route) => {
      const body: unknown = route.request().postDataJSON();
      const reveal = !!body && typeof body === "object" && "method" in body && body.method === "eth_getLogs" && "params" in body && Array.isArray(body.params)
        && JSON.stringify(body.params).toLowerCase().includes(revealed);
      if (!reveal) return route.continue();
      failed += 1;
      await route.fulfill({ status: 200, contentType: "application/json", json: { jsonrpc: "2.0", id: "id" in body ? body.id : null, error: { code: -32005, message: "query exceeds max block range" } } });
    };
    await fixture.page.route(`${chain.url}/`, handler);
    return { failed: () => failed, release: () => fixture.page.unroute(`${chain.url}/`, handler) };
  }

  it("times finishing from the draw confirmation's block on a fresh load of the raffle page and the Studio card", async () => {
    const title = "Confirmed earlier raffle";
    // The buyer's 200 USDC from setup covers only the seven raffles listed before this one.
    await chain.write(chain.nft, "mint", [chain.seller, 508n]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
    const raffleId = await drawnRaffle(508n, title);
    const drawn = await chain.service.readRaffle({ id: raffleId });
    // The seller confirms the draw a day after it, long past the draw's own 30 minutes.
    await chain.warp(drawn.raffle.drawnAt + 86_400n);
    await open(`/seller/${raffleId.toString()}`, "Confirm the draw");
    await stepCard("Confirm the draw").getByRole("button", { name: "Confirm the draw", exact: true }).click();
    await automaticCard("Draw confirmed").waitFor({ state: "visible", timeout: 30_000 });
    expect((await chain.service.readRaffle({ id: raffleId })).raffle.revealed).toBe(true);
    const [reveal] = await chain.client.getLogs({ address: chain.raffle.address, event: getAbiItem({ abi: raffleAbi, name: "Revealed" }), args: { id: raffleId }, fromBlock: 0n, strict: true });
    const revealedAt = (await chain.client.getBlock({ blockHash: reveal.blockHash })).timestamp;

    // Right after the confirmation the Studio card also leaves finishing to LABx, though the draw is a day old.
    const card = fixture.page.locator("section[aria-labelledby='seller-raffles-title'] li").filter({ hasText: title });
    await open("/seller", title);
    await card.getByText(SETTLE, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.waitForTimeout(2_000);
    expect(await card.getByRole("link").getAttribute("aria-label")).toBe(`View: ${title}`);

    // 30 minutes after the confirmation's block, nobody has finished the raffle.
    await chain.warp(revealedAt + 1_800n);

    // When the Revealed event can't be read, a fresh load waits 30 minutes from its own first read instead.
    const reads = await failRevealReads();
    try {
      await open(`/seller/${raffleId.toString()}`, SETTLE);
      await expect.poll(() => reads.failed(), { timeout: 15_000 }).toBeGreaterThan(0);
      await fixture.page.waitForTimeout(2_000);
      expect(await automaticCard("Draw confirmed").getByText(SETTLE, { exact: true }).isVisible()).toBe(true);
      expect(await fixture.page.getByText(LATE, { exact: true }).count()).toBe(0);
      expect(await visibleButton("Finish raffle").count()).toBe(0);
      const failedOnPage = reads.failed();
      await open("/seller", title);
      await expect.poll(() => reads.failed(), { timeout: 15_000 }).toBeGreaterThan(failedOnPage);
      await fixture.page.waitForTimeout(2_000);
      expect(await card.getByText(SETTLE, { exact: true }).isVisible()).toBe(true);
      expect(await card.getByRole("link").getAttribute("aria-label")).toBe(`View: ${title}`);
    } finally { await reads.release(); }

    // A fresh load that reads the event gives finishing back at once, on the raffle page and the Studio card.
    await open(`/seller/${raffleId.toString()}`, LATE);
    expect(await stepCard("Finish raffle").getByText(LATE, { exact: true }).isVisible()).toBe(true);
    expect(await visibleButton("Finish raffle").count()).toBe(1);
    expect(await fixture.page.getByText(SETTLE, { exact: true }).count()).toBe(0);
    expect(await fixture.page.locator("summary", { hasText: /^Run it yourself$/ }).count()).toBe(0);
    await evidence("finish-late-fresh-load-1280");
    await open("/seller", title);
    await expect.poll(() => card.getByRole("link").getAttribute("aria-label"), { timeout: 15_000 }).toBe(`Finish raffle: ${title}`);
    expect(await card.getByText("Draw confirmed", { exact: true }).isVisible()).toBe(true);
    expect(await card.getByText(SETTLE, { exact: true }).count()).toBe(0);
    expect((await chain.service.readRaffle({ id: raffleId })).raffle.phase).toBe(4);
    expect(pageErrors).toEqual([]);
  }, 180_000);
});
