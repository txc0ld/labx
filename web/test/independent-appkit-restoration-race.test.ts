import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppKit } from "@reown/appkit";
import type { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { consentKey, saveWalletConsent } from "../lib/chain/wallet-consent";

const sdk = vi.hoisted(() => ({
  adapter: undefined as EthersAdapter | undefined,
  instance: undefined as AppKit | undefined,
  provider: undefined as object | undefined,
  connectorId: "independent-injected",
  connectorType: "INJECTED",
  selected: "independent-injected",
  accountReads: 0,
  liveAccounts: [] as string[],
  walletConnectTopics: [] as string[],
  walletConnectConnects: 0,
  walletConnectDisconnects: 0,
  disconnectedWalletConnectTopics: [] as string[],
  walletConnectEmitEvents: true,
  walletConnectReplacement: undefined as object | undefined,
  prePublicationGate: undefined as Promise<void> | undefined,
  changeSelectorOnAccountRead: 0,
  changeSelector: (_connector: string) => {},
  storageChange: (_key: string) => {}
}));

vi.mock("@reown/appkit", async importOriginal => {
  const actual = await importOriginal<typeof import("@reown/appkit")>();
  return {
    ...actual,
    AppKit: class extends actual.AppKit {
      constructor(options: ConstructorParameters<typeof actual.AppKit>[0]) {
        super({ ...options, basic: true });
        sdk.instance = this;
      }
      protected override getDefaultMetaData() { return null; }
      protected override initializeThemeController() {}
      protected override async injectModalUi() {}
      override async syncIdentity() {}
      protected override async syncBalance() {}
      protected override async syncWalletConnectAccount() {
        await sdk.prePublicationGate;
        return super.syncWalletConnectAccount();
      }
      protected override async initChainAdapters() {
        const { ConnectorController } = await import("@reown/appkit-controllers");
        const adapter = this.chainAdapters?.eip155 as EthersAdapter;
        sdk.adapter = adapter;
        if (sdk.connectorId === "walletConnect") {
          await adapter.setUniversalProvider(sdk.provider as Parameters<EthersAdapter["setUniversalProvider"]>[0]);
          (this as unknown as { universalProvider: unknown }).universalProvider = sdk.provider;
          ConnectorController.setConnectors(adapter.connectors);
        } else {
          const connector = {
            id: sdk.connectorId,
            name: "Independent fixture",
            type: sdk.connectorType,
            chain: "eip155",
            provider: sdk.provider
          } as EthersAdapter["connectors"][number];
          Object.defineProperty(adapter, "connectors", { configurable: true, get: () => [connector] });
          ConnectorController.setConnectors([connector]);
        }
        ConnectorController.setConnectorId(sdk.selected, "eip155");
        this.listenAdapter("eip155");
        this.initAdapterController();
      }
    }
  };
});

vi.mock("../lib/chain/walletconnect-accessibility", () => ({
  observeWalletConnectModal: () => () => {},
  refreshWalletConnectConnectorLists: () => {}
}));

const account = "0x1111111111111111111111111111111111111111";
const replacementAccount = "0x2222222222222222222222222222222222222222";
const project = "b".repeat(32);
const scope = "independent-actual-sdk-race";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

function approveWalletConnectOnOpen(appKit: AppKit) {
  const controller = (appKit as unknown as {
    connectionControllerClient: { connectWalletConnect?(): Promise<void> };
  }).connectionControllerClient;
  return vi.spyOn(appKit, "open").mockImplementation(async () => {
    if (!controller.connectWalletConnect) throw new Error("The actual WalletConnect controller is unavailable.");
    await controller.connectWalletConnect();
  });
}

async function setupActualSdk(
  changeSelectorOnAccountRead: number,
  connector: "injected" | "walletConnect" = "injected",
  usageGate?: Promise<void>,
  liveAccount = account,
  walletConnectAccounts = [liveAccount],
  prePublicationGate?: Promise<void>,
  options: {
    saveConsent?: boolean;
    initialWalletConnectTopic?: string | null;
    walletConnectTopics?: string[];
  } = {}
) {
  const localRecords = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localRecords.get(key) ?? null,
    setItem: (key: string, value: string) => { localRecords.set(key, value); },
    removeItem: (key: string) => { localRecords.delete(key); }
  };
  const storageListeners = new Set<(event: StorageEvent) => void>();
  vi.stubGlobal("window", {
    location: { origin: "https://labx.test" },
    localStorage,
    addEventListener: (name: string, listener: (event: StorageEvent) => void) => {
      if (name === "storage") storageListeners.add(listener);
    },
    removeEventListener: (name: string, listener: (event: StorageEvent) => void) => {
      if (name === "storage") storageListeners.delete(listener);
    }
  });
  vi.stubGlobal("localStorage", localStorage);
  sdk.accountReads = 0;
  sdk.liveAccounts = [liveAccount];
  sdk.walletConnectTopics = [...(options.walletConnectTopics ?? [])];
  sdk.walletConnectConnects = 0;
  sdk.walletConnectDisconnects = 0;
  sdk.disconnectedWalletConnectTopics = [];
  sdk.walletConnectEmitEvents = true;
  sdk.walletConnectReplacement = undefined;
  sdk.prePublicationGate = prePublicationGate;
  sdk.changeSelectorOnAccountRead = changeSelectorOnAccountRead;
  sdk.connectorId = connector === "walletConnect" ? "walletConnect" : "independent-injected";
  sdk.connectorType = connector === "walletConnect" ? "WALLET_CONNECT" : "INJECTED";
  sdk.selected = sdk.connectorId;
  const methods: string[] = [];
  const provider = new EventEmitter();
  const walletConnectSession = (topic: string) => ({
    topic,
    expiry: Math.floor(Date.now() / 1000) + 600,
    peer: { metadata: { name: "Independent wallet", description: "fixture", url: "https://wallet.test", icons: [] } },
    namespaces: {
      eip155: {
        accounts: walletConnectAccounts.map(selected => `eip155:11155111:${selected}`),
        methods: ["personal_sign", "eth_sendTransaction"],
        events: ["accountsChanged", "chainChanged"]
      }
    }
  });
  const initialWalletConnectTopic = options.initialWalletConnectTopic === undefined
    ? "independent-existing-session"
    : options.initialWalletConnectTopic;
  sdk.provider = Object.assign(provider, connector === "walletConnect" ? {
    session: initialWalletConnectTopic ? walletConnectSession(initialWalletConnectTopic) : undefined,
    client: {
      core: {
        crypto: { getClientId: async () => "independent-client" }
      }
    },
    connect: async () => {
      const topic = sdk.walletConnectTopics.shift();
      if (!topic) throw new Error("No approved WalletConnect topic is available.");
      sdk.walletConnectConnects++;
      Object.assign(provider, { session: walletConnectSession(topic) });
      provider.emit("connect", { session: (provider as { session?: object }).session });
    },
    disconnect: async () => {
      const topic = (provider as { session?: { topic?: string } }).session?.topic;
      sdk.walletConnectDisconnects++;
      if (topic) sdk.disconnectedWalletConnectTopics.push(topic);
      Object.assign(provider, { session: undefined });
      if (sdk.walletConnectReplacement) {
        sdk.provider = sdk.walletConnectReplacement;
        await sdk.adapter?.setUniversalProvider(sdk.walletConnectReplacement as Parameters<EthersAdapter["setUniversalProvider"]>[0]);
        return;
      }
      if (sdk.walletConnectEmitEvents) {
        provider.emit("session_delete", { topic });
        provider.emit("disconnect", { data: topic });
      }
    }
  } : {}, {
    request: async ({ method }: { method: string }) => {
      methods.push(method);
      if (method === "eth_accounts") {
        sdk.accountReads++;
        if (sdk.accountReads === sdk.changeSelectorOnAccountRead) sdk.changeSelector("other-injected");
        return [...sdk.liveAccounts];
      }
      if (method === "eth_chainId") return "0xaa36a7";
      throw new Error(`Forbidden restoration method: ${method}`);
    }
  });
  const { ApiController, ConnectorController, CoreHelperUtil } = await import("@reown/appkit-controllers");
  sdk.changeSelector = connector => ConnectorController.setConnectorId(connector, "eip155");
  sdk.storageChange = key => {
    for (const listener of storageListeners) listener({ key } as StorageEvent);
  };
  vi.spyOn(ApiController, "fetchUsage").mockImplementation(() => usageGate ?? Promise.resolve());
  vi.spyOn(CoreHelperUtil, "isMobile").mockReturnValue(false);
  if (options.saveConsent !== false) {
    saveWalletConsent(consentKey(project, scope), { connectorId: sdk.connectorId, account, chainId: 11155111 });
  }
  return methods;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  sdk.adapter = undefined;
  sdk.instance = undefined;
  sdk.provider = undefined;
  sdk.connectorId = "independent-injected";
  sdk.connectorType = "INJECTED";
  sdk.selected = "independent-injected";
  sdk.accountReads = 0;
  sdk.liveAccounts = [];
  sdk.walletConnectTopics = [];
  sdk.walletConnectConnects = 0;
  sdk.walletConnectDisconnects = 0;
  sdk.disconnectedWalletConnectTopics = [];
  sdk.walletConnectEmitEvents = true;
  sdk.walletConnectReplacement = undefined;
  sdk.prePublicationGate = undefined;
  sdk.changeSelectorOnAccountRead = 0;
  sdk.changeSelector = () => {};
  sdk.storageChange = () => {};
});

