import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import UniversalProvider from "@walletconnect/universal-provider";
import type { EthersAdapter } from "@reown/appkit-adapter-ethers";

const sdk = vi.hoisted(() => ({
  adapter: undefined as EthersAdapter | undefined
}));

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
});
