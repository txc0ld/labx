import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletProvider } from "../lib/chain/types";

const sdk = vi.hoisted(() => ({
  configuration: undefined as Record<string, unknown> | undefined,
  instance: undefined as { connectionControllerClient: { connectExternal?(params: unknown): Promise<unknown>; connectWalletConnect?(): Promise<void> } } | undefined,
  appKit: undefined as Record<string, (...args: never[]) => unknown> | undefined,
  activeAdapter: undefined as { connect(params: unknown): Promise<unknown>; connectWalletConnect(chainId?: number | string): Promise<unknown> } | undefined,
  externalConnect: vi.fn(),
  walletConnect: vi.fn(),
  adapterDisconnect: vi.fn(),
  walletConnectProvider: undefined as unknown,
  connectorCallbacks: new Set<() => void>(),
  observeModal: vi.fn((..._args: unknown[]) => vi.fn()),
  refreshConnectorLists: vi.fn()
}));

vi.mock("@reown/appkit", () => ({
  CoreHelperUtil: { generateSdkVersion: vi.fn(() => "html-ethers-1.8.19") },
  AppKit: class {
    connectionControllerClient;
    constructor(options: Record<string, unknown>) {
      sdk.configuration = options;
      sdk.activeAdapter = (options.adapters as typeof sdk.activeAdapter[])[0];
      sdk.instance = this;
      this.connectionControllerClient = {
        connectExternal: async (params: unknown) => {
          await sdk.activeAdapter?.connect(params);
          await sdk.appKit?.close?.();
          return { address: account };
        },
        connectWalletConnect: async () => {
          await sdk.activeAdapter?.connectWalletConnect(11155111);
          await sdk.appKit?.close?.();
        }
      };
    }
    ready() { return sdk.appKit?.ready?.(); }
    open(options: never) { return sdk.appKit?.open?.(options); }
    close() { return sdk.appKit?.close?.(); }
    disconnect(namespace: never) { return sdk.appKit?.disconnect?.(namespace); }
    getProvider(namespace: never) { return sdk.appKit?.getProvider?.(namespace); }
    getAccount(namespace: never) { return sdk.appKit?.getAccount?.(namespace); }
    getWalletProviderType() { return sdk.appKit?.getWalletProviderType?.(); }
    getState() { return sdk.appKit?.getState?.(); }
    subscribeAccount(callback: never, namespace: never) { return sdk.appKit?.subscribeAccount?.(callback, namespace); }
    subscribeState(callback: never) { return sdk.appKit?.subscribeState?.(callback); }
    subscribeEvents(callback: never) { return sdk.appKit?.subscribeEvents?.(callback); }
  }
}));
vi.mock("@reown/appkit/constants", () => ({ PACKAGE_VERSION: "1.8.19" }));
vi.mock("@reown/appkit/networks", () => ({ sepolia: { id: 11155111, chainNamespace: "eip155" } }));
vi.mock("@reown/appkit-controllers", () => ({
  ConnectorController: {
    subscribeKey: vi.fn((_key: string, callback: () => void) => {
      sdk.connectorCallbacks.add(callback);
      return () => sdk.connectorCallbacks.delete(callback);
    })
  }
}));
vi.mock("@reown/appkit-adapter-ethers", () => ({
  EthersAdapter: class {
    connect(params: unknown) { return sdk.externalConnect(params); }
    connectWalletConnect(chainId?: number | string) { return sdk.walletConnect(chainId); }
    disconnect(params: unknown) { return sdk.adapterDisconnect(params); }
    getWalletConnectProvider() { return sdk.walletConnectProvider; }
  }
}));
vi.mock("../lib/chain/walletconnect-accessibility", () => ({
  observeWalletConnectModal: sdk.observeModal,
  refreshWalletConnectConnectorLists: sdk.refreshConnectorLists
}));

