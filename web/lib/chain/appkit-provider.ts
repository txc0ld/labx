import { AppKit, CoreHelperUtil, type CreateAppKit } from "@reown/appkit";
import { PACKAGE_VERSION } from "@reown/appkit/constants";
import { sepolia } from "@reown/appkit/networks";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { observeWalletConnectModal } from "./walletconnect-accessibility";
import { bounded, type WalletChooser, WalletChooserBusyError, WalletChooserReloadError } from "./wallet-connectors";
import type { WalletProvider } from "./types";

type Attempt = {
  cancelled: boolean;
  pending: number;
  awaitingStart: boolean;
  completed: Set<string>;
  controllerSettled: Promise<void>;
  settleController: () => void;
  controllerClaimed: boolean;
  cancellationListeners: Set<(error: Error) => void>;
  settled: Promise<void>;
  settle: () => void;
};

class LabxEthersAdapter extends EthersAdapter {
  private attempt: Attempt | undefined;

  beginAttempt() {
    if (this.attempt) throw new WalletChooserBusyError();
    let settle = () => {};
    let settleController = () => {};
    const attempt: Attempt = {
      cancelled: false,
      pending: 0,
      awaitingStart: false,
      completed: new Set(),
      controllerSettled: new Promise<void>(resolve => { settleController = resolve; }),
      settleController,
      controllerClaimed: false,
      cancellationListeners: new Set(),
      settled: new Promise<void>(resolve => { settle = resolve; }),
      settle
    };
    this.attempt = attempt;
    return attempt;
  }

  cancelAttempt(attempt: Attempt, awaitingStart = false, error = new Error("Wallet connection cancelled.")) {
    if (this.attempt !== attempt || attempt.cancelled) return;
    attempt.cancelled = true;
    attempt.awaitingStart = awaitingStart && attempt.pending === 0 && attempt.completed.size === 0;
    for (const listener of attempt.cancellationListeners) listener(error);
    void this.settleCancelled(attempt);
  }

  finishAttempt(attempt: Attempt) {
    if (this.attempt !== attempt) return;
    if (attempt.pending) return;
    this.attempt = undefined;
    attempt.cancellationListeners.clear();
    attempt.settle();
  }

  onCancel(attempt: Attempt, listener: (error: Error) => void) {
    if (this.attempt !== attempt) throw new Error("Wallet connection attempt is no longer active.");
    attempt.cancellationListeners.add(listener);
    return () => attempt.cancellationListeners.delete(listener);
  }

  hasCompletedConnection(attempt: Attempt) {
    return this.attempt === attempt && attempt.completed.size > 0;
  }

  waitForController(attempt: Attempt) {
    if (this.attempt !== attempt) throw new Error("Wallet connection attempt is no longer active.");
    return attempt.controllerSettled;
  }

  async trackController<T>(operation: () => Promise<T>): Promise<T> {
    const attempt = this.attempt;
    if (!attempt || attempt.cancelled) throw new WalletChooserBusyError();
    if (attempt.controllerClaimed) {
      const error = new WalletChooserBusyError();
      this.cancelAttempt(attempt, false, error);
      throw error;
    }
    attempt.controllerClaimed = true;
    attempt.pending++;
    try {
      return await operation();
    } finally {
      attempt.pending--;
      attempt.settleController();
      if (attempt.cancelled) void this.settleCancelled(attempt);
    }
  }

  override async connect(params: Parameters<EthersAdapter["connect"]>[0]) {
    return this.track(params.id, () => super.connect(params));
  }

  override async connectWalletConnect(chainId?: number | string) {
    return this.track("walletConnect", () => super.connectWalletConnect(chainId));
  }

  private async track<T>(connectorId: string, operation: () => Promise<T>): Promise<T> {
    const attempt = this.attempt;
    if (!attempt || attempt.cancelled) throw new WalletChooserBusyError();
    attempt.awaitingStart = false;
    attempt.pending++;
    try {
      const result = await operation();
      if (attempt.cancelled) {
        await this.disconnectCancelled(connectorId);
        throw new Error("Wallet connection cancelled.");
      }
      attempt.completed.add(connectorId);
      return result;
    } finally {
      attempt.pending--;
      if (attempt.cancelled) void this.settleCancelled(attempt);
    }
  }

