import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const run = process.env.RUN_INDEPENDENT_COMPLETE_CREATE_RACE === "1" ? describe : describe.skip;

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

run("CompleteCreate identity refresh race", () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  let baseUrl = "";
  const output: string[] = [];
  const routePath = resolve("app/verify-independent-complete-create-race");
  const fixturePath = resolve("test/fixtures/independent-complete-create-race-page");
  const distPath = resolve(".next-independent-complete-create-race");
  const nextEnvPath = resolve("next-env.d.ts");
  const tsconfigPath = resolve("tsconfig.json");
  let nextEnv = "";
  let tsconfig = "";

  beforeAll(async () => {
    if (existsSync(routePath) || existsSync(distPath)) throw new Error("Independent CompleteCreate fixture path already exists.");
    nextEnv = readFileSync(nextEnvPath, "utf8");
    tsconfig = readFileSync(tsconfigPath, "utf8");
    cpSync(fixturePath, routePath, { recursive: true });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), detached: true,
      env: { ...process.env, NEXT_PUBLIC_SITE_URL: baseUrl, LABX_NEXT_DIST_DIR: ".next-independent-complete-create-race" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout?.on("data", chunk => output.push(String(chunk)));
    server.stderr?.on("data", chunk => output.push(String(chunk)));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Next exited ${server.exitCode}: ${output.join("")}`);
      try { if ((await fetch(`${baseUrl}/verify-independent-complete-create-race`)).status < 500) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage();
    await page.goto(`${baseUrl}/verify-independent-complete-create-race`);
  }, 120_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      if (server?.pid) {
        try { process.kill(-server.pid, "SIGTERM"); } catch {}
        await new Promise(resolve => setTimeout(resolve, 300));
        try { process.kill(-server.pid, "SIGKILL"); } catch {}
      }
      rmSync(routePath, { recursive: true, force: true });
      rmSync(distPath, { recursive: true, force: true });
      if (nextEnv) writeFileSync(nextEnvPath, nextEnv);
      if (tsconfig) writeFileSync(tsconfigPath, tsconfig);
    }
  });

  it("retires the stale preparation without submit and exposes an enabled Create retry", async () => {
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__independentCompletePrepareStarted)).toBe(true);
    await page.getByRole("button", { name: "Creating…", exact: true }).waitFor();
    await page.evaluate(() => window.__independentCompleteRefreshIdentity?.());
    await page.evaluate(() => window.__independentCompleteReleasePrepare?.());

    const create = page.getByRole("button", { name: /Create|Creating/ });
    await expect.poll(() => create.textContent()).toBe("Create");
    expect(await create.isEnabled()).toBe(true);
    expect(await page.evaluate(() => window.__independentCompleteSubmitCalls)).toBe(0);
    await page.getByRole("alert").filter({ hasText: /changed|resume/i }).waitFor();
  }, 20_000);
});
