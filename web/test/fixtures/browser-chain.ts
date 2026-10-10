import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";
import type { Address } from "viem";
import type { LocalChain } from "./local-chain";

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Browser fixture port unavailable."));
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(baseUrl: string, child: ChildProcess, output: string[]) {
  let spawnError: Error | undefined;
  const recordSpawnError = (error: Error) => { spawnError = error; };
  child.once("error", recordSpawnError);
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Next fixture exited ${child.exitCode ?? child.signalCode}.\n${output.join("")}`);
      }
      try {
        const response = await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(500) });
        if (response.status >= 200 && response.status < 500) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Next fixture did not start.\n${output.join("")}`);
  } finally {
    child.removeListener("error", recordSpawnError);
  }
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function signalProcessGroup(server: ChildProcess, signal: NodeJS.Signals) {
  if (server.pid === undefined) return false;
  try {
    process.kill(-server.pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

function processGroupExists(server: ChildProcess) {
  if (server.pid === undefined) return false;
  try {
    process.kill(-server.pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

async function waitForOwnedProcessExit(server: ChildProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = process.platform === "win32" ? server.exitCode === null && server.signalCode === null : processGroupExists(server);
    if (!running) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return process.platform === "win32" ? server.exitCode !== null || server.signalCode !== null : !processGroupExists(server);
}

async function terminateWindowsProcessTree(server: ChildProcess) {
  if (server.pid === undefined || server.exitCode !== null || server.signalCode !== null) return;
  const killer = spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    killer.once("error", reject);
    killer.once("exit", () => resolve());
  }).catch(() => { void server.kill("SIGKILL"); });
  if (!await waitForOwnedProcessExit(server, 3_000)) throw new Error("Next fixture process tree did not exit.");
}

async function terminateOwnedProcessTree(server: ChildProcess) {
  if (process.platform === "win32") return terminateWindowsProcessTree(server);
  if (!signalProcessGroup(server, "SIGTERM")) return;
  if (await waitForOwnedProcessExit(server, 3_000)) return;
  signalProcessGroup(server, "SIGKILL");
  if (!await waitForOwnedProcessExit(server, 3_000)) throw new Error("Next fixture process group did not exit.");
}

async function cleanupFailure(server: ChildProcess, error: unknown): Promise<never> {
  try {
    await terminateOwnedProcessTree(server);
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Next fixture failed and its process tree could not be cleaned up.");
  }
  throw error;
}

async function cleanupBrowserFailure(browser: Awaited<ReturnType<typeof chromium.launch>>, server: ChildProcess, error: unknown): Promise<never> {
  let failure = error;
  try {
    await browser.close();
  } catch (browserError) {
    failure = new AggregateError([error, browserError], "Next fixture failed and its browser could not be closed.");
  }
  return cleanupFailure(server, failure);
}

/** env adds or overrides variables for this fixture's dev server only, such as a public feature flag with its own LABX_NEXT_DIST_DIR. */
export async function browserChain(chain: LocalChain, initialAccount: Address = chain.seller, mineConfirmation = true, env: Record<string, string> = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output: string[] = [];
  const server = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      LABX_STORE: "memory",
      NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST: JSON.stringify({
        version: chain.manifest.version,
        chainId: chain.manifest.chainId,
        address: chain.manifest.address,
        runtimeCodeHash: chain.manifest.runtimeCodeHash,
        usdc: chain.manifest.usdc,
        deploymentBlock: chain.manifest.deploymentBlock.toString(),
        expectedOwner: chain.manifest.expectedOwner,
        expectedPolicy: { ...chain.manifest.expectedPolicy, subscriptionId: chain.manifest.expectedPolicy.subscriptionId.toString(), minBuyerFeeUsdc: chain.manifest.expectedPolicy.minBuyerFeeUsdc.toString() }
      }),
      NEXT_PUBLIC_LOCAL_RPC_URL: chain.url,
      NEXT_PUBLIC_SITE_URL: baseUrl,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout?.on("data", chunk => output.push(String(chunk)));
  server.stderr?.on("data", chunk => output.push(String(chunk)));
  await waitForServer(baseUrl, server, output).catch(error => cleanupFailure(server, error));

  const executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--no-sandbox"]
  }).catch(error => cleanupFailure(server, error));
  const context = await browser.newContext().catch(error => cleanupBrowserFailure(browser, server, error));
  const notificationBlock = await chain.client.getBlock({ blockTag: "latest" }).catch(error => cleanupBrowserFailure(browser, server, error));
  if (notificationBlock.number === null || notificationBlock.hash === null) {
    return cleanupBrowserFailure(browser, server, new Error("Browser fixture notification checkpoint is unavailable."));
  }
  await context.route(`${baseUrl}/api/notifications?limit=1`, async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: true,
        kind: "available",
        deployment: `${chain.manifest.chainId}:${chain.manifest.address.toLowerCase()}`,
        items: [],
        nextCursor: null,
        range: { fromBlock: chain.manifest.deploymentBlock.toString(), toBlock: notificationBlock.number.toString() },
        finalized: {
          blockNumber: notificationBlock.number.toString(),
          blockHash: notificationBlock.hash,
          occurredAt: new Date(Number(notificationBlock.timestamp) * 1_000).toISOString()
        },
        fresh: true
      })
    });
  }).catch(error => cleanupBrowserFailure(browser, server, error));
  let selectedAccount: string = initialAccount;
  await context.exposeFunction("__labxRpc", async (input: { method: string; params?: readonly unknown[] }) => {
    const result = await chain.rpc(input.method, input.params ?? []);
    if (mineConfirmation && input.method === "eth_sendTransaction") {
      await chain.mine();
      await chain.mine();
    }
    return result;
  }).catch(error => cleanupBrowserFailure(browser, server, error));
  await context.exposeFunction("__labxSelectedAccount", () => selectedAccount).catch(error => cleanupBrowserFailure(browser, server, error));
  await context.exposeFunction("__labxSelectAccount", (account: string) => { selectedAccount = account; }).catch(error => cleanupBrowserFailure(browser, server, error));
  await context.addInitScript(({ chainId }: { chainId: number }) => {
    type Listener = (...args: unknown[]) => void;
    type FixtureWindow = Window & {
      __labxRpc: (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      __labxSelectedAccount: () => Promise<string>;
      __labxSelectAccount: (next: string) => Promise<void>;
      __labxSetAccount: (next: string) => Promise<void>;
      __labxRejectNextSignature: (code: number, message: string) => void;
      ethereum?: unknown;
    };
    const fixture = window as unknown as FixtureWindow;
    const listeners = new Map<string, Set<Listener>>();
    let signatureFailure: { code: number; message: string } | null = null;
    const provider = {
      async request(input: { method: string; params?: readonly unknown[] }) {
        if (input.method === "eth_accounts" || input.method === "eth_requestAccounts") return [await fixture.__labxSelectedAccount()];
        if (input.method === "eth_chainId") return `0x${chainId.toString(16)}`;
        if (input.method === "wallet_switchEthereumChain") return null;
        if (input.method === "personal_sign" && signatureFailure) {
          const failure = signatureFailure;
          signatureFailure = null;
          throw Object.assign(new Error(failure.message), { code: failure.code });
        }
        return fixture.__labxRpc(input);
      },
      on(event: string, listener: Listener) {
        const group = listeners.get(event) ?? new Set<Listener>();
        group.add(listener);
        listeners.set(event, group);
      },
      removeListener(event: string, listener: Listener) {
        listeners.get(event)?.delete(listener);
      }
    };
    fixture.__labxSetAccount = async next => {
      await fixture.__labxSelectAccount(next);
      for (const listener of listeners.get("accountsChanged") ?? []) listener([next]);
    };
    fixture.__labxRejectNextSignature = (code, message) => { signatureFailure = { code, message }; };
    Object.defineProperty(fixture, "ethereum", { configurable: true, value: provider });
  }, { chainId: chain.manifest.chainId }).catch(error => cleanupBrowserFailure(browser, server, error));
  const page = await context.newPage().catch(error => cleanupBrowserFailure(browser, server, error));
  let closed = false;

  return {
    baseUrl,
    browser,
    context,
    page,
    serverOutput: output,
    serverProcessId: server.pid,
    serverProcessGroupId: process.platform === "win32" ? null : server.pid,
    async switchAccount(account: Address) {
      await page.evaluate(async (next: string) =>
        (window as unknown as Window & { __labxSetAccount(next: string): Promise<void> }).__labxSetAccount(next), account);
    },
    async close() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      try { await browser.close(); } catch (error) { failures.push(error); }
      try { await terminateOwnedProcessTree(server); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Browser fixture cleanup failed.");
    }
  };
}