const account = "0x1111111111111111111111111111111111111111";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function providerFixture(selectedAccount = account, chain: unknown = "0xaa36a7") {
  const request = vi.fn(async ({ method }: Parameters<WalletProvider["request"]>[0]) => {
    if (method === "eth_chainId") return chain;
    if (method === "eth_accounts") return [selectedAccount];
    throw new Error(`Unexpected request ${method}`);
  });
  return { request } satisfies WalletProvider;
}

function appKitFixture() {
  const states = new Set<(state: { open: boolean }) => void>();
  const accounts = new Set<(state: { isConnected: boolean; address?: string }) => void>();
  const events = new Set<(state: { data: { event: string } }) => void>();
  let provider: WalletProvider | undefined;
  let accountState: { isConnected: boolean; address?: string } = { isConnected: false };
  let providerType = "INJECTED";
  let connectingWallet: object | undefined;
  let openState = false;
  const appKit = {
    ready: vi.fn(async () => {}),
    open: vi.fn(async () => { openState = true; for (const callback of states) callback({ open: true }); }),
    close: vi.fn(async () => { openState = false; for (const callback of states) callback({ open: false }); }),
    disconnect: vi.fn(async () => {}),
    getProvider: vi.fn(() => provider),
    getAccount: vi.fn(() => accountState),
    getWalletProviderType: vi.fn(() => providerType),
    getState: vi.fn(() => ({ connectingWallet, open: openState })),
    subscribeAccount(callback: (state: typeof accountState) => void) { accounts.add(callback); return () => accounts.delete(callback); },
    subscribeState(callback: (state: { open: boolean }) => void) { states.add(callback); return () => states.delete(callback); },
    subscribeEvents(callback: (state: { data: { event: string } }) => void) { events.add(callback); return () => events.delete(callback); }
  };
  sdk.appKit = appKit as unknown as typeof sdk.appKit;
  return {
    appKit,
    connect(nextProvider: WalletProvider, address = account) {
      provider = nextProvider;
      accountState = { isConnected: true, address };
      for (const callback of accounts) callback(accountState);
    },
    emitOpen(open: boolean) { openState = open; for (const callback of states) callback({ open }); },
    close() { openState = false; for (const callback of states) callback({ open: false }); },
    emitEvent(event: string) { for (const callback of events) callback({ data: { event } }); },
    selectWallet() { connectingWallet = {}; },
    runExternal() {
      return sdk.instance?.connectionControllerClient.connectExternal?.({ id: "io.metamask", type: "ANNOUNCED", chainId: 11155111 });
    },
    runWalletConnect() { return sdk.instance?.connectionControllerClient.connectWalletConnect?.(); },
    setProviderType(value: string) { providerType = value; },
    listenerCounts() { return { states: states.size, accounts: accounts.size, events: events.size }; }
  };
}

async function loadProvider() {
  return import("../lib/chain/appkit-provider");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
  sdk.configuration = undefined;
  sdk.instance = undefined;
  sdk.appKit = undefined;
  sdk.activeAdapter = undefined;
  sdk.walletConnectProvider = undefined;
  sdk.connectorCallbacks.clear();
});

