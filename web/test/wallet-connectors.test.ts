import { describe, expect, it, vi } from "vitest";
import { BrowserWalletSession, type WalletChooser } from "../lib/chain/wallet-connectors";
import type { WalletProvider } from "../lib/chain/types";

const account = "0x1111111111111111111111111111111111111111";
const otherAccount = "0x2222222222222222222222222222222222222222";
const projectId = "a".repeat(32);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function providerFixture(selectedAccount = account, chain = "0xaa36a7") {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const request = vi.fn(async ({ method }: Parameters<WalletProvider["request"]>[0]): Promise<unknown> => {
    calls.push(method);
    if (method === "eth_chainId") return chain;
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [selectedAccount];
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "personal_sign") return "0xab";
    if (method === "eth_sendTransaction") return `0x${"ab".repeat(32)}`;
    throw new Error(`Unexpected RPC ${method}`);
  });
  const provider: WalletProvider = {
    request,
    on(event, listener) { const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); }
  };
  return {
    provider, request, calls, listeners,
    emit(event: string) { for (const listener of listeners.get(event) ?? []) listener(); }
  };
}

function chooserFixture(provider: WalletProvider) {
  const chooser: WalletChooser = {
    connect: vi.fn(async () => provider),
    disconnect: vi.fn(async () => {})
  };
  return chooser;
}