describe("independent installed AppKit restoration race", () => {
  it("uses read-only SDK synchronization and rejects a selector change during restore without opening the modal", async () => {
    const methods = await setupActualSdk(2);
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    const open = vi.spyOn(appKit, "open");

    await expect(chooser.restore?.(new AbortController().signal)).resolves.toBeNull();

    expect(methods).toEqual(["eth_accounts", "eth_chainId", "eth_chainId", "eth_accounts"]);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("locally releases an adopted injected SDK connection without requesting wallet permission revocation", async () => {
    const methods = await setupActualSdk(0);
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    const disconnect = vi.spyOn(appKit, "disconnect");

    await expect(chooser.restore?.(new AbortController().signal)).resolves.not.toBeNull();
    const restorationMethods = [...methods];
    await expect(chooser.release?.()).resolves.toBeUndefined();

    expect(methods).toEqual(restorationMethods);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
    expect(methods).not.toContain("wallet_getPermissions");
    expect(methods).not.toContain("wallet_revokePermissions");
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("restores an existing authorized WalletConnect session through actual SDK startup using reads only", async () => {
    const methods = await setupActualSdk(0, "walletConnect");
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    const open = vi.spyOn(appKit, "open");

    expect(appKit.getAccount("eip155")).toMatchObject({ isConnected: true, address: account });
    expect(appKit.getProvider("eip155")).toBe(sdk.provider);
    expect(sdk.adapter?.getWalletConnectProvider()).toBe(sdk.provider);
    await expect(chooser.restore?.(new AbortController().signal)).resolves.not.toBeNull();

    expect(methods).toEqual(["eth_chainId", "eth_accounts", "eth_chainId", "eth_accounts"]);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("locally releases an adopted WalletConnect SDK connection without deleting the wallet session", async () => {
    const methods = await setupActualSdk(0, "walletConnect");
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    const disconnect = vi.spyOn(appKit, "disconnect");

    await expect(chooser.restore?.(new AbortController().signal)).resolves.not.toBeNull();
    const restorationMethods = [...methods];
    await expect(chooser.release?.()).resolves.toBeUndefined();

    expect(methods).toEqual(restorationMethods);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
    expect(sdk.walletConnectDisconnects).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("fully disconnects the exact adopted WalletConnect session when its provider emits both deletion events", async () => {
    const methods = await setupActualSdk(0, "walletConnect");
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);

    await expect(chooser.restore?.(new AbortController().signal)).resolves.not.toBeNull();
    const restorationMethods = [...methods];
    await expect(chooser.disconnect()).resolves.toBeUndefined();

    expect(sdk.walletConnectDisconnects).toBe(1);
    expect(methods).toEqual(restorationMethods);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
  });

  it("fails closed without touching a replacement WalletConnect session that appears during disconnect", async () => {
    await setupActualSdk(0, "walletConnect");
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    await expect(chooser.restore?.(new AbortController().signal)).resolves.not.toBeNull();
    const replacementDisconnect = vi.fn(async () => {});
    sdk.walletConnectReplacement = Object.assign(new EventEmitter(), {
      session: { topic: "replacement-session" },
      request: vi.fn(),
      disconnect: replacementDisconnect
    });

    await expect(chooser.disconnect()).rejects.toThrow(/reload/i);

    expect(sdk.walletConnectDisconnects).toBe(1);
    expect(replacementDisconnect).not.toHaveBeenCalled();
  });

  it("locally detaches an SDK WalletConnect account mismatch without deleting either session or prompting", async () => {
    const methods = await setupActualSdk(0, "walletConnect", undefined, replacementAccount, [replacementAccount, account]);
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);
    const restored = await wallet.restore();
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    const open = vi.spyOn(appKit, "open");

    expect(restored).toMatchObject({ kind: "disconnected" });
    await vi.waitFor(() => expect(appKit.getAccount("eip155")?.isConnected).toBe(false));
    expect(sdk.walletConnectDisconnects).toBe(0);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("fully tears down an SDK session adopted before readiness when Disconnect wins the loading race", async () => {
    const usage = (() => {
      let resolve = () => {};
      return { promise: new Promise<void>(yes => { resolve = yes; }), resolve };
    })();
    await setupActualSdk(0, "walletConnect", usage.promise);
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);

    const restoration = wallet.restore();
    await vi.waitFor(() => {
      expect(sdk.instance?.getProvider("eip155")).toBe(sdk.provider);
      expect(sdk.instance?.getAccount("eip155")).toMatchObject({ isConnected: true, address: account });
    });
    wallet.disconnect();
    usage.resolve();
    await restoration;

    expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
    await vi.waitFor(() => expect(sdk.walletConnectDisconnects).toBe(1));
    expect(sdk.instance?.getProvider("eip155")).toBeUndefined();
  });

  it("locally releases an SDK session adopted before readiness when another tab changes consent", async () => {
    const usage = (() => {
      let resolve = () => {};
      return { promise: new Promise<void>(yes => { resolve = yes; }), resolve };
    })();
    const methods = await setupActualSdk(0, "walletConnect", usage.promise);
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);
    const restoration = wallet.restore();
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBe(sdk.provider));
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    const open = vi.spyOn(appKit, "open");

    saveWalletConsent(consentKey(project, scope), { connectorId: "replacement", account, chainId: 11155111 });
    sdk.storageChange(consentKey(project, scope));
    usage.resolve();
    await restoration;

    expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
    await vi.waitFor(() => expect(appKit.getProvider("eip155")).toBeUndefined());
    expect(sdk.walletConnectDisconnects).toBe(0);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("cleans an adopted SDK session without a prompt when readiness rejects", async () => {
    const usage = (() => {
      let reject = (_reason: Error) => {};
      return { promise: new Promise<void>((_resolve, no) => { reject = no; }), reject };
    })();
    const methods = await setupActualSdk(0, "walletConnect", usage.promise);
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);
    const restoration = wallet.restore();
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBe(sdk.provider));
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    const open = vi.spyOn(appKit, "open");

    usage.reject(new Error("independent readiness failure"));
    await restoration;

    expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
    await vi.waitFor(() => expect(appKit.getProvider("eip155")).toBeUndefined());
    expect(sdk.walletConnectDisconnects).toBe(0);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("cleans an adopted SDK session without a prompt when readiness times out", async () => {
    const methods = await setupActualSdk(0, "walletConnect", new Promise<void>(() => {}));
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);
    const restoration = wallet.restore();
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBe(sdk.provider));
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    const open = vi.spyOn(appKit, "open");

    await restoration;

    expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
    await vi.waitFor(() => expect(appKit.getProvider("eip155")).toBeUndefined(), { timeout: 3_000 });
    expect(sdk.walletConnectDisconnects).toBe(0);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  }, 30_000);

  it("waits for delayed SDK adoption to release before opening one new Connect prompt", async () => {
    const usage = (() => {
      let resolve = () => {};
      return { promise: new Promise<void>(yes => { resolve = yes; }), resolve };
    })();
    const methods = await setupActualSdk(0, "walletConnect", usage.promise);
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);
    const restoration = wallet.restore();
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBe(sdk.provider));
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    let providerAtPrompt: unknown;
    const open = vi.spyOn(appKit, "open").mockImplementation(async () => {
      providerAtPrompt = appKit.getProvider("eip155");
    });
    const owner = {};

    const connecting = wallet.connect({ owner });
    void connecting.catch(() => {});
    expect(open).not.toHaveBeenCalled();
    usage.resolve();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    wallet.cancelConnection(owner);
    await expect(connecting).rejects.toThrow();
    await restoration;

    expect(providerAtPrompt).toBeUndefined();
    expect(open).toHaveBeenCalledOnce();
    expect(sdk.walletConnectDisconnects).toBe(0);
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
  });

  it("locally releases a pre-publication SDK restore after a new Connect is cancelled", async () => {
    const publication = (() => {
      let resolve = () => {};
      return { promise: new Promise<void>(yes => { resolve = yes; }), resolve };
    })();
    const methods = await setupActualSdk(0, "walletConnect", undefined, account, [account], publication.promise);
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);
    const restoration = wallet.restore();
    await vi.waitFor(() => expect(sdk.instance).toBeDefined());
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The actual AppKit fixture did not initialize.");
    const open = vi.spyOn(appKit, "open");
    const owner = {};

    expect(appKit.getProvider("eip155")).toBeUndefined();
    const connecting = wallet.connect({ owner });
    void connecting.catch(() => {});
    wallet.cancelConnection(owner);
    wallet.dispose();

    await new Promise(resolve => setTimeout(resolve, 20_250));
    expect(open).not.toHaveBeenCalled();
    publication.resolve();
    await expect(restoration).resolves.toMatchObject({ kind: "disconnected" });
    await expect(connecting).rejects.toThrow();
    await vi.waitFor(() => {
      expect(appKit.getProvider("eip155")).toBeUndefined();
      expect(appKit.getAccount("eip155")?.isConnected).not.toBe(true);
    });

    expect(sdk.adapter?.getWalletConnectProvider()).toBe(sdk.provider);
    expect(sdk.walletConnectDisconnects).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(methods.every(method => method === "eth_accounts" || method === "eth_chainId")).toBe(true);
  }, 35_000);

  it("accepts a proved external WalletConnect deletion and allows one new actual SDK connection", async () => {
    await setupActualSdk(0, "walletConnect", undefined, account, [account], undefined, {
      walletConnectTopics: ["external-delete-reconnect"]
    });
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);
    await expect(wallet.restore()).resolves.toMatchObject({ kind: "connected", account });
    const appKit = sdk.instance;
    const provider = sdk.provider as EventEmitter & { session?: { topic: string } };
    if (!appKit || !provider.session) throw new Error("The actual WalletConnect fixture did not restore.");
    const deletedTopic = provider.session.topic;

    provider.session = undefined;
    provider.emit("session_delete", { topic: deletedTopic });
    provider.emit("disconnect", { data: deletedTopic });
    await vi.waitFor(() => {
      expect(appKit.getProvider("eip155")).toBeUndefined();
      expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
    });
    const open = approveWalletConnectOnOpen(appKit);

    await expect(wallet.connect({ owner: {} })).resolves.toMatchObject({ kind: "connected", account });

    expect(open).toHaveBeenCalledOnce();
    expect(sdk.walletConnectConnects).toBe(1);
    expect((provider as { session?: { topic: string } }).session?.topic).toBe("external-delete-reconnect");
    expect(sdk.walletConnectDisconnects).toBe(0);
  });

  it("keeps missing WalletConnect terminal evidence quarantined", async () => {
    await setupActualSdk(0, "walletConnect");
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    const provider = sdk.provider as { session?: { topic: string } };
    await expect(chooser.restore?.(new AbortController().signal)).resolves.not.toBeNull();

    provider.session = undefined;

    await expect(chooser.disconnect()).rejects.toThrow(/reload/i);
    expect(sdk.walletConnectDisconnects).toBe(0);
    const retry = await createAppKitProvider(project, scope);
    await expect(retry.connect(new AbortController().signal)).rejects.toThrow(/reload/i);
  });

  it("accepts an injected SDK empty-account reset and allows one new actual SDK connection", async () => {
    await setupActualSdk(0, "injected");
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);
    await expect(wallet.restore()).resolves.toMatchObject({ kind: "connected", account });
    const appKit = sdk.instance;
    const provider = sdk.provider as EventEmitter;
    if (!appKit) throw new Error("The actual injected fixture did not restore.");

    sdk.liveAccounts = [];
    provider.emit("accountsChanged", []);
    await vi.waitFor(() => {
      expect(appKit.getProvider("eip155")).toBeUndefined();
      expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
    });
    sdk.liveAccounts = [account];
    const open = vi.spyOn(appKit, "open").mockImplementation(async () => {
      const controller = (appKit as unknown as {
        connectionControllerClient: { connectExternal?(params: { id: string; type: string; chainId: number }): Promise<unknown> };
      }).connectionControllerClient;
      await controller.connectExternal?.({ id: "independent-injected", type: "INJECTED", chainId: 11155111 });
    });

    await expect(wallet.connect({ owner: {} })).resolves.toMatchObject({ kind: "connected", account });
    expect(open).toHaveBeenCalledOnce();
  });

  it("relinquishes explicit WalletConnect T1 locally, connects T2, ignores a late T1 deletion, and deletes T2", async () => {
    await setupActualSdk(0, "walletConnect", undefined, account, [account], undefined, {
      saveConsent: false,
      initialWalletConnectTopic: null,
      walletConnectTopics: ["explicit-t1", "explicit-t2"]
    });
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const first = await createAppKitProvider(project, scope);
    const appKit = sdk.instance;
    const provider = sdk.provider as EventEmitter & { session?: { topic: string } };
    if (!appKit) throw new Error("The actual WalletConnect fixture did not initialize.");
    const open = approveWalletConnectOnOpen(appKit);

    await expect(first.connect(new AbortController().signal)).resolves.toBeDefined();
    expect(provider.session?.topic).toBe("explicit-t1");
    await expect(first.release?.()).resolves.toBeUndefined();
    expect(provider.session?.topic).toBe("explicit-t1");
    expect(sdk.walletConnectDisconnects).toBe(0);

    const second = await createAppKitProvider(project, scope);
    await expect(second.connect(new AbortController().signal)).resolves.toBeDefined();
    expect(provider.session?.topic).toBe("explicit-t2");
    provider.emit("session_delete", { topic: "explicit-t1" });
    expect(appKit.getProvider("eip155")).toBe(provider);

    await expect(second.disconnect()).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledTimes(2);
    expect(sdk.walletConnectConnects).toBe(2);
    expect(sdk.disconnectedWalletConnectTopics).toEqual(["explicit-t2"]);
    expect(provider.session).toBeUndefined();
  });

  it("serializes a cross-tab release of a delayed explicit SDK adoption before the next Connect prompt", async () => {
    const usage = deferred();
    const loadGate = deferred();
    let loadStarted = false;
    await setupActualSdk(0, "walletConnect", usage.promise, account, [account], undefined, {
      saveConsent: false,
      walletConnectTopics: ["after-cross-tab-release"]
    });
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, async () => {
      loadStarted = true;
      await loadGate.promise;
      return createAppKitProvider(project, scope);
    }, scope);
    const first = wallet.connect({ owner: {} });
    void first.catch(() => {});
    await vi.waitFor(() => expect(loadStarted).toBe(true));
    saveWalletConsent(consentKey(project, scope), { connectorId: "walletConnect", account, chainId: 11155111 });
    loadGate.resolve();
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBe(sdk.provider));
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The delayed actual SDK fixture did not initialize.");
    const open = approveWalletConnectOnOpen(appKit);

    saveWalletConsent(consentKey(project, scope), { connectorId: "replacement", account, chainId: 11155111 });
    sdk.storageChange(consentKey(project, scope));
    const second = wallet.connect({ owner: {} });
    void second.catch(() => {});
    expect(open).not.toHaveBeenCalled();
    usage.resolve();

    await expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    await expect(second).resolves.toMatchObject({ kind: "connected", account });
    expect(sdk.walletConnectDisconnects).toBe(0);
    expect((sdk.provider as { session?: { topic: string } }).session?.topic).toBe("after-cross-tab-release");
  });

  it("locally releases a delayed explicit SDK adoption when disposal cancels its loader", async () => {
    const usage = deferred();
    const loadGate = deferred();
    let loadStarted = false;
    await setupActualSdk(0, "walletConnect", usage.promise, account, [account], undefined, {
      saveConsent: false
    });
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, async () => {
      loadStarted = true;
      await loadGate.promise;
      return createAppKitProvider(project, scope);
    }, scope);
    const connecting = wallet.connect({ owner: {} });
    void connecting.catch(() => {});
    await vi.waitFor(() => expect(loadStarted).toBe(true));
    saveWalletConsent(consentKey(project, scope), { connectorId: "walletConnect", account, chainId: 11155111 });
    loadGate.resolve();
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBe(sdk.provider));
    const appKit = sdk.instance;
    if (!appKit) throw new Error("The delayed actual SDK fixture did not initialize.");
    const open = vi.spyOn(appKit, "open");

    wallet.dispose();
    usage.resolve();

    await expect(connecting).rejects.toThrow();
    await vi.waitFor(() => expect(appKit.getProvider("eip155")).toBeUndefined());
    expect(open).not.toHaveBeenCalled();
    expect(sdk.walletConnectDisconnects).toBe(0);
    expect((sdk.provider as { session?: { topic: string } }).session?.topic).toBe("independent-existing-session");
  });
});
