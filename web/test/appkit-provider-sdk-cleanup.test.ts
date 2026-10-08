import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import UniversalProvider from "@walletconnect/universal-provider";
import type { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { OptionsController } from "@reown/appkit-controllers";
import { sepolia } from "@reown/appkit/networks";
import type { WalletProvider } from "../lib/chain/types";

const sdk = vi.hoisted(() => ({
  adapter: undefined as EthersAdapter | undefined
}));

const prior = {
  metadata: OptionsController.state.metadata,
  enableInjected: OptionsController.state.enableInjected,
  enableEIP6963: OptionsController.state.enableEIP6963,
  enableCoinbase: OptionsController.state.enableCoinbase
};

vi.mock("@reown/appkit", () => ({
  CoreHelperUtil: { generateSdkVersion: () => "html-ethers-1.8.19" },
  AppKit: class {
    connectionControllerClient = {};
    constructor(options: { adapters: EthersAdapter[] }) { sdk.adapter = options.adapters[0]; }
    ready() { return Promise.resolve(); }
  }
}));
vi.mock("@reown/appkit/constants", () => ({ PACKAGE_VERSION: "1.8.19" }));
vi.mock("@reown/appkit/networks", () => ({
  sepolia: { id: 11155111, caipNetworkId: "eip155:11155111", chainNamespace: "eip155" }
}));
vi.mock("../lib/chain/walletconnect-accessibility", () => ({
  observeWalletConnectModal: () => () => {},
  refreshWalletConnectConnectorLists: () => {}
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  sdk.adapter = undefined;
  OptionsController.state.metadata = prior.metadata;
  OptionsController.state.enableInjected = prior.enableInjected;
  OptionsController.state.enableEIP6963 = prior.enableEIP6963;
  OptionsController.state.enableCoinbase = prior.enableCoinbase;
});

describe("cancelled WalletConnect SDK cleanup", () => {
  it("uses UniversalProvider cleanup once, clears its session, and has no late rejection", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const sessions = new Map<string, object>();
    const session = {
      topic: "approved-topic",
      namespaces: {
        eip155: {
          accounts: ["eip155:11155111:0x1111111111111111111111111111111111111111"],
          methods: ["personal_sign"],
          events: ["accountsChanged", "chainChanged"]
        }
      }
    };
    sessions.set(session.topic, session);
    const client = Object.assign(new EventEmitter(), {
      core: {
        projectId: "a".repeat(32),
        storage: {
          getItem: vi.fn(async () => undefined),
          setItem: vi.fn(async () => {}),
          removeItem: vi.fn(async () => {}),
          getKeys: vi.fn(async () => [] as string[])
        },
        expirer: { set: vi.fn() }
      },
      pairing: { getAll: vi.fn(() => []) },
      session: {
        get: vi.fn((topic: string) => {
          const value = sessions.get(topic);
          if (!value) throw new Error(`Missing session ${topic}`);
          return value;
        }),
        getAll: vi.fn(() => [...sessions.values()]),
        get length() { return sessions.size; }
      },
      disconnect: vi.fn(async ({ topic }: { topic: string }) => {
        if (!sessions.delete(topic)) throw new Error(`Session ${topic} was already deleted`);
      })
    });
    const universal = new UniversalProvider({
      projectId: "a".repeat(32),
      metadata: { name: "LABx", description: "LABx test", url: "https://labx.test", icons: [] },
      client
    } as never);
    universal.client = client as never;
    universal.session = session as never;

    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
      await createAppKitProvider("a".repeat(32));
      const adapter = sdk.adapter as EthersAdapter & {
        disconnectCancelled(connectorId: string): Promise<void>;
        getCaipNetworks: () => never[];
      };
      adapter.construct({ namespace: "eip155", projectId: "a".repeat(32), adapterType: "ethers" });
      adapter.getCaipNetworks = () => [];
      await adapter.setUniversalProvider(universal);

      await adapter.disconnectCancelled("walletConnect");
      await new Promise(resolve => setTimeout(resolve, 0));

      expect.soft(client.disconnect).toHaveBeenCalledTimes(1);
      expect.soft(universal.session).toBeUndefined();
      expect.soft(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("waits for the exact wallet-side cleanup event after the session field is cleared", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const storageRelease = deferred<void>();
    const sessions = new Map<string, object>();
    const session = walletConnectSession("wallet-side-deleted-topic");
    sessions.set(session.topic, session);
    const storage = {
      getItem: vi.fn(async () => undefined),
      setItem: vi.fn(async () => {}),
      removeItem: vi.fn(async () => {}),
      getKeys: vi.fn(async () => {
        await storageRelease.promise;
        return [] as string[];
      })
    };
    const client = Object.assign(new EventEmitter(), {
      core: {
        projectId: "a".repeat(32),
        storage,
        expirer: { set: vi.fn() },
        relayer: { subscriber: { unsubscribe: vi.fn(async () => {}) } }
      },
      pairing: { getAll: vi.fn(() => []) },
      session: {
        get: vi.fn((topic: string) => sessions.get(topic)),
        getAll: vi.fn(() => [...sessions.values()]),
        get length() { return sessions.size; }
      },
      disconnect: vi.fn(async () => {})
    });
    const universal = new UniversalProvider({
      projectId: "a".repeat(32),
      metadata: { name: "LABx", description: "LABx test", url: "https://labx.test", icons: [] },
      client
    } as never);
    universal.client = client as never;
    universal.session = session as never;
    universal.namespaces = walletConnectNamespaces();

    const adapter = await loadAdapter();
    await adapter.setUniversalProvider(universal);
    const internals = universal as unknown as {
      createProviders(): void;
      registerEventListeners(): void;
      onConnect(): void;
    };
    internals.createProviders();
    internals.registerEventListeners();
    internals.onConnect();
    expect(adapter.connections).toHaveLength(1);

    sessions.delete(session.topic);
    client.emit("session_delete", { topic: session.topic });
    await vi.waitFor(() => expect(storage.getKeys).toHaveBeenCalledOnce());
    expect(universal.session).toBeUndefined();

    let settled = false;
    const cleanup = adapter.disconnectWalletConnectSession().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    storageRelease.resolve();
    await cleanup;
    expect(adapter.connections).toHaveLength(0);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("completes two local WalletConnect cleanup cycles on the same pinned provider", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const sessions = new Map<string, object>();
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
      disconnect: vi.fn(async ({ topic }: { topic: string }) => {
        if (!sessions.delete(topic)) throw new Error(`Missing session ${topic}`);
      })
    });
    const universal = new UniversalProvider({
      projectId: "a".repeat(32),
      metadata: { name: "LABx", description: "LABx test", url: "https://labx.test", icons: [] },
      client
    } as never);
    universal.client = client as never;
    const adapter = await loadAdapter();
    await adapter.setUniversalProvider(universal);
    const internals = universal as unknown as { createProviders(): void; onConnect(): void };

    for (const topic of ["local-topic-one", "local-topic-two"]) {
      const session = walletConnectSession(topic);
      sessions.set(topic, session);
      universal.session = session as never;
      universal.namespaces = walletConnectNamespaces();
      internals.createProviders();
      internals.onConnect();
      expect(adapter.connections).toHaveLength(1);

      await adapter.disconnectWalletConnectSession();
      await adapter.disconnect({ id: "walletConnect" });
      expect(universal.session).toBeUndefined();
      expect(adapter.connections).toHaveLength(0);
    }
    expect(client.disconnect).toHaveBeenCalledTimes(2);
  });

  it("rejects when local UniversalProvider cleanup fails after clearing its session", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const sessions = new Map<string, object>();
    const session = walletConnectSession("failed-local-cleanup-topic");
    sessions.set(session.topic, session);
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
      disconnect: vi.fn(async ({ topic }: { topic: string }) => { sessions.delete(topic); })
    });
    const universal = new UniversalProvider({
      projectId: "a".repeat(32),
      metadata: { name: "LABx", description: "LABx test", url: "https://labx.test", icons: [] },
      client
    } as never);
    universal.client = client as never;
    universal.session = session as never;
    universal.namespaces = walletConnectNamespaces();
    const adapter = await loadAdapter();
    await adapter.setUniversalProvider(universal);
    const internals = universal as unknown as {
      cleanupStorage(): Promise<void>;
      createProviders(): void;
      onConnect(): void;
    };
    internals.cleanupStorage = vi.fn(async () => { throw new Error("controlled storage cleanup failure"); });
    internals.createProviders();
    internals.onConnect();

    await expect(adapter.disconnectWalletConnectSession()).rejects.toThrow("controlled storage cleanup failure");
    expect(universal.session).toBeUndefined();
    expect(adapter.connections).toHaveLength(1);
  });
});