  private async settleCancelled(attempt: Attempt) {
    if (this.attempt !== attempt || attempt.pending || attempt.awaitingStart) return;
    const connectors = [...attempt.completed];
    attempt.completed.clear();
    await Promise.allSettled(connectors.map(connector => this.disconnectCancelled(connector)));
    this.finishAttempt(attempt);
  }

  private async disconnectCancelled(connectorId: string) {
    if (connectorId === "walletConnect") {
      const provider = this.getWalletConnectProvider() as {
        session?: { topic: string };
        client: { disconnect(input: { topic: string; reason: { code: number; message: string } }): Promise<void> };
      } | undefined;
      const topic = provider?.session?.topic;
      if (topic) {
        await provider.client.disconnect({ topic, reason: { code: 6000, message: "Connection cancelled" } });
      }
    }
    try { await super.disconnect({ id: connectorId }); }
    catch {}
  }
}

type AppKitRuntime = { appKit: AppKit; adapter: LabxEthersAdapter };

class LabxAppKit extends AppKit {
  constructor(options: ConstructorParameters<typeof AppKit>[0], private readonly labxAdapter: LabxEthersAdapter) {
    super(options);
    const client = this.connectionControllerClient;
    if (!client) throw new Error("AppKit connection controller was not initialized.");
    const connectWalletConnect = client.connectWalletConnect?.bind(client);
    const connectExternal = client.connectExternal?.bind(client);
    if (connectWalletConnect) {
      client.connectWalletConnect = params => this.labxAdapter.trackController(() => connectWalletConnect(params));
    }
    if (connectExternal) {
      client.connectExternal = params => this.labxAdapter.trackController(() => connectExternal(params));
    }
  }
}

let runtime: Promise<AppKitRuntime> | undefined;
let pendingAttempt: Attempt | undefined;

export async function createAppKitProvider(projectId: string): Promise<WalletChooser> {
  runtime ??= initialize(projectId).catch(() => { throw new WalletChooserReloadError(); });
  const current = await runtime;
  return createChooser(current);
}

async function initialize(projectId: string): Promise<AppKitRuntime> {
  const adapter = new LabxEthersAdapter();
  const metadata = {
    name: "LABx",
    description: "LABx on Ethereum Sepolia",
    url: window.location.origin,
    icons: [`${window.location.origin}/favicon.svg`]
  };
  const options: CreateAppKit = {
    adapters: [adapter],
    networks: [sepolia],
    defaultNetwork: sepolia,
    projectId,
    metadata,
    enableInjected: true,
    enableEIP6963: true,
    enableCoinbase: false,
    enableReconnect: false,
    enableNetworkSwitch: false,
    features: { analytics: false, email: false, socials: false, onramp: false, swaps: false },
    themeMode: "light",
    themeVariables: { "--w3m-accent": "#111111", "--w3m-z-index": 1000 },
    universalProviderConfigOverride: {
      methods: { eip155: ["eth_sendTransaction", "personal_sign"] },
      events: { eip155: ["accountsChanged", "chainChanged"] },
      rpcMap: { "eip155:11155111": "https://ethereum-sepolia-rpc.publicnode.com" }
    }
  };
  const appKit = new LabxAppKit({
    ...options,
    sdkVersion: CoreHelperUtil.generateSdkVersion([adapter], "html", PACKAGE_VERSION)
  }, adapter);
  await bounded(appKit.ready(), 20_000);
  return { appKit, adapter };
}

