import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const run = process.env.RUN_INDEPENDENT_CREATE_SELECTION_RACE === "1" ? describe : describe.skip;

async function freePort() {
  return new Promise<number>((yes, no) => {
    const server = createServer();
    server.on("error", no);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return no(new Error("No test port."));
      server.close(() => yes(address.port));
    });
  });
}

async function stop(server?: ChildProcess) {
  if (!server?.pid) return;
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
  await new Promise(resolve => setTimeout(resolve, 300));
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
}

run("Create versus pending NFT selection", () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  let baseUrl = "";
  const output: string[] = [];
  const routePath = resolve("app/verify-independent-create-selection-race");
  const fixturePath = resolve("test/fixtures/independent-create-selection-race-page");
  const distPath = resolve(".next-independent-create-selection-race");
  const nextEnvPath = resolve("next-env.d.ts");
  const tsconfigPath = resolve("tsconfig.json");
  let nextEnv = "";
  let tsconfig = "";

  beforeAll(async () => {
    if (existsSync(routePath) || existsSync(distPath)) throw new Error("Independent Create race fixture path already exists.");
    nextEnv = readFileSync(nextEnvPath, "utf8");
    tsconfig = readFileSync(tsconfigPath, "utf8");
    cpSync(fixturePath, routePath, { recursive: true });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, ALCHEMY_NFT_API_KEY: "", NEXT_PUBLIC_SITE_URL: baseUrl, LABX_NEXT_DIST_DIR: ".next-independent-create-selection-race" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout?.on("data", chunk => output.push(String(chunk)));
    server.stderr?.on("data", chunk => output.push(String(chunk)));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Next exited ${server.exitCode}: ${output.join("")}`);
      try { if ((await fetch(`${baseUrl}/verify-independent-create-selection-race`)).status < 500) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route("**/api/wallet-nfts?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
      ok: true,
      chainId: 11155111,
      items: [{ contract: "0x3333333333333333333333333333333333333333", tokenId: "3", name: "Pending NFT", collection: "Race", image: null }],
      nextCursor: null
    }) }));
    await page.goto(`${baseUrl}/verify-independent-create-selection-race`);
  }, 120_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      await stop(server);
      rmSync(routePath, { recursive: true, force: true });
      rmSync(distPath, { recursive: true, force: true });
      if (nextEnv) writeFileSync(nextEnvPath, nextEnv);
      if (tsconfig) writeFileSync(tsconfigPath, tsconfig);
    }
  });

  it("retires the changed intent and leaves an explicit Create retry available", async () => {
    const form = page.getByRole("region", { name: "Create selection race" });
    await form.getByLabel("Raffle title").fill("Race fixture");
    await form.getByLabel("Sales deadline in UTC").fill("2099-01-01T00:00");
    await form.getByLabel("NFT contract").fill("0x4444444444444444444444444444444444444444");
    await form.getByLabel("Token ID").fill("1");
    for (const input of await form.getByLabel("Price in USDC").all()) await input.fill("1");
    for (const input of await form.getByLabel("Bonus entries").all()) await input.fill("1");
    for (const input of await form.getByLabel("Supply").all()) await input.fill("10");

    await form.getByRole("button", { name: "Choose from wallet" }).click();
    await form.getByRole("button", { name: /Select Pending NFT/ }).click();
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__independentPreparationStarted)).toBe(true);
    await page.evaluate(() => window.__independentResolveOwner?.());
    await page.evaluate(() => window.__independentReleasePreparation?.());

    const create = page.getByRole("button", { name: /Create|Creating/ });
    await expect.poll(() => create.textContent()).toBe("Create");
    expect(await create.isEnabled()).toBe(true);
    await form.getByRole("alert").filter({ hasText: /no longer active|resume/i }).waitFor();
  }, 30_000);
});
