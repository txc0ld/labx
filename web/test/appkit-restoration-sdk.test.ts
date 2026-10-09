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
async function setup(selected = "fixture-injected", liveAccount = account) {
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
  vi.stubGlobal("window", { location: { origin: "https://labx.test" }, localStorage: storage });
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
  vi.spyOn(ApiController, "fetchUsage").mockResolvedValue(undefined);
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