function createChooser({ appKit, adapter }: AppKitRuntime): WalletChooser {
  let connected = false;
  return {
    async connect(signal) {
      if (pendingAttempt) throw new WalletChooserBusyError();
      const attempt = adapter.beginAttempt();
      pendingAttempt = attempt;
      let opened = false;
      let stopAccessibility: (() => void) | undefined;
      let settled = false;
      let resultCleanup = () => {};
      const result = new Promise<WalletProvider>((resolve, reject) => {
        const accept = async () => {
          if (settled || signal.aborted || attempt.cancelled) return;
          const provider = appKit.getProvider<unknown>("eip155");
          const account = appKit.getAccount("eip155");
          if (!account?.isConnected || !isWalletProvider(provider)) return;
          try {
            const [chain, accounts] = await Promise.all([
              provider.request({ method: "eth_chainId" }),
              provider.request({ method: "eth_accounts" })
            ]);
            if (settled || signal.aborted || attempt.cancelled) return;
            if (appKit.getProvider("eip155") !== provider) {
              cancel(new Error("The selected wallet changed while connecting. Please retry."));
              return;
            }
            if (typeof chain !== "string" || Number(BigInt(chain)) !== 11155111 || !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== account.address?.toLowerCase()) {
              throw new Error("The selected wallet did not return the approved Ethereum Sepolia account.");
            }
            await adapter.waitForController(attempt);
            if (settled || signal.aborted || attempt.cancelled) return;
            if (appKit.getProvider("eip155") !== provider) {
              cancel(new Error("The selected wallet changed while connecting. Please retry."));
              return;
            }
            const currentAccount = appKit.getAccount("eip155");
            const [currentChain, currentAccounts] = await Promise.all([
              provider.request({ method: "eth_chainId" }),
              provider.request({ method: "eth_accounts" })
            ]);
            if (settled || signal.aborted || attempt.cancelled) return;
            if (appKit.getProvider("eip155") !== provider || typeof currentChain !== "string" || Number(BigInt(currentChain)) !== 11155111 || !Array.isArray(currentAccounts) || typeof currentAccounts[0] !== "string" || currentAccounts[0].toLowerCase() !== currentAccount?.address?.toLowerCase()) {
              cancel(new Error("The selected wallet changed while connecting. Please retry."));
              return;
            }
            settled = true;
            connected = true;
            adapter.finishAttempt(attempt);
            resolve(provider);
          } catch (error) {
            cancel(error instanceof Error ? error : new Error("Wallet returned an invalid session."));
          }
        };
        const cancel = (error = new Error("Wallet connection cancelled.")) => {
          if (settled) return;
          settled = true;
          adapter.cancelAttempt(attempt, Boolean(appKit.getState().connectingWallet));
          reject(error);
        };
        const unsubscribeCancellation = adapter.onCancel(attempt, cancel);
        const unsubscribeAccount = appKit.subscribeAccount(() => { void accept(); }, "eip155");
        const unsubscribeState = appKit.subscribeState(state => {
          if (state.open) opened = true;
          else if (opened && !connected && !adapter.hasCompletedConnection(attempt)) cancel();
        });
        const unsubscribeEvents = appKit.subscribeEvents(state => {
          const event = state.data?.event;
          if (event === "CONNECT_ERROR" || event === "USER_REJECTED") {
            cancel(new Error(event === "USER_REJECTED" ? "Wallet connection was rejected." : "Wallet connection failed."));
          }
        });
        const abort = () => cancel();
        signal.addEventListener("abort", abort, { once: true });
        void appKit.open({ view: "Connect", namespace: "eip155" }).then(() => {
          if (signal.aborted || attempt.cancelled) return;
          const modal = typeof document === "undefined" ? null : document.querySelector("w3m-modal");
          if (typeof HTMLElement !== "undefined" && modal instanceof HTMLElement) stopAccessibility = observeWalletConnectModal(modal);
        }).catch(error => cancel(error instanceof Error ? error : new Error("Wallet chooser could not open.")));
        resultCleanup = () => {
          unsubscribeAccount();
          unsubscribeState();
          unsubscribeEvents();
          unsubscribeCancellation();
          signal.removeEventListener("abort", abort);
          stopAccessibility?.();
        };
      });
      try {
        return await result;
      } finally {
        resultCleanup();
        void appKit.close().catch(() => {});
        if (!connected) {
          adapter.cancelAttempt(attempt, Boolean(appKit.getState().connectingWallet));
          void attempt.settled.finally(() => {
            if (pendingAttempt === attempt) pendingAttempt = undefined;
          });
        } else if (pendingAttempt === attempt) {
          pendingAttempt = undefined;
        }
      }
    },
    async disconnect() {
      await appKit.close().catch(() => {});
      if (connected) {
        const walletConnect = appKit.getWalletProviderType() === "WALLET_CONNECT";
        if (walletConnect) {
          const provider = adapter.getWalletConnectProvider() as { disconnect?(): Promise<void> } | undefined;
          await provider?.disconnect?.().catch(() => {});
        }
        await appKit.disconnect("eip155").catch(() => {});
      }
      connected = false;
    }
  };
}

function isWalletProvider(provider: unknown): provider is WalletProvider {
  return Boolean(provider && typeof provider === "object" && "request" in provider && typeof provider.request === "function");
}
