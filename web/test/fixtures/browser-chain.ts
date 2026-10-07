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

async function waitForServer(baseUrl: string, process: ChildProcess, output: string[]) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Next fixture exited ${process.exitCode}.\n${output.join("")}`);
    try {
      const response = await fetch(baseUrl, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Next fixture did not start.\n${output.join("")}`);
}

export async function browserChain(chain: LocalChain, initialAccount: Address = chain.seller, mineConfirmation = true) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output: string[] = [];
  const server = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LABX_STORE: "memory",
      NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST: JSON.stringify({
        version: chain.manifest.version,
        chainId: chain.manifest.chainId,
        address: chain.manifest.address,
        runtimeCodeHash: chain.manifest.runtimeCodeHash,
        usdc: chain.manifest.usdc,
        deploymentBlock: chain.manifest.deploymentBlock.toString()
      }),
      NEXT_PUBLIC_LOCAL_RPC_URL: chain.url,
      NEXT_PUBLIC_SITE_URL: baseUrl
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout?.on("data", chunk => output.push(String(chunk)));
  server.stderr?.on("data", chunk => output.push(String(chunk)));
  await waitForServer(baseUrl, server, output);

  const executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--no-sandbox"]
  });
  const context = await browser.newContext();
  let selectedAccount: string = initialAccount;
  await context.exposeFunction("__labxRpc", async (input: { method: string; params?: readonly unknown[] }) => {
    const result = await chain.rpc(input.method, input.params ?? []);
    if (mineConfirmation && input.method === "eth_sendTransaction") {
      await chain.mine();
      await chain.mine();
    }
    return result;
  });
  await context.exposeFunction("__labxSelectedAccount", () => selectedAccount);
  await context.exposeFunction("__labxSelectAccount", (account: string) => { selectedAccount = account; });
  await context.addInitScript(({ chainId }: { chainId: number }) => {
    type Listener = (...args: unknown[]) => void;
    type FixtureWindow = Window & {
      __labxRpc: (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      __labxSelectedAccount: () => Promise<string>;
      __labxSelectAccount: (next: string) => Promise<void>;
      __labxSetAccount: (next: string) => Promise<void>;
      ethereum?: unknown;
    };
    const fixture = window as unknown as FixtureWindow;
    const listeners = new Map<string, Set<Listener>>();
    const provider = {
      async request(input: { method: string; params?: readonly unknown[] }) {
        if (input.method === "eth_accounts" || input.method === "eth_requestAccounts") return [await fixture.__labxSelectedAccount()];
        if (input.method === "eth_chainId") return `0x${chainId.toString(16)}`;
        if (input.method === "wallet_switchEthereumChain") return null;
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
    Object.defineProperty(fixture, "ethereum", { configurable: true, value: provider });
  }, { chainId: chain.manifest.chainId });
  const page = await context.newPage();

  return {
    baseUrl,
    browser,
    context,
    page,
    serverOutput: output,
    async switchAccount(account: Address) {
      await page.evaluate(async (next: string) =>
        (window as unknown as Window & { __labxSetAccount(next: string): Promise<void> }).__labxSetAccount(next), account);
    },
    async close() {
      await browser.close();
      server.kill("SIGTERM");
      await new Promise<void>(resolve => {
        if (server.exitCode !== null) return resolve();
        const timeout = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 3_000);
        server.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
    }
  };
}