describe("official AppKit chooser boundary", () => {
  it("lazily configures the supported Ethers adapter and bridges its exact selected provider", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const selected = providerFixture();
    const { createAppKitProvider } = await loadProvider();
    expect(sdk.configuration).toBeUndefined();
    const chooser = await createAppKitProvider("a".repeat(32));
    const configuration = sdk.configuration;
    expect(configuration).toMatchObject({
      adapters: [expect.anything()],
      networks: [{ id: 11155111 }],
      defaultNetwork: { id: 11155111 },
      enableInjected: true,
      enableEIP6963: true,
      enableCoinbase: false,
      enableReconnect: false,
      enableNetworkSwitch: false,
      features: { analytics: false, email: false, socials: false, onramp: false, swaps: false },
      universalProviderConfigOverride: {
        methods: { eip155: ["eth_sendTransaction", "personal_sign"] },
        events: { eip155: ["accountsChanged", "chainChanged"] },
        rpcMap: { "eip155:11155111": expect.any(String) }
      }
    });
    expect(configuration).not.toHaveProperty("manualWCControl", true);
    const connecting = chooser.connect(new AbortController().signal);
    await vi.waitFor(() => expect(fixture.appKit.open).toHaveBeenCalledWith({ view: "Connect", namespace: "eip155" }));
    await fixture.runExternal();
    fixture.connect(selected);
    const provider = await connecting;
    expect(provider).not.toBe(selected);
    await expect(provider.request({ method: "eth_chainId" })).resolves.toBe("0xaa36a7");
    expect(selected.request).toHaveBeenCalledWith({ method: "eth_chainId" });
    expect(selected.request).toHaveBeenCalledWith({ method: "eth_accounts" });
    expect(fixture.listenerCounts()).toEqual({ states: 0, accounts: 0, events: 0 });
  });

  it("normalizes a numeric UniversalProvider chain and forwards listeners with the raw provider receiver", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const raw = {
      marker: "raw-provider",
      async request(this: { marker: string }, { method }: Parameters<WalletProvider["request"]>[0]) {
        expect(this.marker).toBe("raw-provider");
        if (method === "eth_chainId") return 11155111;
        if (method === "eth_accounts") return [account];
        return "forwarded";
      },
      on(this: { marker: string }, event: string, listener: (...args: unknown[]) => void) {
        expect(this.marker).toBe("raw-provider");
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      },
      removeListener(this: { marker: string }, event: string, listener: (...args: unknown[]) => void) {
        expect(this.marker).toBe("raw-provider");
        listeners.get(event)?.delete(listener);
      }
    } satisfies WalletProvider & { marker: string };
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(raw);
    const provider = await connecting;
    await expect(provider.request({ method: "eth_chainId" })).resolves.toBe("0xaa36a7");
    await expect(provider.request({ method: "wallet_method" })).resolves.toBe("forwarded");

    const changed = vi.fn();
    provider.on?.("chainChanged", changed);
    for (const listener of listeners.get("chainChanged") ?? []) listener(11155111);
    expect(changed).toHaveBeenLastCalledWith("0xaa36a7");
    for (const listener of listeners.get("chainChanged") ?? []) listener("11155111");
    expect(changed).toHaveBeenLastCalledWith("0xaa36a7");
    provider.removeListener?.("chainChanged", changed);
    for (const listener of listeners.get("chainChanged") ?? []) listener(11155111);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe numeric chain identifiers from the selected provider", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture(account, Number.MAX_SAFE_INTEGER + 1));
    await expect(connecting).rejects.toThrow(/invalid network/);
  });

  it("requires reload after singleton initialization fails", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    fixture.appKit.ready.mockRejectedValueOnce(new Error("SDK init failed"));
    const { createAppKitProvider } = await loadProvider();
    await expect(createAppKitProvider("a".repeat(32))).rejects.toThrow(/Reload this page/);
    await expect(createAppKitProvider("a".repeat(32))).rejects.toThrow(/Reload this page/);
    expect(fixture.appKit.ready).toHaveBeenCalledOnce();
  });

  it("rejects provider/account and provider/network mismatches", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const wrongAccount = chooser.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture(), "0x2222222222222222222222222222222222222222");
    await expect(wrongAccount).rejects.toThrow(/approved Ethereum Sepolia account/);
    await vi.waitFor(() => expect(fixture.appKit.close).toHaveBeenCalled());

    const wrongNetwork = chooser.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture(account, "0x1"));
    await expect(wrongNetwork).rejects.toThrow(/approved Ethereum Sepolia account/);
  });

  it("treats modal dismissal as cancellation and removes subscriptions", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    await vi.waitFor(() => expect(fixture.appKit.open).toHaveBeenCalledOnce());
    fixture.close();
    await expect(connecting).rejects.toThrow(/cancelled/);
    expect(fixture.listenerCounts()).toEqual({ states: 0, accounts: 0, events: 0 });
  });

  it("turns an official SDK rejection into a retryable connection error", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    fixture.emitEvent("USER_REJECTED");
    await expect(connecting).rejects.toThrow(/rejected/);
    expect(fixture.listenerCounts()).toEqual({ states: 0, accounts: 0, events: 0 });
  });

  it("does not let an inactive late-loaded chooser close the active chooser", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const { createAppKitProvider } = await loadProvider();
    const active = await createAppKitProvider("a".repeat(32));
    const inactive = await createAppKitProvider("a".repeat(32));
    const connecting = active.connect(new AbortController().signal);
    await vi.waitFor(() => expect(fixture.appKit.open).toHaveBeenCalledOnce());
    await inactive.disconnect();
    expect(fixture.appKit.close).not.toHaveBeenCalled();
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await expect(connecting).resolves.toBeDefined();
  });

  it("refreshes the mounted official connector list when a wallet is announced late", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    class FocusTarget { isConnected = true; focus() {} }
    const focusTarget = new FocusTarget();
    const pageDocument = { activeElement: focusTarget };
    vi.stubGlobal("HTMLElement", FocusTarget);
    vi.stubGlobal("document", pageDocument);
    const fixture = appKitFixture();
    const selected = providerFixture();
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    await vi.waitFor(() => expect(fixture.appKit.open).toHaveBeenCalledOnce());

    for (const callback of sdk.connectorCallbacks) callback();
    expect(sdk.refreshConnectorLists).toHaveBeenCalledOnce();
    await fixture.runExternal();
    fixture.connect(selected);
    await expect(connecting).resolves.toBeDefined();

    sdk.refreshConnectorLists.mockClear();
    for (const callback of sdk.connectorCallbacks) callback();
    expect(sdk.refreshConnectorLists).not.toHaveBeenCalled();
  });

  it("quarantines a cancelled WalletConnect approval, revokes its late topic, then permits retry", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const approval = deferred<{ clientId: null }>();
    sdk.walletConnect.mockImplementationOnce(() => approval.promise);
    const remote: { session?: { topic: string }; disconnect: () => Promise<void> } = {
      session: { topic: "late-topic" },
      disconnect: vi.fn(async () => { remote.session = undefined; })
    };
    sdk.walletConnectProvider = remote;
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const abort = new AbortController();
    const connecting = chooser.connect(abort.signal);
    await vi.waitFor(() => expect(fixture.appKit.open).toHaveBeenCalledOnce());
    fixture.selectWallet();
    const sdkConnection = fixture.runWalletConnect();
    abort.abort();
    await expect(connecting).rejects.toThrow(/cancelled/);
    const blocked = await createAppKitProvider("a".repeat(32));
    await expect(blocked.connect(new AbortController().signal)).rejects.toThrow(/still pending/);
    await new Promise(resolve => setTimeout(resolve, 300));
    await expect(blocked.connect(new AbortController().signal)).rejects.toThrow(/still pending/);
    approval.resolve({ clientId: null });
    await expect(sdkConnection).rejects.toThrow(/cancelled/);
    expect(remote.disconnect).toHaveBeenCalledOnce();
    expect(remote.session).toBeUndefined();
    await vi.waitFor(() => expect(sdk.adapterDisconnect).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    const retry = blocked.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await expect(retry).resolves.toBeDefined();
  });

  it.each(["reject", "incomplete"])("requires reload when cancelled late WalletConnect cleanup is %s", async (failure) => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const approval = deferred<{ clientId: null }>();
    sdk.walletConnect.mockImplementationOnce(() => approval.promise);
    const disconnect = vi.fn(async () => { if (failure === "reject") throw new Error("topic cleanup failed"); });
    sdk.walletConnectProvider = { session: { topic: "uncertain-topic" }, disconnect };
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const abort = new AbortController();
    const connecting = chooser.connect(abort.signal);
    const rejection = connecting.catch(error => error);
    fixture.selectWallet();
    const sdkConnection = fixture.runWalletConnect();
    await vi.waitFor(() => expect(sdk.walletConnect).toHaveBeenCalledOnce());
    abort.abort();
    expect((await rejection as Error).message).toMatch(/cancelled/);

    approval.resolve({ clientId: null });
    await expect(sdkConnection).rejects.toThrow(/Reload this page/);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(sdk.adapterDisconnect).not.toHaveBeenCalled();
    const retry = await createAppKitProvider("a".repeat(32));
    await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/Reload this page/);
  });

  it("requires reload when cleanup of a completed cancelled connector fails", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const controllerClose = deferred<void>();
    fixture.appKit.close.mockImplementationOnce(() => controllerClose.promise).mockResolvedValue(undefined);
    sdk.adapterDisconnect.mockRejectedValueOnce(new Error("permission cleanup failed"));
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const abort = new AbortController();
    const connecting = chooser.connect(abort.signal);
    const rejection = connecting.catch(error => error);
    const sdkConnection = fixture.runExternal();
    await vi.waitFor(() => expect(fixture.appKit.close).toHaveBeenCalledOnce());
    abort.abort();
    expect((await rejection as Error).message).toMatch(/cancelled/);
    controllerClose.resolve();
    await sdkConnection;
    await vi.waitFor(() => expect(sdk.adapterDisconnect).toHaveBeenCalled());

    const retry = await createAppKitProvider("a".repeat(32));
    await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/Reload this page/);
  });

  it("does not let a WalletConnect proposal and an extension choice overlap in one modal attempt", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const approval = deferred<{ clientId: null }>();
    sdk.walletConnect.mockImplementationOnce(() => approval.promise);
    const remote: { session?: { topic: string }; disconnect: () => Promise<void> } = {
      session: { topic: "superseded-topic" },
      disconnect: vi.fn(async () => { remote.session = undefined; })
    };
    sdk.walletConnectProvider = remote;
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connection = chooser.connect(new AbortController().signal);
    const rejected = expect(connection).rejects.toThrow(/still pending/);
    fixture.selectWallet();
    const walletConnect = fixture.runWalletConnect();
    await vi.waitFor(() => expect(sdk.walletConnect).toHaveBeenCalledOnce());
    await expect(fixture.runExternal()).rejects.toThrow(/still pending/);
    await rejected;
    expect(sdk.externalConnect).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 300));
    approval.resolve({ clientId: null });
    await expect(walletConnect).rejects.toThrow(/cancelled/);
    expect(remote.disconnect).toHaveBeenCalledOnce();
    expect(remote.session).toBeUndefined();
  });

  it("keeps an early selected provider when AppKit closes before the adapter operation settles", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const adapter = deferred<{ address: string }>();
    sdk.externalConnect.mockImplementationOnce(() => adapter.promise);
    const selected = providerFixture();
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    const sdkConnection = fixture.runExternal();
    await vi.waitFor(() => expect(sdk.externalConnect).toHaveBeenCalledOnce());

    fixture.connect(selected);
    fixture.close();
    let settled = false;
    void connecting.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    adapter.resolve({ address: account });
    await sdkConnection;
    await expect(connecting).resolves.toBeDefined();
  });

  it("rejects provider replacement before the adapter operation settles", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const adapter = deferred<{ address: string }>();
    sdk.externalConnect.mockImplementationOnce(() => adapter.promise);
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    const rejected = expect(connecting).rejects.toThrow(/selected wallet changed/);
    const sdkConnection = fixture.runExternal();
    await vi.waitFor(() => expect(sdk.externalConnect).toHaveBeenCalledOnce());
    fixture.connect(providerFixture());
    fixture.connect(providerFixture());
    await rejected;
    adapter.resolve({ address: account });
    await expect(sdkConnection).rejects.toThrow(/cancelled/);
  });

  it("holds a cancelled slow modal open until the late chooser is closed", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const prefetch = deferred<void>();
    fixture.appKit.open.mockImplementationOnce(async () => {
      await prefetch.promise;
      fixture.emitOpen(true);
    });
    const lateClose = deferred<void>();
    let closeCount = 0;
    fixture.appKit.close.mockImplementation(async () => {
      closeCount++;
      if (closeCount === 2) await lateClose.promise;
      fixture.emitOpen(false);
    });
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const abort = new AbortController();
    const connecting = chooser.connect(abort.signal);
    await vi.waitFor(() => expect(fixture.appKit.open).toHaveBeenCalledOnce());
    abort.abort();
    await expect(connecting).rejects.toThrow(/cancelled/);

    const retry = await createAppKitProvider("a".repeat(32));
    await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/still pending/);
    prefetch.resolve();
    await vi.waitFor(() => expect(fixture.appKit.close).toHaveBeenCalledTimes(2));
    await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/still pending/);
    lateClose.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));

    const retried = retry.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await expect(retried).resolves.toBeDefined();
  });

  it("awaits WalletConnect cleanup before clearing the connected chooser", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    fixture.setProviderType("WALLET_CONNECT");
    const remoteDisconnect = vi.fn(async () => {});
    sdk.walletConnectProvider = { disconnect: remoteDisconnect };
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await connecting;
    await chooser.disconnect();
    expect(remoteDisconnect).toHaveBeenCalledOnce();
    expect(fixture.appKit.disconnect).toHaveBeenCalledWith("eip155");
    expect(remoteDisconnect.mock.invocationCallOrder[0]).toBeLessThan(fixture.appKit.disconnect.mock.invocationCallOrder[0]);
  });

  it("keeps the singleton cleanup barrier beyond the session cleanup UI timeout", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    fixture.setProviderType("WALLET_CONNECT");
    const remote = deferred<void>();
    const remoteDisconnect = vi.fn(() => remote.promise);
    sdk.walletConnectProvider = { disconnect: remoteDisconnect };
    const [{ createAppKitProvider }, { bounded }] = await Promise.all([loadProvider(), import("../lib/chain/wallet-connectors")]);
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await connecting;

    const cleanup = chooser.disconnect();
    await vi.waitFor(() => expect(remoteDisconnect).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const uiCleanup = bounded(cleanup, 8_000).catch(error => error);
    await vi.advanceTimersByTimeAsync(8_001);
    expect((await uiCleanup as Error).message).toMatch(/timed out/);
    const retry = await createAppKitProvider("a".repeat(32));
    await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/still pending/);
    const passiveCleanup = retry.disconnect();
    await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/still pending/);

    remote.resolve();
    await cleanup;
    await passiveCleanup;
    const retried = retry.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await expect(retried).resolves.toBeDefined();
  });

  it("requires reload when underlying singleton cleanup fails", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    fixture.setProviderType("WALLET_CONNECT");
    sdk.walletConnectProvider = { disconnect: vi.fn(async () => { throw new Error("remote cleanup failed"); }) };
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await connecting;
    await expect(chooser.disconnect()).rejects.toThrow(/Reload this page/);

    const retry = await createAppKitProvider("a".repeat(32));
    await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/Reload this page/);
  });

  it("keeps the singleton barrier while injected AppKit cleanup is pending", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const sdkCleanup = deferred<void>();
    fixture.appKit.disconnect.mockImplementationOnce(() => sdkCleanup.promise);
    const { createAppKitProvider } = await loadProvider();
    const chooser = await createAppKitProvider("a".repeat(32));
    const connecting = chooser.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await connecting;

    const cleanup = chooser.disconnect();
    await vi.waitFor(() => expect(fixture.appKit.disconnect).toHaveBeenCalledOnce());
    const retry = await createAppKitProvider("a".repeat(32));
    await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/still pending/);
    sdkCleanup.resolve();
    await cleanup;
    const retried = retry.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await expect(retried).resolves.toBeDefined();
  });
});