describe("unified wallet authority", () => {
  it("shows one chooser action and does no passive provider or SDK work", async () => {
    const injected = providerFixture();
    const load = vi.fn(async () => chooserFixture(injected.provider));
    const wallet = new BrowserWalletSession(injected.provider, 11155111, projectId, load);
    expect(wallet.connectionOptions).toEqual([{ connector: "appkit", label: "Connect wallet", unavailable: null }]);
    expect(load).not.toHaveBeenCalled();
    expect(injected.calls).toEqual([]);
    expect((await wallet.refresh()).kind).toBe("disconnected");
    expect(load).not.toHaveBeenCalled();
    expect(injected.calls).toEqual([]);
  });

  it.each([undefined, "bad-id"])("does not initialize the production chooser without usable configuration %s", async value => {
    const load = vi.fn();
    const wallet = new BrowserWalletSession(providerFixture().provider, 11155111, value, load);
    await expect(wallet.connect()).rejects.toThrow(/configured/);
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps the local 31337 fixture behind the same Connect wallet action", async () => {
    const local = providerFixture(account, "0x7a69");
    const load = vi.fn();
    const wallet = new BrowserWalletSession(local.provider, 31337, undefined, load);
    expect(wallet.connectionOptions).toEqual([{ connector: "appkit", label: "Connect wallet", unavailable: null }]);
    expect(await wallet.connect()).toMatchObject({ kind: "connected", account, chainId: 31337 });
    expect(local.calls).toContain("wallet_switchEthereumChain");
    expect(local.calls).toContain("eth_requestAccounts");
    expect(load).not.toHaveBeenCalled();
  });

  it("adopts only the exact provider returned by AppKit", async () => {
    const ambient = providerFixture(account);
    const selected = providerFixture(otherAccount);
    const chooser = chooserFixture(selected.provider);
    const wallet = new BrowserWalletSession(ambient.provider, 11155111, projectId, async () => chooser);
    const snapshot = await wallet.connect();
    expect(snapshot).toMatchObject({ kind: "connected", account: otherAccount, chainId: 11155111 });
    expect(ambient.calls).toEqual([]);
    expect(selected.calls).toEqual(["eth_chainId", "eth_accounts"]);
  });

  it("deduplicates only the same owned attempt", async () => {
    const selected = providerFixture();
    const approval = deferred<WalletProvider>();
    const chooser = chooserFixture(selected.provider);
    chooser.connect = vi.fn(() => approval.promise);
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, async () => chooser);
    const owner = {};
    const first = wallet.connect({ owner });
    expect(wallet.connect({ owner })).toBe(first);
    await expect(wallet.connect({ owner: {} })).rejects.toThrow(/still pending/);
    approval.resolve(selected.provider);
    await expect(first).resolves.toMatchObject({ kind: "connected", account });
  });

  it("cancels only the matching owned attempt and ignores late provider approval", async () => {
    const selected = providerFixture();
    const approval = deferred<WalletProvider>();
    const chooser = chooserFixture(selected.provider);
    chooser.connect = vi.fn(() => approval.promise);
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, async () => chooser);
    const owner = {}, wrongOwner = {};
    const connecting = wallet.connect({ owner });
    const rejected = expect(connecting).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(chooser.connect).toHaveBeenCalledOnce());
    wallet.cancelConnection(wrongOwner);
    expect(wallet.getConnectionStatus().kind).toBe("pending");
    wallet.cancelConnection(owner);
    expect(wallet.getSnapshot().kind).toBe("disconnected");
    approval.resolve(selected.provider);
    await rejected;
    expect(selected.calls).toEqual([]);
    expect(chooser.disconnect).toHaveBeenCalledOnce();
  });

  it("bounds a wallet approval and retires the timed-out chooser", async () => {
    vi.useFakeTimers();
    const selected = providerFixture();
    const chooser = chooserFixture(selected.provider);
    chooser.connect = vi.fn(() => new Promise<WalletProvider>(() => {}));
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, async () => chooser);
    const connecting = wallet.connect();
    const rejected = expect(connecting).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    await vi.runAllTimersAsync();
    expect(chooser.disconnect).toHaveBeenCalledOnce();
    expect(wallet.getSnapshot().kind).toBe("disconnected");
    vi.useRealTimers();
  });

  it("does not let an old owner cancel a newer attempt", async () => {
    const firstProvider = providerFixture(), nextProvider = providerFixture(otherAccount);
    const firstApproval = deferred<WalletProvider>(), nextApproval = deferred<WalletProvider>();
    const firstChooser = chooserFixture(firstProvider.provider), nextChooser = chooserFixture(nextProvider.provider);
    firstChooser.connect = vi.fn(() => firstApproval.promise);
    nextChooser.connect = vi.fn(() => nextApproval.promise);
    const load = vi.fn().mockResolvedValueOnce(firstChooser).mockResolvedValueOnce(nextChooser);
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, load);
    const oldOwner = {};
    const first = wallet.connect({ owner: oldOwner });
    const firstRejected = expect(first).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(firstChooser.connect).toHaveBeenCalledOnce());
    wallet.cancelConnection(oldOwner);
    firstApproval.resolve(firstProvider.provider);
    await firstRejected;
    const newOwner = {};
    const next = wallet.connect({ owner: newOwner });
    wallet.cancelConnection(oldOwner);
    nextApproval.resolve(nextProvider.provider);
    await expect(next).resolves.toMatchObject({ kind: "connected", account: otherAccount });
  });

  it("disconnects the selected chooser and ignores its retired events", async () => {
    const selected = providerFixture();
    const chooser = chooserFixture(selected.provider);
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, async () => chooser);
    await wallet.connect();
    wallet.disconnect();
    expect(wallet.getSnapshot().kind).toBe("disconnected");
    await vi.waitFor(() => expect(chooser.disconnect).toHaveBeenCalledOnce());
    selected.emit("accountsChanged");
    expect((await wallet.refresh()).kind).toBe("disconnected");
  });

  it.each(["disconnect", "session_delete"])("retires the chooser on provider %s", async event => {
    const selected = providerFixture();
    const chooser = chooserFixture(selected.provider);
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, async () => chooser);
    await wallet.connect();
    selected.emit(event);
    expect(wallet.getSnapshot().kind).toBe("disconnected");
    await vi.waitFor(() => expect(chooser.disconnect).toHaveBeenCalledOnce());
  });

  it("rejects the wrong network and permits an explicit retry", async () => {
    const wrong = providerFixture(account, "0x1"), good = providerFixture();
    const load = vi.fn()
      .mockResolvedValueOnce(chooserFixture(wrong.provider))
      .mockResolvedValueOnce(chooserFixture(good.provider));
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, load);
    await expect(wallet.connect()).rejects.toThrow(/Sepolia/);
    expect(wallet.getSnapshot().kind).toBe("disconnected");
    expect(await wallet.connect()).toMatchObject({ kind: "connected", account });
  });

  it("rejects old actions when the selected provider changes during a journal wait", async () => {
    const old = providerFixture(), next = providerFixture(otherAccount);
    const load = vi.fn()
      .mockResolvedValueOnce(chooserFixture(old.provider))
      .mockResolvedValueOnce(chooserFixture(next.provider));
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, load);
    const expected = await wallet.connect();
    if (expected.kind !== "connected") throw new Error("Missing fixture session");
    const gate = deferred<void>(), entered = deferred<void>();
    const sending = wallet.requestTransaction(expected, { to: account, value: 0n, data: "0x" }, async () => { entered.resolve(); await gate.promise; });
    const rejected = expect(sending).rejects.toThrow(/changed/);
    await entered.promise;
    await wallet.connect();
    gate.resolve();
    await rejected;
    expect(old.calls).not.toContain("eth_sendTransaction");
    expect(next.calls).not.toContain("eth_sendTransaction");
  });

  it("rejects stale refresh and signature work after provider replacement", async () => {
    const old = providerFixture(), next = providerFixture(otherAccount);
    const load = vi.fn()
      .mockResolvedValueOnce(chooserFixture(old.provider))
      .mockResolvedValueOnce(chooserFixture(next.provider));
    const wallet = new BrowserWalletSession(undefined, 11155111, projectId, load);
    const expected = await wallet.connect();
    if (expected.kind !== "connected") throw new Error("Missing fixture session");
    const chain = deferred<unknown>();
    old.request.mockImplementationOnce(() => chain.promise);
    const signing = wallet.signMessage({ expected, message: "LABx test authorization" });
    const rejected = expect(signing).rejects.toThrow(/changed/);
    await wallet.connect();
    chain.resolve("0xaa36a7");
    await rejected;
    expect(old.calls).not.toContain("personal_sign");
    expect(next.calls).not.toContain("personal_sign");
  });
});
