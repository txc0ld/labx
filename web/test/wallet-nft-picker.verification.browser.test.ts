import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const run = process.env.RUN_WALLET_NFT_VERIFICATION === "1" ? describe : describe.skip;
const A = "0x2222222222222222222222222222222222222222";
const B = "0x3333333333333333333333333333333333333333";
const C = "0x5555555555555555555555555555555555555555";
const OLD = "0x4444444444444444444444444444444444444444";

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port."));
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url: string, server: ChildProcess, output: string[]) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next exited ${server.exitCode}: ${output.join("")}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).status < 500) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Next did not start: ${output.join("")}`);
}

function processGroupExists(server: ChildProcess) {
  if (!server.pid) return false;
  try { process.kill(-server.pid, 0); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(server: ChildProcess) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!processGroupExists(server)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !processGroupExists(server);
}

async function stopOwnedServer(server?: ChildProcess) {
  if (!server?.pid || !processGroupExists(server)) return;
  process.kill(-server.pid, "SIGTERM");
  if (await waitForProcessGroupExit(server)) return;
  process.kill(-server.pid, "SIGKILL");
  if (!await waitForProcessGroupExit(server)) throw new Error("Wallet NFT verification server process group did not exit.");
}

run("wallet NFT picker adversarial browser behavior", () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const output: string[] = [];
  const routePath = resolve("app/verify-picker-fixture");
  const fixturePath = resolve("test/fixtures/wallet-nft-picker-page");
  const distPath = resolve(".next-wallet-nft-verification");
  const nextEnvPath = resolve("next-env.d.ts");
  const tsconfigPath = resolve("tsconfig.json");
  let originalNextEnv = "";
  let originalTsconfig = "";
  let ownsRoutePath = false;
  let ownsDistPath = false;
  let baseUrl = "";
  let firstPageCalls = 0;
  let releaseNextPage: (() => void) | undefined;

  beforeAll(async () => {
    if (existsSync(routePath)) throw new Error(`Verification route already exists: ${routePath}`);
    if (existsSync(distPath)) throw new Error(`Verification dist directory already exists: ${distPath}`);
    originalNextEnv = readFileSync(nextEnvPath, "utf8");
    originalTsconfig = readFileSync(tsconfigPath, "utf8");
    ownsRoutePath = true;
    cpSync(fixturePath, routePath, { recursive: true });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    ownsDistPath = true;
    server = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), detached: true, env: { ...process.env, NEXT_PUBLIC_SITE_URL: baseUrl, LABX_NEXT_DIST_DIR: ".next-wallet-nft-verification" }, stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout?.on("data", chunk => output.push(String(chunk)));
    server.stderr?.on("data", chunk => output.push(String(chunk)));
    await waitForServer(`${baseUrl}/verify-picker-fixture`, server, output);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5_000);
    await page.route("**/api/wallet-nfts?**", async route => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (cursor === "next") {
        await new Promise<void>(resolve => { releaseNextPage = resolve; });
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, chainId: 11155111, items: [
          { contract: A, tokenId: "1", name: "First NFT", collection: "Alpha", image: null },
          { contract: B, tokenId: "2", name: "Moved NFT", collection: "Beta", image: null }
        ], nextCursor: "next" }) });
        return;
      }
      firstPageCalls += 1;
      const refreshed = firstPageCalls > 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, chainId: 11155111,
        items: refreshed ? [{ contract: C, tokenId: "3", name: "Fresh NFT", collection: "Gamma", image: null }] : [
          { contract: A, tokenId: "1", name: "First NFT", collection: "Alpha", image: null },
          { contract: C, tokenId: "3", name: "Fresh NFT", collection: "Gamma", image: null }
        ],
        nextCursor: refreshed ? null : "next" }) });
    });
    await page.goto(`${baseUrl}/verify-picker-fixture`, { waitUntil: "domcontentloaded" });
    try { await page.waitForFunction(() => typeof window.__verifyResolveNextOwner === "function"); }
    catch (error) { throw new Error(`${String(error)}\n${output.join("")}\n${(await page.locator("body").innerText()).slice(0, 4_000)}`); }
  }, 45_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await stopOwnedServer(server); }
      finally {
        if (ownsRoutePath) rmSync(routePath, { recursive: true, force: true });
        if (ownsDistPath) rmSync(distPath, { recursive: true, force: true });
        if (originalNextEnv) writeFileSync(nextEnvPath, originalNextEnv);
        if (originalTsconfig) writeFileSync(tsconfigPath, originalTsconfig);
      }
    }
  });

  it("replaces refreshed rows, blocks stale ownership, preserves intervening edits, and remains usable by keyboard", async () => {
    const form = page.getByRole("region", { name: "New draft picker" });
    const open = form.getByRole("button", { name: "Choose from wallet" });
    expect(await open.getAttribute("aria-expanded")).toBe("false");
    await open.focus();
    await page.keyboard.press("Enter");
    expect(await form.getByRole("button", { name: "Close wallet NFTs" }).getAttribute("aria-expanded")).toBe("true");
    await form.getByRole("region", { name: "Wallet NFTs" }).waitFor();
    await form.getByRole("button", { name: /Select First NFT/ }).waitFor();
    const loadMore = form.getByRole("button", { name: "Load more wallet NFTs" });
    await loadMore.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => releaseNextPage).toBeTypeOf("function");
    expect(await loadMore.getAttribute("aria-busy")).toBe("true");
    expect(await loadMore.evaluate(element => element === document.activeElement)).toBe(true);
    releaseNextPage?.();
    await form.getByRole("button", { name: /Select Moved NFT/ }).waitFor();
    expect(await form.getByRole("button", { name: "Load more wallet NFTs" }).count()).toBe(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Refresh");

    await form.getByRole("button", { name: /Select First NFT/ }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => form.getByLabel("NFT contract").inputValue()).toBe(A);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toMatch(/^Selected First NFT/);
    expect(await form.getByLabel("Raffle title").inputValue()).toBe("First NFT");

    await form.getByRole("button", { name: /Select Moved NFT/ }).click();
    await form.getByRole("alert").filter({ hasText: "no longer owns" }).waitFor();
    expect(await form.getByLabel("NFT contract").inputValue()).toBe(A);
    expect(await form.getByRole("button", { name: /First NFT/ }).count()).toBe(1);

    await form.getByRole("button", { name: "Refresh" }).click();
    await form.getByRole("button", { name: /Select Fresh NFT/ }).waitFor();
    expect(await form.getByRole("button", { name: /First NFT|Moved NFT/ }).count()).toBe(0);

    await form.getByRole("button", { name: /Select Fresh NFT/ }).click();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toMatch(/^Verifying ownership for Fresh NFT/);
    expect(await form.getByRole("button", { name: /Verifying ownership for Fresh NFT/ }).getAttribute("aria-busy")).toBe("true");
    await form.getByLabel("Raffle title").fill("");
    await page.evaluate(() => window.__verifyResolveNextOwner?.());
    await expect.poll(() => form.getByLabel("NFT contract").inputValue()).toBe(C);
    expect(await form.getByLabel("Raffle title").inputValue()).toBe("");
    await form.getByRole("status").filter({ hasText: "Selected Fresh NFT" }).waitFor();

    await form.getByRole("button", { name: /Selected Fresh NFT/ }).click();
    await form.getByLabel("NFT contract").fill(OLD);
    await page.evaluate(() => window.__verifyResolveNextOwner?.());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await form.getByLabel("NFT contract").inputValue()).toBe(OLD);

    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const card = form.getByRole("button", { name: /Fresh NFT/ });
      await card.evaluate(element => element.blur());
      for (let step = 0; step < 64 && !await card.evaluate(element => element === document.activeElement); step += 1) await page.keyboard.press("Tab");
      expect(await card.evaluate(element => element === document.activeElement)).toBe(true);
      expect(await card.evaluate(element => element.matches(":focus-visible"))).toBe(true);
      expect(await card.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const evidence = resolve(process.env.LABX_WALLET_NFT_EVIDENCE_DIR ?? ".", `picker-gallery-${width}.png`);
      mkdirSync(resolve(evidence, ".."), { recursive: true });
      await page.screenshot({ path: evidence, fullPage: true });
    }
  }, 30_000);

  it("rejects a pending choice when the existing NFT becomes escrowed", async () => {
    const form = page.getByRole("region", { name: "Existing draft picker" });
    await form.getByRole("button", { name: "Choose from wallet" }).click();
    await form.getByRole("button", { name: /Select Fresh NFT/ }).waitFor();
    await form.getByRole("button", { name: /Select Fresh NFT/ }).click();
    await page.evaluate(() => window.__verifySetEscrowed?.(true));
    const nft = form.locator("input#draft-nft");
    const token = form.locator("input#draft-token");
    await expect.poll(() => nft.isDisabled()).toBe(true);
    await page.evaluate(() => window.__verifyResolveNextOwner?.());
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await nft.inputValue()).toBe(OLD);
    expect(await token.inputValue()).toBe("9");
    expect(await nft.isDisabled()).toBe(true);
    expect(await form.getByRole("button", { name: "Choose from wallet" }).count()).toBe(0);
  }, 20_000);
});
