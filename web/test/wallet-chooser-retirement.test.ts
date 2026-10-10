import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWalletSession, type WalletChooser } from "../lib/chain/wallet-connectors";
import { consentKey } from "../lib/chain/wallet-consent";
import type { WalletProvider } from "../lib/chain/types";

const project = "a".repeat(32), scope = "pending-explicit-chooser";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function environment() {
  const records = new Map<string, string>();
  const listeners = new Set<(event: { key: string }) => void>();
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); }
  };
  vi.stubGlobal("window", {
    location: { origin: "https://labx.test" }, localStorage: storage, sessionStorage: storage,
    addEventListener: (_: string, listener: (event: { key: string }) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: { key: string }) => void) => listeners.delete(listener)
  });
  return () => { for (const listener of listeners) listener({ key: consentKey(project, scope) }); };
}
const provider: WalletProvider = { request: async ({ method }) => {
  if (method === "eth_accounts") return ["0x1111111111111111111111111111111111111111"];
  if (method === "eth_chainId") return "0xaa36a7";
  throw new Error(`Unexpected wallet method ${method}`);
} };
afterEach(() => vi.unstubAllGlobals());

describe("pending explicit chooser retirement", () => {
  it.each(["cross-tab", "dispose", "disconnect", "cancel"])("preserves %s cleanup intent when the SDK load resolves late", async actor => {
    const revokeInOtherTab = environment();
    const loading = deferred<WalletChooser>();
    const chooser: WalletChooser = { connect: vi.fn(), release: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
    const load = vi.fn(() => loading.promise);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, load, scope);
    const owner = {};
    const connecting = wallet.connect({ owner });
    const outcome = connecting.catch(error => error);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    if (actor === "cross-tab") revokeInOtherTab();
    else if (actor === "dispose") wallet.dispose();
    else if (actor === "disconnect") wallet.disconnect();
    else wallet.cancelConnection(owner);
    loading.resolve(chooser);
    expect(await outcome).toBeInstanceOf(Error);
    const localOnly = actor === "cross-tab" || actor === "dispose";
    await vi.waitFor(() => expect(localOnly ? chooser.release : chooser.disconnect).toHaveBeenCalledOnce());
    expect(localOnly ? chooser.disconnect : chooser.release).not.toHaveBeenCalled();
    expect(chooser.connect).not.toHaveBeenCalled();
    expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
  });

  it.each([false, true])("serializes a later Connect behind the retired load and release (failure: %s)", async fail => {
    const revokeInOtherTab = environment();
    const loading = deferred<WalletChooser>(), released = deferred<void>();
    const old: WalletChooser = {
      connect: vi.fn(), disconnect: vi.fn(async () => {}),
      release: vi.fn(async () => { await released.promise; if (fail) throw new Error("Unconfirmed cleanup"); })
    };
    const next: WalletChooser = { connect: vi.fn(async () => provider), disconnect: vi.fn(async () => {}) };
    const load = vi.fn().mockReturnValueOnce(loading.promise).mockResolvedValueOnce(next);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, load, scope);
    const first = wallet.connect().catch(error => error);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    revokeInOtherTab();
    const second = wallet.connect().catch(error => error);
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    loading.resolve(old);
    await vi.waitFor(() => expect(old.release).toHaveBeenCalledOnce());
    expect(load).toHaveBeenCalledOnce();
    released.resolve();
    expect(await first).toBeInstanceOf(Error);
    if (fail) {
      expect(await second).toBeInstanceOf(Error);
      expect(next.connect).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledOnce();
    } else {
      expect(await second).toMatchObject({ kind: "connected" });
      expect(next.connect).toHaveBeenCalledOnce();
    }
    expect(old.disconnect).not.toHaveBeenCalled();
    expect(old.connect).not.toHaveBeenCalled();
  });
});
