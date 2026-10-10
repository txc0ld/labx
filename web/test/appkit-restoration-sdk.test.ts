import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EthersAdapter } from "@reown/appkit-adapter-ethers";
import type { AppKit } from "@reown/appkit";
import { consentKey, saveWalletConsent } from "../lib/chain/wallet-consent";

const sdk = vi.hoisted(() => ({ provider: undefined as object | undefined, adapter: undefined as EthersAdapter | undefined, instance: undefined as AppKit | undefined, selected: "fixture-injected" }));
// Keep the installed constructor, initialize, controllers, restore dispatch, account
// synchronization and Ethers adapter. Replace only network/DOM discovery and lookups.
vi.mock("@reown/appkit", async importOriginal => {
  const actual = await importOriginal<typeof import("@reown/appkit")>();
  return { ...actual, AppKit: class extends actual.AppKit {
    constructor(options: ConstructorParameters<typeof actual.AppKit>[0]) { super({ ...options, basic: true }); sdk.instance = this; }
    protected override getDefaultMetaData() { return null; }
    protected override initializeThemeController() {}
    protected override async injectModalUi() {}
    override async syncIdentity() {}
    protected override async syncBalance() {}
    protected override async initChainAdapters() {
      const { ConnectorController } = await import("@reown/appkit-controllers");
      const adapter = this.chainAdapters?.eip155 as EthersAdapter;
      sdk.adapter = adapter;
      if (sdk.selected === "walletConnect") {
        await adapter.setUniversalProvider(sdk.provider as Parameters<EthersAdapter["setUniversalProvider"]>[0]);
        (this as unknown as { universalProvider: unknown }).universalProvider = sdk.provider;
        ConnectorController.setConnectors(adapter.connectors);
      } else {
        const connector = { id: "fixture-injected", name: "Fixture", type: "INJECTED", chain: "eip155", provider: sdk.provider } as EthersAdapter["connectors"][number];
        Object.defineProperty(adapter, "connectors", { configurable: true, get: () => [connector] });
        ConnectorController.setConnectors([connector]);
      }
      ConnectorController.setConnectorId(sdk.selected, "eip155");
      this.listenAdapter("eip155");
      this.initAdapterController();
    }
  } };
});
vi.mock("../lib/chain/walletconnect-accessibility", () => ({ observeWalletConnectModal: () => () => {}, refreshWalletConnectConnectorLists: () => {} }));
const account = "0x1111111111111111111111111111111111111111";
const project = "a".repeat(32), scope = "sdk-restore";
async function setup(selected = "fixture-injected", liveAccount = account, usageGate: Promise<void> = Promise.resolve()) {
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
  vi.stubGlobal("window", {
    location: { origin: "https://labx.test" },
    localStorage: storage,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
  vi.stubGlobal("localStorage", storage);
  sdk.selected = selected;
  const requests: string[] = [];
  const provider = Object.assign(new EventEmitter(), { request: async ({ method }: { method: string }) => {
    requests.push(method);
    if (method === "eth_accounts") return [liveAccount];
    if (method === "eth_chainId") return "0xaa36a7";
    throw new Error(`Forbidden restoration request ${method}`);
  } }) as EventEmitter & {
    request(input: { method: string }): Promise<unknown>;
    session?: { topic: string; expiry: number; peer: { metadata: { name: string; description: string; url: string; icons: string[] } }; namespaces: { eip155: { accounts: string[]; methods: string[]; events: string[] } } };
    disconnect?: ReturnType<typeof vi.fn>;
  };
  if (selected === "walletConnect") {
    Object.assign(provider, {
      session: {
        topic: "restored-walletconnect-topic",
        expiry: Math.floor(Date.now() / 1000) + 3600,
        peer: { metadata: { name: "Fixture wallet", description: "Fixture", url: "https://wallet.test", icons: [] } },
        namespaces: { eip155: { accounts: [`eip155:11155111:${liveAccount}`], methods: ["personal_sign", "eth_sendTransaction"], events: ["accountsChanged", "chainChanged"] } }
      },
      disconnect: vi.fn(async () => {
        const topic = provider.session?.topic;
        provider.session = undefined;
        provider.emit("session_delete", { topic });
        provider.emit("disconnect", { data: topic });
      })
    });
  }
  sdk.provider = provider;
  const { ApiController, CoreHelperUtil } = await import("@reown/appkit-controllers");
  vi.spyOn(ApiController, "fetchUsage").mockImplementation(() => usageGate);
  vi.spyOn(CoreHelperUtil, "isMobile").mockReturnValue(false);
  const consent = saveWalletConsent(consentKey(project, scope), { connectorId: selected, account, chainId: 11155111 });
  return { requests, consent };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); sdk.provider = undefined; sdk.adapter = undefined; sdk.instance = undefined; });
