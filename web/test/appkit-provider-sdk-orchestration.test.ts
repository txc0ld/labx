import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import UniversalProvider from "@walletconnect/universal-provider";
import type { EthersAdapter } from "@reown/appkit-adapter-ethers";
import type { WalletProvider } from "../lib/chain/types";

type AccountState = { isConnected: boolean; address?: string };
type AppKitState = { open: boolean; connectingWallet?: object };

const sdk = vi.hoisted(() => ({
  adapter: undefined as EthersAdapter | undefined,
  instance: undefined as {
    connectionControllerClient: { connectWalletConnect(): Promise<void> };
    provider?: WalletProvider;
    account: AccountState;
    providerType: string;
    disconnect: ReturnType<typeof vi.fn>;
    accountCallbacks: Set<(state: AccountState) => void>;
    stateCallbacks: Set<(state: AppKitState) => void>;
    emitAccount(): void;
  } | undefined
}));

vi.mock("@reown/appkit", () => ({
  CoreHelperUtil: { generateSdkVersion: () => "html-ethers-1.8.19" },
  AppKit: class {
    connectionControllerClient = { connectWalletConnect: async () => {} };
    provider?: WalletProvider;
    account: AccountState = { isConnected: false };
    providerType = "WALLET_CONNECT";
    accountCallbacks = new Set<(state: AccountState) => void>();
    stateCallbacks = new Set<(state: AppKitState) => void>();
    eventCallbacks = new Set<(state: { data?: { event?: string } }) => void>();
    openState = false;
    constructor(options: { adapters: EthersAdapter[] }) {
      sdk.adapter = options.adapters[0];
      sdk.instance = this;
    }
    ready() { return Promise.resolve(); }
    open() {
      this.openState = true;
      for (const callback of this.stateCallbacks) callback({ open: true });
      return Promise.resolve();
    }
    close() {
      this.openState = false;
      for (const callback of this.stateCallbacks) callback({ open: false });
      return Promise.resolve();
    }
    disconnect = vi.fn(() => sdk.adapter?.disconnect({ id: "walletConnect" }));
    getProvider() { return this.provider; }
    getAccount() { return this.account; }
    getWalletProviderType() { return this.providerType; }
    getState() { return { open: this.openState }; }
    subscribeAccount(callback: (state: AccountState) => void) {
      this.accountCallbacks.add(callback);
      return () => this.accountCallbacks.delete(callback);
    }
    subscribeState(callback: (state: AppKitState) => void) {
      this.stateCallbacks.add(callback);
      return () => this.stateCallbacks.delete(callback);
    }
    subscribeEvents(callback: (state: { data?: { event?: string } }) => void) {
      this.eventCallbacks.add(callback);
      return () => this.eventCallbacks.delete(callback);
    }
    emitAccount() { for (const callback of this.accountCallbacks) callback(this.account); }
  }
}));
vi.mock("@reown/appkit/constants", () => ({ PACKAGE_VERSION: "1.8.19" }));
vi.mock("@reown/appkit/networks", () => ({
  sepolia: {
    id: 11155111,
    caipNetworkId: "eip155:11155111",
    chainNamespace: "eip155",
    name: "Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] } }
  }
}));
vi.mock("../lib/chain/walletconnect-accessibility", () => ({
  observeWalletConnectModal: () => () => {},
  refreshWalletConnectConnectorLists: () => {}
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  sdk.adapter = undefined;
  sdk.instance = undefined;
});

describe("established WalletConnect cleanup orchestration", () => {
  it("does not duplicate a rejected UniversalProvider disconnect or leak an unhandled rejection", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const session = walletConnectSession("reject-before-clear-topic");
    const sessions = new Map([[session.topic, session as object]]);
    const client = Object.assign(new EventEmitter(), {
      core: {
        projectId: "a".repeat(32),
        storage: {
          getItem: vi.fn(async () => undefined),
          setItem: vi.fn(async () => {}),
          removeItem: vi.fn(async () => {}),
          getKeys: vi.fn(async () => [] as string[])
        },
        expirer: { set: vi.fn() },
        relayer: { subscriber: { unsubscribe: vi.fn(async () => {}) } }
      },
      pairing: { getAll: vi.fn(() => []) },
      session: {
        get: vi.fn((topic: string) => sessions.get(topic)),
        getAll: vi.fn(() => [...sessions.values()]),
        get length() { return sessions.size; }
      },
      disconnect: vi.fn(async () => { throw new Error("controlled SignClient disconnect failure"); })
    });
    const universal = new UniversalProvider({
      projectId: "a".repeat(32),
      metadata: { name: "LABx", description: "LABx test", url: "https://labx.test", icons: [] },
      client
    } as never);
    universal.client = client as never;
    universal.session = session as never;
    universal.namespaces = walletConnectNamespaces();

    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider("a".repeat(32));
    const adapter = sdk.adapter as EthersAdapter & { getCaipNetworks: () => never[] };
    adapter.construct({ namespace: "eip155", projectId: "a".repeat(32), adapterType: "ethers" });
    adapter.getCaipNetworks = () => [{ id: 11155111, caipNetworkId: "eip155:11155111", chainNamespace: "eip155" }] as never[];
    await adapter.setUniversalProvider(universal);
    const internals = universal as unknown as { createProviders(): void; onConnect(): void };
    internals.createProviders();
    internals.onConnect();

    const appKit = sdk.instance;
    if (!appKit) throw new Error("AppKit fixture missing");
    appKit.provider = universal as unknown as WalletProvider;
    appKit.account = { isConnected: true, address: "0x1111111111111111111111111111111111111111" };
    const connecting = chooser.connect(new AbortController().signal);
    await appKit.connectionControllerClient.connectWalletConnect();
    appKit.emitAccount();
    await connecting;

    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(chooser.disconnect()).rejects.toThrow(/Reload this page/);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect.soft(client.disconnect).toHaveBeenCalledTimes(1);
      expect.soft(appKit.disconnect).not.toHaveBeenCalled();
      expect.soft(universal.session).toBe(session);
      expect.soft(unhandled).toEqual([]);
      const retry = await createAppKitProvider("a".repeat(32));
      await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/Reload this page/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

function walletConnectSession(topic: string) {
  return {
    topic,
    namespaces: {
      eip155: {
        accounts: ["eip155:11155111:0x1111111111111111111111111111111111111111"],
        methods: ["personal_sign"],
        events: ["accountsChanged", "chainChanged"]
      }
    }
  };
}

function walletConnectNamespaces() {
  return {
    eip155: {
      chains: ["eip155:11155111"],
      methods: ["personal_sign"],
      events: ["accountsChanged", "chainChanged"],
      rpcMap: { "eip155:11155111": "https://ethereum-sepolia-rpc.publicnode.com" }
    }
  };
}