describe("LABx EthersAdapter compatibility cleanup", () => {
  it("disconnects and reconnects the pinned legacy injected connector", async () => {
    const calls: string[] = [];
    const browser = new EventTarget() as EventTarget & { ethereum?: WalletProvider; location: { origin: string } };
    browser.location = { origin: "https://labx.test" };
    browser.ethereum = lifecycleProvider("0x8888888888888888888888888888888888888888", calls);
    vi.stubGlobal("window", browser);
    OptionsController.state.metadata = { name: "LABx", description: "LABx test", url: "https://labx.test", icons: [] };
    OptionsController.state.enableInjected = true;
    OptionsController.state.enableEIP6963 = false;
    OptionsController.state.enableCoinbase = false;

    const adapter = await loadAdapter();
    await adapter.syncConnectors();
    const connector = adapter.connectors.find(candidate => candidate.id === "injected");
    expect(connector?.type).toBe("INJECTED");
    const firstAttempt = adapter.beginAttempt();
    await adapter.connect({ id: "injected", type: "INJECTED", chainId: 11155111 });
    adapter.finishChooser(firstAttempt);
    await adapter.disconnect({ id: "injected" });
    const nextAttempt = adapter.beginAttempt();
    await adapter.connect({ id: "injected", type: "INJECTED", chainId: 11155111 });
    adapter.finishChooser(nextAttempt);

    expect(calls.filter(method => method === "eth_requestAccounts")).toHaveLength(2);
    expect(calls).toContain("wallet_revokePermissions");
    expect(adapter.connectors.find(candidate => candidate.id === "injected")).toBe(connector);
    expect(adapter.connections).toHaveLength(1);
  });

  it("uses the same injected teardown for a cancelled approval", async () => {
    const calls: string[] = [];
    const browser = new EventTarget() as EventTarget & { ethereum?: WalletProvider; location: { origin: string } };
    browser.location = { origin: "https://labx.test" };
    browser.ethereum = lifecycleProvider("0x9999999999999999999999999999999999999999", calls);
    vi.stubGlobal("window", browser);
    OptionsController.state.metadata = { name: "LABx", description: "LABx test", url: "https://labx.test", icons: [] };
    OptionsController.state.enableInjected = true;
    OptionsController.state.enableEIP6963 = false;
    OptionsController.state.enableCoinbase = false;

    const adapter = await loadAdapter();
    await adapter.syncConnectors();
    const attempt = adapter.beginAttempt();
    await adapter.connect({ id: "injected", type: "INJECTED", chainId: 11155111 });
    adapter.cancelAttempt(attempt);
    adapter.finishChooser(attempt);
    await attempt.settled;

    expect(adapter.connections).toHaveLength(0);
    expect(calls).toContain("wallet_revokePermissions");
  });

  it("keeps unsupported connector types on the upstream failure path", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const adapter = await loadAdapter();
    adapter.connectors.push({
      id: "unsupported",
      type: "MULTI_CHAIN",
      name: "Unsupported",
      chain: "eip155",
      chains: [],
      provider: lifecycleProvider("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", []) as never
    });

    await expect(adapter.disconnect({ id: "unsupported" })).rejects.toThrow("Unsupported provider type");
  });
});

type LabxAdapter = EthersAdapter & {
  beginAttempt(): LabxAttempt;
  cancelAttempt(attempt: LabxAttempt): void;
  finishChooser(attempt: LabxAttempt): void;
  disconnectCancelled(connectorId: string): Promise<void>;
  disconnectWalletConnectSession(): Promise<void>;
  getCaipNetworks: () => never[];
};

type LabxAttempt = { settled: Promise<void> };

async function loadAdapter(): Promise<LabxAdapter> {
  const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
  await createAppKitProvider("a".repeat(32));
  const adapter = sdk.adapter as LabxAdapter;
  adapter.construct({ namespace: "eip155", projectId: "a".repeat(32), adapterType: "ethers" });
  adapter.getCaipNetworks = () => [sepolia] as never[];
  return adapter;
}

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

function lifecycleProvider(account: string, calls: string[]): WalletProvider {
  return {
    async request({ method }) {
      calls.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "wallet_switchEthereumChain" || method === "wallet_revokePermissions") return null;
      if (method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
      throw new Error(`Unexpected request ${method}`);
    },
    on: vi.fn(),
    removeListener: vi.fn()
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