describe("installed AppKit 1.8.19 restore lifecycle", () => {
  it("runs real SDK initialization and restores the selected injected wallet without permission requests", async () => {
    const { requests } = await setup();
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    expect(sdk.instance?.getAccount("eip155")).toMatchObject({ isConnected: true, address: account });
    expect(await chooser.restore?.(new AbortController().signal)).not.toBeNull();
    expect(requests).toEqual(["eth_accounts", "eth_chainId", "eth_chainId", "eth_accounts", "eth_chainId", "eth_accounts"]);
  });
  it("does not fall back to another saved connector", async () => {
    const { requests } = await setup("different-connector");
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    expect(await chooser.restore?.(new AbortController().signal)).toBeNull();
    expect(requests).toEqual([]);
  });
  it("releases an adopted injected provider without revoking wallet permissions", async () => {
    const { requests } = await setup();
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);

    await chooser.release?.();

    expect(sdk.instance?.getAccount("eip155")?.isConnected).toBe(false);
    expect(requests).toEqual(["eth_accounts", "eth_chainId"]);
    expect(requests).not.toContain("wallet_getPermissions");
    expect(requests).not.toContain("wallet_revokePermissions");
  });
  it("restores the exact WalletConnect session through the installed SDK without prompt methods", async () => {
    const { requests } = await setup("walletConnect");
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);

    expect(sdk.instance?.getAccount("eip155")).toMatchObject({ isConnected: true, address: account });
    expect(await chooser.restore?.(new AbortController().signal)).not.toBeNull();
    expect(requests).toEqual(["eth_chainId", "eth_accounts", "eth_chainId", "eth_accounts"]);
    expect(requests).not.toContain("eth_requestAccounts");
  });
  it("releases an adopted WalletConnect session locally without deleting it", async () => {
    const { requests } = await setup("walletConnect");
    const provider = sdk.provider as EventEmitter & { session?: { topic: string }; disconnect: ReturnType<typeof vi.fn> };
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);

    await chooser.release?.();

    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(provider.session?.topic).toBe("restored-walletconnect-topic");
    expect(sdk.instance?.getAccount("eip155")?.isConnected).toBe(false);
    expect(requests).toEqual([]);
  });
  it("deletes the captured WalletConnect session on explicit disconnect", async () => {
    await setup("walletConnect");
    const provider = sdk.provider as EventEmitter & { session?: { topic: string }; disconnect: ReturnType<typeof vi.fn> };
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);

    await chooser.disconnect();

    expect(provider.disconnect).toHaveBeenCalledOnce();
    expect(provider.session).toBeUndefined();
  });
  it("deletes a WalletConnect session adopted before SDK readiness when browser disconnect wins", async () => {
    let finishUsage = () => {};
    const usageGate = new Promise<void>(resolve => { finishUsage = resolve; });
    await setup("walletConnect", account, usageGate);
    const provider = sdk.provider as EventEmitter & { session?: { topic: string }; disconnect: ReturnType<typeof vi.fn> };
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);

    const restoration = wallet.restore();
    await vi.waitFor(() => {
      expect(sdk.instance?.getProvider("eip155")).toBe(provider);
      expect(sdk.instance?.getAccount("eip155")).toMatchObject({ isConnected: true, address: account });
    });
    wallet.disconnect();
    finishUsage();
    await restoration;

    expect(wallet.getSnapshot()).toMatchObject({ kind: "disconnected" });
    await vi.waitFor(() => expect(provider.disconnect).toHaveBeenCalledOnce());
    expect(sdk.instance?.getProvider("eip155")).toBeUndefined();
  });
  it("releases an early adopted session locally when browser disposal wins SDK readiness", async () => {
    let finishUsage = () => {};
    const usageGate = new Promise<void>(resolve => { finishUsage = resolve; });
    await setup("walletConnect", account, usageGate);
    const provider = sdk.provider as EventEmitter & { session?: { topic: string }; disconnect: ReturnType<typeof vi.fn> };
    const [{ createAppKitProvider }, { BrowserWalletSession }] = await Promise.all([
      import("../lib/chain/appkit-provider"),
      import("../lib/chain/wallet-connectors")
    ]);
    const wallet = new BrowserWalletSession(undefined, 11155111, project, () => createAppKitProvider(project, scope), scope);

    const restoration = wallet.restore();
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBe(provider));
    wallet.dispose();
    finishUsage();
    await restoration;

    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBeUndefined());
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(provider.session?.topic).toBe("restored-walletconnect-topic");
  });
  it("retains cleanup ownership when SDK readiness rejects after adoption", async () => {
    let failUsage = (_error: Error) => {};
    const usageGate = new Promise<void>((_resolve, reject) => { failUsage = reject; });
    await setup("walletConnect", account, usageGate);
    const provider = sdk.provider as EventEmitter & { session?: { topic: string }; disconnect: ReturnType<typeof vi.fn> };
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");

    const loading = createAppKitProvider(project, scope);
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBe(provider));
    failUsage(new Error("controlled usage failure"));
    const chooser = await loading;
    await chooser.disconnect();

    expect(provider.disconnect).toHaveBeenCalledOnce();
    expect(provider.session).toBeUndefined();
    await expect(chooser.connect(new AbortController().signal)).rejects.toBeInstanceOf((await import("../lib/chain/wallet-connectors")).WalletChooserReloadError);
  });
  it("rejects expired or mismatched WalletConnect authorization", async () => {
    const { consent } = await setup();
    const { hasAuthorizedRestoreSession } = await import("../lib/chain/appkit-provider");
    const session = { expiry: Math.floor(Date.now() / 1000) + 3600, namespaces: { eip155: { accounts: [`eip155:11155111:${account}`], methods: ["personal_sign", "eth_sendTransaction"], events: ["accountsChanged", "chainChanged"] } } };
    expect(hasAuthorizedRestoreSession({ session }, consent)).toBe(true);
    expect(hasAuthorizedRestoreSession({ session: { ...session, namespaces: { eip155: { ...session.namespaces.eip155, events: undefined } } } }, consent)).toBe(false);
    expect(hasAuthorizedRestoreSession({ session: { ...session, namespaces: { eip155: { ...session.namespaces.eip155, events: ["accountsChanged"] } } } }, consent)).toBe(false);
    expect(hasAuthorizedRestoreSession({ session: { ...session, expiry: 1 } }, consent)).toBe(false);
    expect(hasAuthorizedRestoreSession({ session: { ...session, namespaces: { eip155: { ...session.namespaces.eip155, accounts: [`eip155:1:${account}`] } } } }, consent)).toBe(false);
    expect(hasAuthorizedRestoreSession({ session: { ...session, namespaces: { eip155: { ...session.namespaces.eip155, methods: ["personal_sign"] } } } }, consent)).toBe(false);
  });
});

