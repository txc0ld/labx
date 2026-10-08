import { afterEach, describe, expect, it, vi } from "vitest";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { OptionsController } from "@reown/appkit-controllers";
import type { WalletProvider } from "../lib/chain/types";

const prior = {
  metadata: OptionsController.state.metadata,
  enableInjected: OptionsController.state.enableInjected,
  enableEIP6963: OptionsController.state.enableEIP6963,
  enableCoinbase: OptionsController.state.enableCoinbase
};

afterEach(() => {
  vi.unstubAllGlobals();
  OptionsController.state.metadata = prior.metadata;
  OptionsController.state.enableInjected = prior.enableInjected;
  OptionsController.state.enableEIP6963 = prior.enableEIP6963;
  OptionsController.state.enableCoinbase = prior.enableCoinbase;
});

describe("pinned EthersAdapter EIP-6963 discovery", () => {
  it("registers each announced wallet with its exact raw provider", async () => {
    const browser = new EventTarget();
    vi.stubGlobal("window", browser);
    OptionsController.state.metadata = { name: "LABx", description: "LABx test", url: "https://labx.test", icons: [] };
    OptionsController.state.enableInjected = false;
    OptionsController.state.enableEIP6963 = true;
    OptionsController.state.enableCoinbase = false;
    const first = provider("0x1111111111111111111111111111111111111111");
    const second = provider("0x2222222222222222222222222222222222222222");
    browser.addEventListener("eip6963:requestProvider", () => {
      announce(browser, "io.first", "First Wallet", first);
      announce(browser, "io.second", "Second Wallet", second);
    });
    const adapter = new EthersAdapter();
    await adapter.syncConnectors();
    const announced = adapter.connectors.filter(connector => connector.type === "ANNOUNCED");
    expect(announced.map(connector => connector.id).sort()).toEqual(["io.first", "io.second"]);
    expect(announced.find(connector => connector.id === "io.first")?.provider).toBe(first);
    expect(announced.find(connector => connector.id === "io.second")?.provider).toBe(second);
  });
});

function provider(account: string): WalletProvider {
  return { request: vi.fn(async ({ method }) => method === "eth_accounts" ? [account] : "0xaa36a7") };
}

function announce(target: EventTarget, rdns: string, name: string, walletProvider: WalletProvider) {
  const event = new Event("eip6963:announceProvider") as Event & { detail?: unknown };
  event.detail = { info: { uuid: rdns, name, icon: "data:image/svg+xml,<svg/>", rdns }, provider: walletProvider };
  target.dispatchEvent(event);
}
