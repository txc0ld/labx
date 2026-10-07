import { describe, expect, it, vi } from "vitest";
import { BrowserWalletSession, type RemoteWallet } from "../lib/chain/wallet-connectors";
import type { WalletProvider } from "../lib/chain/types";

const account = "0x1111111111111111111111111111111111111111";
const projectId = "a".repeat(32);
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function providerFixture(chain = "0xaa36a7") {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const request = vi.fn(async ({ method }: Parameters<WalletProvider["request"]>[0]): Promise<unknown> => {
    calls.push(method);
    if (method === "eth_chainId") return chain;
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "personal_sign") return "0xab";
    if (method === "eth_sendTransaction") return `0x${"ab".repeat(32)}`;
    throw new Error("Unexpected RPC");
  });
  const provider: WalletProvider = {
    request,
    on(event, listener) { const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); }
  };
  const remote: RemoteWallet = { provider, connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
  return { provider, remote, request, calls, listeners, emit(event: string) { for (const listener of listeners.get(event) ?? []) listener(); } };
}

describe("browser connector authority", () => {
  it("keeps relay loading lazy and preserves injected requests", async () => {
    const f = providerFixture(), load = vi.fn(async () => f.remote);
    const wallet = new BrowserWalletSession(f.provider, 11155111, projectId, load);
    await wallet.refresh();
    expect(load).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["eth_chainId", "eth_accounts"]);
    await wallet.connect("injected");
    expect(f.calls).toContain("wallet_switchEthereumChain");
    expect(f.calls).toContain("eth_requestAccounts");
    expect(load).not.toHaveBeenCalled();
  });
  it.each([undefined, "bad-id"])("does not initialize without usable configuration %s", async value => {
    const load = vi.fn();
    const wallet = new BrowserWalletSession(undefined, 11155111, value, load);
    await expect(wallet.connect("walletconnect")).rejects.toThrow(/configured/);
    expect(load).not.toHaveBeenCalled();
  });
  it("preserves local fixtures and disables only WalletConnect", async () => {
    const f = providerFixture("0x7a69"), load = vi.fn();
    const wallet = new BrowserWalletSession(f.provider, 31337, projectId, load);
    expect((await wallet.connect("injected")).kind).toBe("connected");
    await expect(wallet.connect("walletconnect")).rejects.toThrow(/local/);
    expect(wallet.getSnapshot().kind).toBe("connected");
    expect(load).not.toHaveBeenCalled();
  });
  it("establishes Sepolia through the remote provider and disconnects remotely and locally", async () => {
    const f = providerFixture();
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, async () => f.remote);
    const snapshot = await wallet.connect("walletconnect");
    expect(snapshot).toMatchObject({ kind: "connected", account, chainId: 11155111 });
    expect(f.calls).toEqual(["eth_chainId", "eth_accounts"]);
    wallet.disconnect();
    expect(f.remote.disconnect).toHaveBeenCalledOnce();
    f.emit("accountsChanged");
    expect((await wallet.refresh()).kind).toBe("disconnected");
  });
  it.each(["disconnect", "session_delete"])("retires remote sessions on %s", async event => {
    const f = providerFixture();
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, async () => f.remote);
    await wallet.connect("walletconnect");
    f.emit(event);
    expect(wallet.getSnapshot().kind).toBe("disconnected");
    expect(f.remote.disconnect).toHaveBeenCalledOnce();
  });
  it("rejects wrong networks and permits an explicit retry after rejection", async () => {
    const wrong = providerFixture("0x1"), good = providerFixture();
    const load = vi.fn().mockResolvedValueOnce(wrong.remote).mockResolvedValueOnce(good.remote);
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, load);
    await expect(wallet.connect("walletconnect")).rejects.toThrow(/Sepolia/);
    expect(wallet.getSnapshot().kind).toBe("disconnected");
    expect((await wallet.connect("walletconnect")).kind).toBe("connected");
  });
  it("deduplicates clicks, cancels pending loading and ignores its late provider", async () => {
    const f = providerFixture(), late = deferred<RemoteWallet>(), load = vi.fn(() => late.promise);
    const wallet = new BrowserWalletSession(f.provider, 11155111, projectId, load);
    const first = wallet.connect("walletconnect");
    expect(wallet.connect("walletconnect")).toBe(first);
    const rejected = expect(first).rejects.toThrow(/cancelled/);
    const injected = await wallet.connect("injected");
    late.resolve(f.remote);
    await rejected;
    expect(wallet.getSnapshot()).toEqual(injected);
    expect(f.remote.connect).not.toHaveBeenCalled();
    expect(f.remote.disconnect).toHaveBeenCalledOnce();
  });
  it("rejects a cancelled connection's late approval without touching the retry", async () => {
    const old = providerFixture(), next = providerFixture(), approval = deferred<void>();
    old.remote.connect = vi.fn(() => approval.promise);
    const loading = vi.fn().mockResolvedValueOnce(old.remote).mockResolvedValueOnce(next.remote);
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, loading);
    const cancelled = wallet.connect("walletconnect");
    const rejected = expect(cancelled).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(old.remote.connect).toHaveBeenCalledOnce());
    wallet.disconnect();
    const snapshot = await wallet.connect("walletconnect");
    approval.resolve(); await rejected;
    old.emit("accountsChanged"); old.emit("disconnect");
    expect(wallet.getSnapshot()).toEqual(snapshot);
    expect(next.remote.disconnect).not.toHaveBeenCalled();
  });
  it("ignores retired provider events, including previously captured callbacks", async () => {
    const old = providerFixture(), next = providerFixture();
    const wallet = new BrowserWalletSession(old.provider, 11155111, projectId, async () => next.remote);
    await wallet.connect("injected");
    const callback = [...old.listeners.get("accountsChanged") ?? []][0];
    const snapshot = await wallet.connect("walletconnect");
    callback?.();
    expect(wallet.getSnapshot()).toEqual(snapshot);
    expect([...old.listeners.values()].every(group => group.size === 0)).toBe(true);
  });
  it("rejects old actions after provider changes during journal acquisition", async () => {
    const old = providerFixture(), next = providerFixture(), gate = deferred<void>(), entered = deferred<void>();
    const wallet = new BrowserWalletSession(old.provider, 11155111, projectId, async () => next.remote);
    const expected = await wallet.connect("injected");
    if (expected.kind !== "connected") throw new Error("No fixture session");
    const sending = wallet.requestTransaction(expected, { to: account, value: 0n, data: "0x" }, async () => { entered.resolve(); await gate.promise; });
    const rejected = expect(sending).rejects.toThrow(/changed/);
    await entered.promise;
    await wallet.connect("walletconnect");
    gate.resolve(); await rejected;
    expect(old.calls).not.toContain("eth_sendTransaction");
    expect(next.calls).not.toContain("eth_sendTransaction");
  });
  it("rejects old signature preparation and stale refresh results after switching providers", async () => {
    const old = providerFixture(), next = providerFixture(), chain = deferred<unknown>();
    const wallet = new BrowserWalletSession(old.provider, 11155111, projectId, async () => next.remote);
    const expected = await wallet.connect("injected");
    if (expected.kind !== "connected") throw new Error("No fixture session");
    old.request.mockImplementationOnce(() => chain.promise);
    const signing = wallet.signMessage({ expected, message: "LABx test authorization" });
    const rejected = expect(signing).rejects.toThrow(/changed/);
    const snapshot = await wallet.connect("walletconnect");
    chain.resolve("0xaa36a7"); await rejected;
    expect(wallet.getSnapshot()).toEqual(snapshot);
    expect(old.calls).not.toContain("personal_sign");
    expect(next.calls).not.toContain("personal_sign");
  });
  it("does not allow disposed sessions to reconnect or sign", async () => {
    const f = providerFixture();
    const wallet = new BrowserWalletSession(f.provider, 11155111, projectId, async () => f.remote);
    const expected = await wallet.connect();
    if (expected.kind !== "connected") throw new Error("No fixture session");
    wallet.dispose();
    await expect(wallet.signMessage({ expected, message: "LABx authorization" })).rejects.toThrow();
    expect(() => wallet.connect()).toThrow(/disposed/);
    expect(f.calls).not.toContain("personal_sign");
  });
  it.each(["Rejected by wallet", "Proposal expired"])("handles %s without adopting a session", async reason => {
    const f = providerFixture();
    f.remote.connect = vi.fn(async () => { throw new Error(reason); });
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, async () => f.remote);
    await expect(wallet.connect("walletconnect")).rejects.toThrow(reason);
    expect(wallet.getSnapshot().kind).toBe("disconnected");
    expect(wallet.getConnectionStatus().kind).toBe("error");
    expect(f.remote.disconnect).toHaveBeenCalledOnce();
  });

});