type RetirementProvider = EventEmitter & {
  session?: { topic: string; namespaces: object };
  disconnect: ReturnType<typeof vi.fn>;
};
type RetirementAdapter = EthersAdapter & {
  beginAttempt(): unknown;
  finishChooser(attempt: unknown): void;
  disconnectWalletConnectSession(provider: object, topic: string): Promise<void>;
  releaseWalletConnectSession(provider: object, topic: string): void;
};
async function expectNextPrompt() {
  const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
  if (!sdk.instance) throw new Error("SDK fixture missing");
  const open = vi.spyOn(sdk.instance, "open").mockResolvedValue();
  const next = await createAppKitProvider(project, scope);
  const abort = new AbortController();
  const result = next.connect(abort.signal).catch(error => error);
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  abort.abort();
  expect(await result).toBeInstanceOf(Error);
}

describe("SDK-owned session retirement", () => {
  it("retires an injected wallet after SDK account loss and permits a fresh prompt", async () => {
    const { requests } = await setup();
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    (sdk.provider as EventEmitter).emit("accountsChanged", []);
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBeUndefined());
    await chooser.disconnect();
    await expectNextPrompt();
    expect(requests).toEqual(["eth_accounts", "eth_chainId"]);
  });

  it("tracks terminal deletion of a restored WC session without a connect event", async () => {
    await setup("walletConnect");
    const provider = sdk.provider as RetirementProvider;
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    const topic = provider.session!.topic;
    provider.session = undefined;
    provider.emit("session_delete", { topic });
    provider.emit("disconnect", { data: topic });
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBeUndefined());
    await chooser.disconnect();
    expect(provider.disconnect).not.toHaveBeenCalled();
    await expectNextPrompt();
  });

  it.each(["release", "disconnect"] as const)("%s retires the exact live WC topic after the SDK namespace is already empty", async mode => {
    await setup("walletConnect");
    const provider = sdk.provider as RetirementProvider;
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    const topic = provider.session!.topic;
    provider.emit("disconnect", { data: "unrelated-terminal-event" });
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBeUndefined());
    await chooser[mode]?.();
    expect(provider.disconnect).toHaveBeenCalledTimes(mode === "disconnect" ? 1 : 0);
    expect(provider.session?.topic).toBe(mode === "disconnect" ? undefined : topic);
    await expectNextPrompt();
  });

  it.each(["release", "disconnect"] as const)("%s quarantines unexplained missing WC state without matching terminal evidence", async mode => {
    await setup("walletConnect");
    const provider = sdk.provider as RetirementProvider;
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    provider.session = undefined;
    provider.emit("disconnect", { data: "different-topic" });
    await vi.waitFor(() => expect(sdk.instance?.getProvider("eip155")).toBeUndefined());
    await expect(chooser[mode]?.()).rejects.toThrow(/Reload/);
    expect(provider.disconnect).not.toHaveBeenCalled();
    const next = await createAppKitProvider(project, scope);
    await expect(next.connect(new AbortController().signal)).rejects.toThrow(/Reload/);
  });

  it("relinquishes an exact local tracker, ignores late old connect events and accepts a new explicit topic", async () => {
    await setup("walletConnect");
    const provider = sdk.provider as RetirementProvider;
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    const chooser = await createAppKitProvider(project, scope);
    const oldSession = provider.session!;
    provider.emit("connect", oldSession);
    await chooser.release?.();
    provider.emit("connect", oldSession);
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(provider.session).toBe(oldSession);
    expect(sdk.instance?.getProvider("eip155")).toBeUndefined();

    const adapter = sdk.adapter as RetirementAdapter;
    Object.assign(provider, {
      client: { core: { crypto: { getClientId: async () => "fixture-client" } } },
      connect: async () => {
        provider.session = { ...oldSession, topic: "next-explicit-topic" };
        provider.emit("connect", provider.session);
      }
    });
    const attempt = adapter.beginAttempt();
    await adapter.connectWalletConnect(11155111);
    adapter.finishChooser(attempt);
    expect(provider.session?.topic).toBe("next-explicit-topic");
    expect(adapter.connections).toHaveLength(1);
    expect(provider.disconnect).not.toHaveBeenCalled();
    await adapter.disconnectWalletConnectSession(provider, "next-explicit-topic");
    expect(provider.disconnect).toHaveBeenCalledOnce();
    expect(provider.session).toBeUndefined();
  });

  it("cannot release a tracker during deletion or erase failure with a late terminal event", async () => {
    await setup("walletConnect");
    const provider = sdk.provider as RetirementProvider;
    const { createAppKitProvider } = await import("../lib/chain/appkit-provider");
    await createAppKitProvider(project, scope);
    const adapter = sdk.adapter as RetirementAdapter;
    const topic = provider.session!.topic;
    let rejectDeletion!: (error: Error) => void;
    provider.disconnect.mockImplementation(() => new Promise<void>((_yes, no) => { rejectDeletion = no; }));
    const result = adapter.disconnectWalletConnectSession(provider, topic).catch(error => error);
    expect(() => adapter.releaseWalletConnectSession(provider, topic)).toThrow(/cannot be released/);
    rejectDeletion(new Error("failed deletion"));
    expect(await result).toMatchObject({ message: "failed deletion" });
    provider.session = undefined;
    provider.emit("session_delete", { topic });
    provider.emit("disconnect", { data: topic });
    expect(() => adapter.releaseWalletConnectSession(provider, topic)).toThrow(/cannot be released/);
    await expect(adapter.disconnectWalletConnectSession(provider, topic)).rejects.toThrow();
  });
});
