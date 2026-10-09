import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWalletSession, type WalletChooser } from "../lib/chain/wallet-connectors";
import { consentKey, readWalletConsent, saveWalletConsent } from "../lib/chain/wallet-consent";
import type { WalletProvider } from "../lib/chain/types";

const account = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const project = "a".repeat(32), scope = "3:11155111:raffle:runtime";
function environment() {
  const records = new Map<string, string>();
  const listeners = new Set<(event: { key: string }) => void>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
  const tabRecords = new Map<string, string>();
  const tabStorage = { getItem: (key: string) => tabRecords.get(key) ?? null, setItem: (key: string, value: string) => { tabRecords.set(key, value); }, removeItem: (key: string) => { tabRecords.delete(key); } };
  vi.stubGlobal("window", { sessionStorage: tabStorage, location: { origin: "https://labx.test" }, localStorage: storage, addEventListener: (_name: string, callback: (event: { key: string }) => void) => listeners.add(callback), removeEventListener: (_name: string, callback: (event: { key: string }) => void) => listeners.delete(callback) });
  return { storage, tabStorage, listeners, key: consentKey(project, scope) };
}
function provider(selected = account) {
  const calls: string[] = [];
  const result: WalletProvider = { request: async ({ method }) => {
    calls.push(method);
    if (method === "eth_accounts") return [selected];
    if (method === "eth_chainId") return "0xaa36a7";
    throw new Error(`Forbidden restore method ${method}`);
  } };
  return { result, calls };
}
afterEach(() => vi.unstubAllGlobals());
describe("authorized read-only wallet restoration", () => {
  it("does not load the SDK or query a provider without prior consent", async () => {
    environment();
    const p = provider(); const load = vi.fn();
    const wallet = new BrowserWalletSession(p.result, 11155111, project, load, scope);
    expect(await wallet.restore()).toMatchObject({ kind: "disconnected" });
    expect(load).not.toHaveBeenCalled(); expect(p.calls).toEqual([]);
  });
  it("restores the exact authorized account using only reads and disconnects persistently", async () => {
    const env = environment();
    saveWalletConsent(env.key, { connectorId: "metamask", account, chainId: 11155111 });
    const p = provider();
    const chooser: WalletChooser = { connect: vi.fn(), restore: vi.fn(async () => p.result), disconnect: vi.fn(async () => {}) };
    const wallet = new BrowserWalletSession(undefined, 11155111, project, async () => chooser, scope);
    expect(await wallet.restore()).toMatchObject({ kind: "connected", account, chainId: 11155111 });
    expect(p.calls).toEqual(["eth_accounts", "eth_chainId", "eth_chainId", "eth_accounts"]);
    expect(chooser.connect).not.toHaveBeenCalled();
    wallet.disconnect();
    expect(readWalletConsent(env.key)).toBeNull();
    const reloaded = new BrowserWalletSession(undefined, 11155111, project, vi.fn(), scope);
    expect(await reloaded.restore()).toMatchObject({ kind: "disconnected" });
  });
  it("does not attach a different authorized account or destroy its provider session", async () => {
    const env = environment();
    saveWalletConsent(env.key, { connectorId: "metamask", account, chainId: 11155111 });
    const p = provider(other);
    const chooser: WalletChooser = { connect: vi.fn(), restore: vi.fn(async () => p.result), disconnect: vi.fn(async () => {}) };
    const wallet = new BrowserWalletSession(undefined, 11155111, project, async () => chooser, scope);
    expect(await wallet.restore()).toMatchObject({ kind: "disconnected" });
    expect(chooser.disconnect).not.toHaveBeenCalled();
  });
  it.each(["no accounts", "wrong network", "account changed during second read"])("does not restore %s", async failure => {
    const env = environment();
    saveWalletConsent(env.key, { connectorId: "metamask", account, chainId: 11155111 });
    let accountReads = 0;
    const calls: string[] = [];
    const candidate: WalletProvider = { request: async ({ method }) => {
      calls.push(method);
      if (method === "eth_accounts") { accountReads++; return failure === "no accounts" ? [] : [failure === "account changed during second read" && accountReads > 1 ? other : account]; }
      if (method === "eth_chainId") return failure === "wrong network" ? "0x1" : "0xaa36a7";
      throw new Error(`Unexpected ${method}`);
    } };
    const chooser: WalletChooser = { connect: vi.fn(), restore: vi.fn(async () => candidate), disconnect: vi.fn(async () => {}) };
    const wallet = new BrowserWalletSession(undefined, 11155111, project, async () => chooser, scope);
    expect(await wallet.restore()).toMatchObject({ kind: "disconnected" });
    expect(chooser.disconnect).not.toHaveBeenCalled();
    expect(calls.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
  });
  it("lets explicit disconnect win over a delayed restored provider", async () => {
    const env = environment();
    saveWalletConsent(env.key, { connectorId: "metamask", account, chainId: 11155111 });
    const p = provider();
    let release = (_provider: WalletProvider) => {};
    const wait = new Promise<WalletProvider>(resolve => { release = resolve; });
    const chooser: WalletChooser = { connect: vi.fn(), restore: vi.fn(() => wait), disconnect: vi.fn(async () => {}) };
    const wallet = new BrowserWalletSession(undefined, 11155111, project, async () => chooser, scope);
    const pending = wallet.restore();
    await vi.waitFor(() => expect(chooser.restore).toHaveBeenCalled());
    wallet.disconnect(); release(p.result);
    expect(await pending).toMatchObject({ kind: "disconnected" });
    expect(readWalletConsent(env.key)).toBeNull(); expect(p.calls).toEqual([]);
    expect(chooser.disconnect).not.toHaveBeenCalled();
  });
  it("retires cross-tab restoration without deleting the newer tab's consent", async () => {
    const env = environment();
    saveWalletConsent(env.key, { connectorId: "metamask", account, chainId: 11155111 });
    const p = provider();
    let release = (_provider: WalletProvider) => {};
    const wait = new Promise<WalletProvider>(resolve => { release = resolve; });
    const chooser: WalletChooser = { connect: vi.fn(), restore: vi.fn(() => wait), disconnect: vi.fn(async () => {}) };
    const wallet = new BrowserWalletSession(undefined, 11155111, project, async () => chooser, scope);
    const pending = wallet.restore();
    await vi.waitFor(() => expect(chooser.restore).toHaveBeenCalled());
    const newer = saveWalletConsent(env.key, { connectorId: "another", account: other, chainId: 11155111 });
    for (const callback of env.listeners) callback({ key: env.key });
    release(p.result);
    expect(await pending).toMatchObject({ kind: "disconnected" });
    expect(readWalletConsent(env.key)).toEqual(newer);
    expect(p.calls).toEqual([]);
  });
  it("keeps disconnect across reload when localStorage mutation fails", async () => {
    const env = environment();
    saveWalletConsent(env.key, { connectorId: "metamask", account, chainId: 11155111 });
    vi.spyOn(env.storage, "removeItem").mockImplementation(() => { throw new Error("storage deletion refused"); });
    vi.spyOn(env.storage, "setItem").mockImplementation(() => { throw new Error("storage write refused"); });
    const load = vi.fn();
    const wallet = new BrowserWalletSession(undefined, 11155111, project, load, scope);
    wallet.disconnect();
    expect(env.storage.getItem(env.key)).not.toBeNull();
    expect(readWalletConsent(env.key)).toBeNull();
    const reloaded = new BrowserWalletSession(undefined, 11155111, project, load, scope);
    expect(await reloaded.restore()).toMatchObject({ kind: "disconnected" });
    expect(load).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    saveWalletConsent(env.key, { connectorId: "metamask", account, chainId: 11155111 });
    expect(readWalletConsent(env.key)).not.toBeNull();
  });
  it("reports when neither browser store can persist disconnect", () => {
    const env = environment();
    saveWalletConsent(env.key, { connectorId: "metamask", account, chainId: 11155111 });
    vi.spyOn(env.storage, "removeItem").mockImplementation(() => { throw new Error("refused"); });
    vi.spyOn(env.storage, "setItem").mockImplementation(() => { throw new Error("refused"); });
    vi.spyOn(env.tabStorage, "setItem").mockImplementation(() => { throw new Error("refused"); });
    const wallet = new BrowserWalletSession(undefined, 11155111, project, vi.fn(), scope);
    wallet.disconnect();
    expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
    expect(wallet.getConnectionStatus()).toMatchObject({ kind: "error", message: expect.stringContaining("could not save") });
    vi.restoreAllMocks();
  });
  it("retires pending restoration on disposal and never restores a disposed session", async () => {
    const env = environment();
    saveWalletConsent(env.key, { connectorId: "metamask", account, chainId: 11155111 });
    const p = provider();
    let release = (_provider: WalletProvider) => {};
    const wait = new Promise<WalletProvider>(resolve => { release = resolve; });
    const chooser: WalletChooser = { connect: vi.fn(), restore: vi.fn(() => wait), disconnect: vi.fn(async () => {}) };
    const load = vi.fn(async () => chooser);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, load, scope);
    const pending = wallet.restore();
    await vi.waitFor(() => expect(chooser.restore).toHaveBeenCalled());
    wallet.dispose(); release(p.result);
    expect(await pending).toMatchObject({ kind: "disconnected" });
    expect(await wallet.restore()).toMatchObject({ kind: "disconnected" });
    expect(load).toHaveBeenCalledTimes(1); expect(p.calls).toEqual([]);
  });

});
