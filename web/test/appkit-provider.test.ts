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
  walletConnectProvider: undefined as unknown
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
vi.mock("@reown/appkit-adapter-ethers", () => ({
  EthersAdapter: class {
    connect(params: unknown) { return sdk.externalConnect(params); }
    connectWalletConnect(chainId?: number | string) { return sdk.walletConnect(chainId); }
    disconnect(params: unknown) { return sdk.adapterDisconnect(params); }
    getWalletConnectProvider() { return sdk.walletConnectProvider; }
  }
}));

const account = "0x1111111111111111111111111111111111111111";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function providerFixture(selectedAccount = account, chain = "0xaa36a7") {
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
  const appKit = {
    ready: vi.fn(async () => {}),
    open: vi.fn(async () => { for (const callback of states) callback({ open: true }); }),
    close: vi.fn(async () => { for (const callback of states) callback({ open: false }); }),
    disconnect: vi.fn(async () => {}),
    getProvider: vi.fn(() => provider),
    getAccount: vi.fn(() => accountState),
    getWalletProviderType: vi.fn(() => providerType),
    getState: vi.fn(() => ({ connectingWallet })),
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
    close() { for (const callback of states) callback({ open: false }); },
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
});

describe("official AppKit chooser boundary", () => {
  it("lazily configures the supported Ethers adapter and returns its exact selected provider", async () => {
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
    await expect(connecting).resolves.toBe(selected);
    expect(selected.request).toHaveBeenCalledWith({ method: "eth_chainId" });
    expect(selected.request).toHaveBeenCalledWith({ method: "eth_accounts" });
    expect(fixture.listenerCounts()).toEqual({ states: 0, accounts: 0, events: 0 });
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

  it("quarantines a cancelled WalletConnect approval, revokes its late topic, then permits retry", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const approval = deferred<{ clientId: null }>();
    sdk.walletConnect.mockImplementationOnce(() => approval.promise);
    const revoke = vi.fn(async () => {});
    sdk.walletConnectProvider = { session: { topic: "late-topic" }, client: { disconnect: revoke }, disconnect: vi.fn(async () => {}) };
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
    expect(revoke).toHaveBeenCalledWith({ topic: "late-topic", reason: { code: 6000, message: "Connection cancelled" } });
    await vi.waitFor(() => expect(sdk.adapterDisconnect).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    const retry = blocked.connect(new AbortController().signal);
    await fixture.runExternal();
    fixture.connect(providerFixture());
    await expect(retry).resolves.toBeDefined();
  });

  it("does not let a WalletConnect proposal and an extension choice overlap in one modal attempt", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const fixture = appKitFixture();
    const approval = deferred<{ clientId: null }>();
    sdk.walletConnect.mockImplementationOnce(() => approval.promise);
    const revoke = vi.fn(async () => {});
    sdk.walletConnectProvider = { session: { topic: "superseded-topic" }, client: { disconnect: revoke }, disconnect: vi.fn(async () => {}) };
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
    expect(revoke).toHaveBeenCalledWith({ topic: "superseded-topic", reason: { code: 6000, message: "Connection cancelled" } });
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
});
