import { afterEach, describe, expect, it, vi } from "vitest";
import { hasAuthorizedRestoreSession } from "../lib/chain/appkit-provider";
import { BrowserWalletSession, type WalletChooser } from "../lib/chain/wallet-connectors";
import { consentKey, readWalletConsent, saveWalletConsent } from "../lib/chain/wallet-consent";
import type { WalletProvider } from "../lib/chain/types";

const account = "0x1111111111111111111111111111111111111111";
const replacementAccount = "0x2222222222222222222222222222222222222222";
const project = "a".repeat(32);
const scope = "3:11155111:raffle:independent-wallet-restore";

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function browserEnvironment() {
  const localRecords = new Map<string, string>();
  const tabRecords = new Map<string, string>();
  const storageListeners = new Set<(event: StorageEvent) => void>();
  const localStorage = {
    getItem: (key: string) => localRecords.get(key) ?? null,
    setItem: (key: string, value: string) => { localRecords.set(key, value); },
    removeItem: (key: string) => { localRecords.delete(key); }
  };
  const sessionStorage = {
    getItem: (key: string) => tabRecords.get(key) ?? null,
    setItem: (key: string, value: string) => { tabRecords.set(key, value); },
    removeItem: (key: string) => { tabRecords.delete(key); }
  };
  vi.stubGlobal("window", {
    location: { origin: "https://labx.test" },
    localStorage,
    sessionStorage,
    addEventListener: (name: string, listener: (event: StorageEvent) => void) => {
      if (name === "storage") storageListeners.add(listener);
    },
    removeEventListener: (name: string, listener: (event: StorageEvent) => void) => {
      if (name === "storage") storageListeners.delete(listener);
    }
  });
  return {
    key: consentKey(project, scope),
    localRecords,
    storageChange(key: string) {
      for (const listener of storageListeners) listener({ key } as StorageEvent);
    }
  };
}

function readOnlyProvider(selectedAccount = account, chain = "0xaa36a7") {
  const methods: string[] = [];
  const provider: WalletProvider = {
    request: async ({ method }) => {
      methods.push(method);
      if (method === "eth_accounts") return [selectedAccount];
      if (method === "eth_chainId") return chain;
      throw new Error(`Forbidden provider method during restoration: ${method}`);
    }
  };
  return { provider, methods };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("independent wallet restoration adversarial checks", () => {
  it("does not attach the local injected wallet on reload without an explicit prior consent", async () => {
    browserEnvironment();
    const injected = readOnlyProvider(account, "0x7a69");
    const loadChooser = vi.fn();
    const wallet = new BrowserWalletSession(injected.provider, 31337, undefined, loadChooser, scope);

    await expect(wallet.restore()).resolves.toMatchObject({ kind: "disconnected" });
    expect(injected.methods).toEqual([]);
    expect(loadChooser).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed marker", "{"],
    ["revocation tombstone", "null"],
    ["wrong network", JSON.stringify({ version: 1, connectorId: "fixture", account, chainId: 31337, id: "11111111-1111-1111-1111-111111111111" })]
  ])("fails closed before loading the SDK for a %s", async (_label, marker) => {
    const env = browserEnvironment();
    env.localRecords.set(env.key, marker);
    const loadChooser = vi.fn();
    const wallet = new BrowserWalletSession(undefined, 11155111, project, loadChooser, scope);

    await expect(wallet.restore()).resolves.toMatchObject({ kind: "disconnected" });
    expect(loadChooser).not.toHaveBeenCalled();
  });

  it("invalidates an attached provider when another tab replaces consent and blocks use of the old snapshot", async () => {
    const env = browserEnvironment();
    saveWalletConsent(env.key, { connectorId: "fixture", account, chainId: 11155111 });
    const old = readOnlyProvider();
    const chooser: WalletChooser = {
      connect: vi.fn(),
      restore: vi.fn(async () => old.provider),
      disconnect: vi.fn(async () => {})
    };
    const wallet = new BrowserWalletSession(undefined, 11155111, project, async () => chooser, scope);
    const restored = await wallet.restore();
    expect(restored).toMatchObject({ kind: "connected", account });
    if (restored.kind !== "connected") throw new Error("Expected the independent fixture to restore.");

    const newer = saveWalletConsent(env.key, { connectorId: "replacement", account: replacementAccount, chainId: 11155111 });
    env.storageChange(env.key);

    expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
    await expect(wallet.requestTransaction(restored, {
      to: "0x3333333333333333333333333333333333333333",
      data: "0x",
      value: 0n
    })).rejects.toThrow(/wallet|network|Open this website/i);
    expect(old.methods).toEqual(["eth_accounts", "eth_chainId", "eth_chainId", "eth_accounts"]);
    expect(readWalletConsent(env.key)).toEqual(newer);
    expect(chooser.disconnect).not.toHaveBeenCalled();
  });

  it("lets a new explicit connection win a delayed restore without querying or attaching the late provider", async () => {
    const env = browserEnvironment();
    saveWalletConsent(env.key, { connectorId: "old", account, chainId: 11155111 });
    const old = readOnlyProvider();
    const current = readOnlyProvider(replacementAccount);
    const delayed = deferred<WalletProvider>();
    const chooser: WalletChooser = {
      restore: vi.fn(() => delayed.promise),
      connect: vi.fn(async () => current.provider),
      remember: vi.fn(snapshot => {
        saveWalletConsent(env.key, { connectorId: "new", account: snapshot.account, chainId: snapshot.chainId });
      }),
      disconnect: vi.fn(async () => {})
    };
    const wallet = new BrowserWalletSession(undefined, 11155111, project, async () => chooser, scope);
    const staleRestore = wallet.restore();
    await vi.waitFor(() => expect(chooser.restore).toHaveBeenCalledOnce());

    const explicit = await wallet.connect({ owner: {} });
    delayed.resolve(old.provider);
    await staleRestore;

    expect(explicit).toMatchObject({ kind: "connected", account: replacementAccount, chainId: 11155111 });
    expect(wallet.getSnapshot()).toMatchObject({ kind: "connected", account: replacementAccount, chainId: 11155111 });
    expect(old.methods).toEqual([]);
    expect(current.methods).toEqual(["eth_chainId", "eth_accounts"]);
    expect(chooser.remember).toHaveBeenCalledOnce();
    expect(readWalletConsent(env.key)).toMatchObject({ connectorId: "new", account: replacementAccount });
  });

  it("rejects WalletConnect sessions that cannot report account or chain changes", () => {
    browserEnvironment();
    const consent = saveWalletConsent(consentKey(project, scope), {
      connectorId: "walletConnect",
      account,
      chainId: 11155111
    });
    const base = {
      expiry: Math.floor(Date.now() / 1000) + 600,
      namespaces: {
        eip155: {
          accounts: [`eip155:11155111:${account}`],
          methods: ["personal_sign", "eth_sendTransaction"]
        }
      }
    };

    expect(hasAuthorizedRestoreSession({ session: { ...base, namespaces: { eip155: { ...base.namespaces.eip155, events: ["accountsChanged", "chainChanged"] } } } }, consent)).toBe(true);
    expect(hasAuthorizedRestoreSession({ session: { ...base, namespaces: { eip155: { ...base.namespaces.eip155, events: ["accountsChanged"] } } } }, consent)).toBe(false);
    expect(hasAuthorizedRestoreSession({ session: base }, consent)).toBe(false);
  });
});
