import { getAddress } from "viem";
import { consentKey, readWalletConsent, sameConsent, saveWalletConsent, type WalletConsent } from "./wallet-consent";
import { AppKit, CoreHelperUtil, type CreateAppKit } from "@reown/appkit";
import { PACKAGE_VERSION } from "@reown/appkit/constants";
import { sepolia } from "@reown/appkit/networks";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { ConnectorController } from "@reown/appkit-controllers";
import { observeWalletConnectModal, refreshWalletConnectConnectorLists } from "./walletconnect-accessibility";
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

type WalletConnectCleanup = {
  provider: object;
  topic: string;
  completed: boolean;
  failure?: unknown;
  promise: Promise<void>;
  complete: () => void;
};

class LabxEthersAdapter extends EthersAdapter {
  private attempt: Attempt | undefined;
  private walletConnectCleanup: WalletConnectCleanup | undefined;

  beginAttempt() {
    if (this.attempt) throw new WalletChooserBusyError();
    let settle = () => {};
    let settleController = () => {};
    const attempt: Attempt = {
      cancelled: false,
      pending: 1,
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
    attempt.awaitingStart = awaitingStart && attempt.pending === 1 && attempt.completed.size === 0;
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

  finishChooser(attempt: Attempt) {
    if (this.attempt !== attempt) return;
    attempt.pending--;
    if (attempt.cancelled) void this.settleCancelled(attempt);
    else this.finishAttempt(attempt);
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

  async trackOpening<T>(attempt: Attempt, operation: () => Promise<T>): Promise<T> {
    if (this.attempt !== attempt) throw new Error("Wallet connection attempt is no longer active.");
    attempt.pending++;
    try {
      return await operation();
    } finally {
      attempt.pending--;
      if (attempt.cancelled) void this.settleCancelled(attempt);
    }
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
    return this.track("walletConnect", async () => {
      const result = await super.connectWalletConnect(chainId);
      this.observeWalletConnectSession(this.getWalletConnectProvider());
      return result;
    });
  }

  override async setUniversalProvider(provider: Parameters<EthersAdapter["setUniversalProvider"]>[0]) {
    const walletProvider = provider as unknown as WalletConnectEventProvider;
    walletProvider.on?.("connect", () => {
      try { this.observeWalletConnectSession(walletProvider); }
      catch { cleanupFailed = true; }
    });
    walletProvider.on?.("session_delete", event => {
      this.completeWalletConnectSession(walletProvider, sessionDeleteTopic(event));
    });
    walletProvider.on?.("disconnect", event => {
      this.completeWalletConnectSession(walletProvider, disconnectTopic(event));
    });
    return super.setUniversalProvider(provider);
  }

  override disconnect(params: Parameters<EthersAdapter["disconnect"]>[0]) {
    const connector = params.id
      ? this.connectors.find(candidate => candidate.id.toLowerCase() === params.id?.toLowerCase())
      : undefined;
    if (!connector || connector.type !== "INJECTED") return super.disconnect(params);
    return this.disconnectInjected(connector.id, connector.provider);
  }

  private async disconnectInjected(connectorId: string, provider: unknown) {
    const connection = this.getConnection({
      connectorId,
      connections: this.connections,
      connectors: this.connectors
    });
    await this.revokeInjectedPermissions(provider);
    this.removeProviderListeners(connectorId);
    this.deleteConnection(connectorId);
    if (this.connections.length === 0) this.emit("disconnect");
    else this.emitFirstAvailableConnection();
    return { connections: connection ? [connection] : [] };
  }

  private async track<T>(connectorId: string, operation: () => Promise<T>): Promise<T> {
    const attempt = this.attempt;
    if (!attempt || attempt.cancelled) throw new WalletChooserBusyError();
    attempt.awaitingStart = false;
    attempt.pending++;
    try {
      const result = await operation();
      if (attempt.cancelled) {
        try { await this.disconnectCancelled(connectorId); }
        catch {
          cleanupFailed = true;
          throw new WalletChooserReloadError();
        }
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
    const cleanup = await Promise.allSettled(connectors.map(connector => this.disconnectCancelled(connector)));
    if (cleanup.some(result => result.status === "rejected")) cleanupFailed = true;
    this.finishAttempt(attempt);
  }

  private async disconnectCancelled(connectorId: string) {
    if (connectorId === "walletConnect") {
      await this.disconnectWalletConnectSession();
    }
    await this.disconnect({ id: connectorId });
  }

  async disconnectWalletConnectSession() {
    const candidate: unknown = this.getWalletConnectProvider();
    if (!isWalletConnectEventProvider(candidate)) {
      throw new Error("WalletConnect session could not be identified.");
    }
    const activeTopic = sessionTopic(candidate);
    const cleanup = activeTopic
      ? this.observeWalletConnectSession(candidate)
      : this.walletConnectCleanup;
    if (!cleanup || cleanup.provider !== candidate || (activeTopic && cleanup.topic !== activeTopic)) {
      throw new Error("WalletConnect session could not be identified.");
    }
    if (!activeTopic) {
      if (cleanup.failure) throw cleanup.failure;
      await cleanup.promise;
      return;
    }
    try {
      await candidate.disconnect();
    } catch (error) {
      cleanup.failure = error;
      throw error;
    }
    if (sessionTopic(candidate) != null) {
      const error = new Error("WalletConnect session cleanup did not finish.");
      cleanup.failure = error;
      throw error;
    }
    this.completeWalletConnectSession(candidate, activeTopic);
    await cleanup.promise;
  }

  private observeWalletConnectSession(provider: unknown, required = true) {
    if (!isWalletConnectEventProvider(provider)) {
      if (required) throw new Error("WalletConnect session could not be identified.");
      return undefined;
    }
    const topic = sessionTopic(provider);
    if (!topic) {
      if (required) throw new Error("WalletConnect session could not be identified.");
      return undefined;
    }
    const current = this.walletConnectCleanup;
    if (current?.provider === provider && current.topic === topic && !current.completed) return current;
    if (current && !current.completed) {
      throw new Error("Another WalletConnect session cleanup is still pending.");
    }
    let complete = () => {};
    const cleanup: WalletConnectCleanup = {
      provider,
      topic,
      completed: false,
      failure: undefined,
      promise: new Promise<void>(resolve => { complete = resolve; }),
      complete
    };
    cleanup.complete = () => {
      if (cleanup.completed) return;
      cleanup.completed = true;
      cleanup.failure = undefined;
      complete();
    };
    this.walletConnectCleanup = cleanup;
    return cleanup;
  }

  private completeWalletConnectSession(provider: object, topic: string | undefined) {
    const cleanup = this.walletConnectCleanup;
    if (!topic || !cleanup || cleanup.provider !== provider || cleanup.topic !== topic) return;
    cleanup.complete();
  }

  private async revokeInjectedPermissions(provider: unknown) {
    if (!isRequestProvider(provider)) return;
    try {
      const permissions = await provider.request({ method: "wallet_getPermissions" });
      if (Array.isArray(permissions) && permissions.some(permission => isEthAccountsPermission(permission))) {
        await provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
      }
    } catch (error) {
      console.info("Could not revoke permissions from wallet. Disconnecting...", error);
    }
  }
}

type WalletConnectEventProvider = {
  session?: unknown;
  disconnect(): Promise<void>;
  on?(event: string, listener: (value?: unknown) => void): void;
};

function isWalletConnectEventProvider(value: unknown): value is WalletConnectEventProvider {
  return Boolean(value && typeof value === "object" && "disconnect" in value && typeof value.disconnect === "function");
}

function sessionTopic(provider: { session?: unknown }): string | undefined {
  const session = provider.session;
  if (!session || typeof session !== "object" || !("topic" in session)) return undefined;
  return typeof session.topic === "string" && session.topic ? session.topic : undefined;
}

function sessionDeleteTopic(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("topic" in value)) return undefined;
  return typeof value.topic === "string" && value.topic ? value.topic : undefined;
}

function disconnectTopic(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("data" in value)) return undefined;
  return typeof value.data === "string" && value.data ? value.data : undefined;
}

function isRequestProvider(value: unknown): value is Pick<WalletProvider, "request"> {
  return Boolean(value && typeof value === "object" && "request" in value && typeof value.request === "function");
}

function isEthAccountsPermission(value: unknown) {
  return Boolean(value && typeof value === "object" && "parentCapability" in value && value.parentCapability === "eth_accounts");
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
let runtimeScope: string | undefined;
let pendingAttempt: Attempt | undefined;
let cleanupLease: { owner: object; promise: Promise<void> } | undefined;
let cleanupFailed = false;
const providerBridges = new WeakMap<object, WalletProvider>();

export async function createAppKitProvider(projectId: string, scope?: string): Promise<WalletChooser> {
  const key = scope ? consentKey(projectId, scope) : undefined;
  if (runtime && runtimeScope !== key) throw new WalletChooserReloadError();
  runtimeScope = key;
  runtime ??= initialize(projectId, key).catch(() => { throw new WalletChooserReloadError(); });
  const current = await runtime;
  return createChooser(current, key);
}

function savedConsent(key: string | undefined) {
  if (!key) return null;
  try { return readWalletConsent(key); } catch { return null; }
}

export function hasAuthorizedRestoreSession(provider: unknown, consent: WalletConsent): boolean {
  if (!provider || typeof provider !== "object" || !("session" in provider)) return false;
  const session = provider.session;
  if (!session || typeof session !== "object" || !("expiry" in session) || typeof session.expiry !== "number" || !Number.isSafeInteger(session.expiry) || session.expiry <= Date.now() / 1000 || !("namespaces" in session) || !session.namespaces || typeof session.namespaces !== "object" || !("eip155" in session.namespaces)) return false;
  const namespace = session.namespaces.eip155;
  if (!namespace || typeof namespace !== "object" || !("accounts" in namespace) || !Array.isArray(namespace.accounts) || !("methods" in namespace) || !Array.isArray(namespace.methods) || !("events" in namespace) || !Array.isArray(namespace.events)) return false;
  return namespace.accounts.some(account => typeof account === "string" && account.toLowerCase() === `eip155:${consent.chainId}:${consent.account.toLowerCase()}`)
    && namespace.methods.includes("personal_sign") && namespace.methods.includes("eth_sendTransaction")
    && namespace.events.includes("accountsChanged") && namespace.events.includes("chainChanged");
}

async function initialize(projectId: string, key?: string): Promise<AppKitRuntime> {
  // Lexical capture is initialized before AppKit's constructor invokes virtual hooks.
  class RestoringAdapter extends LabxEthersAdapter {
    override async syncConnection(params: Parameters<EthersAdapter["syncConnection"]>[0]): ReturnType<EthersAdapter["syncConnection"]> {
      const consent = savedConsent(key);
      const connector = this.connectors.find(candidate => candidate.id === params.id);
      const selectedProvider = connector?.provider;
      if (!consent || consent.chainId !== 11155111 || consent.connectorId !== params.id || ConnectorController.getConnectorId("eip155") !== consent.connectorId || !connector || !selectedProvider || !isWalletProvider(selectedProvider)) throw new Error("No matching authorized wallet connection.");
      const [accounts, chain] = await Promise.all([selectedProvider.request({ method: "eth_accounts" }), selectedProvider.request({ method: "eth_chainId" })]);
      if (!sameConsent(savedConsent(key), consent) || this.connectors.find(candidate => candidate.id === consent.connectorId)?.provider !== selectedProvider || ConnectorController.getConnectorId("eip155") !== consent.connectorId || !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== consent.account.toLowerCase() || Number(BigInt(normalizedChainId(chain))) !== consent.chainId) throw new Error("The saved wallet connection changed.");
      if (typeof selectedProvider.on !== "function" || typeof selectedProvider.removeListener !== "function") throw new Error("The wallet cannot report account or network changes safely.");
      this.listenProviderEvents(connector.id, selectedProvider as Parameters<typeof this.listenProviderEvents>[1]);
      return { address: getAddress(accounts[0]), chainId: consent.chainId, provider: selectedProvider, type: connector.type, id: connector.id };
    }
    override async syncConnections() { /* Never select a fallback wallet during SDK initialization. */ }
  }
  const adapter = new RestoringAdapter();
  class RestoringAppKit extends LabxAppKit {
    override async syncExistingConnection() {
      const consent = savedConsent(key);
      if (!consent || consent.chainId !== 11155111 || ConnectorController.getConnectorId("eip155") !== consent.connectorId) return;
      if (consent.connectorId === "walletConnect" && !hasAuthorizedRestoreSession(adapter.getWalletConnectProvider(), consent)) return;
      await super.syncExistingConnection();
    }
    override async syncAdapterConnections() { /* Restoration is limited to the previously selected connector. */ }
  }
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
    enableReconnect: true,
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
  const appKit = new RestoringAppKit({
    ...options,
    sdkVersion: CoreHelperUtil.generateSdkVersion([adapter], "html", PACKAGE_VERSION)
  }, adapter);
  await bounded(appKit.ready(), 20_000);
  return { appKit, adapter };
}

function createChooser({ appKit, adapter }: AppKitRuntime, key?: string): WalletChooser {
  const owner = {};
  let connected = false;
  let connectedConnector: string | undefined;
  let connectedProvider: unknown;
  let ownedAttempt: Attempt | undefined;
  let disconnecting: Promise<void> | undefined;
  return {
    remember(snapshot) {
      if (!key) return;
      if (!connected || !connectedConnector || ConnectorController.getConnectorId("eip155") !== connectedConnector || appKit.getProvider("eip155") !== connectedProvider || appKit.getAccount("eip155")?.address?.toLowerCase() !== snapshot.account.toLowerCase() || snapshot.chainId !== 11155111) throw new Error("The selected wallet changed before it could be saved.");
      saveWalletConsent(key, { connectorId: connectedConnector, account: snapshot.account, chainId: snapshot.chainId });
    },
    async restore(signal) {
      const consent = savedConsent(key);
      if (signal.aborted || !consent || cleanupFailed || cleanupLease || pendingAttempt || ConnectorController.getConnectorId("eip155") !== consent.connectorId) return null;
      const raw = appKit.getProvider<unknown>("eip155");
      if (!isWalletProvider(raw)) return null;
      if (consent.connectorId === "walletConnect" && (raw !== adapter.getWalletConnectProvider() || !hasAuthorizedRestoreSession(raw, consent))) return null;
      const provider = bridgeProvider(raw);
      for (let read = 0; read < 2; read++) {
        const [chain, accounts] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" })]);
        const account = appKit.getAccount("eip155");
        if (signal.aborted || !sameConsent(savedConsent(key), consent) || ConnectorController.getConnectorId("eip155") !== consent.connectorId || appKit.getProvider("eip155") !== raw || !account?.isConnected || account.address?.toLowerCase() !== consent.account.toLowerCase() || typeof chain !== "string" || Number(BigInt(chain)) !== consent.chainId || !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== consent.account.toLowerCase()) return null;
        if (consent.connectorId === "walletConnect" && (raw !== adapter.getWalletConnectProvider() || !hasAuthorizedRestoreSession(raw, consent))) return null;
      }
      connected = true;
      return provider;
    },
    async connect(signal) {
      if (cleanupFailed) throw new WalletChooserReloadError();
      if (cleanupLease) throw new WalletChooserBusyError();
      if (pendingAttempt) throw new WalletChooserBusyError();
      const attempt = adapter.beginAttempt();
      ownedAttempt = attempt;
      pendingAttempt = attempt;
      let opened = false;
      let observedProvider: WalletProvider | undefined;
      let stopAccessibility: (() => void) | undefined;
      let unsubscribeConnectors = () => {};
      let settled = false;
      let resultCleanup = () => {};
      const result = new Promise<WalletProvider>((resolve, reject) => {
        const accept = async () => {
          if (settled || signal.aborted || attempt.cancelled) return;
          const rawProvider = appKit.getProvider<unknown>("eip155");
          const account = appKit.getAccount("eip155");
          if (!account?.isConnected || !isWalletProvider(rawProvider)) return;
          if (observedProvider && observedProvider !== rawProvider) {
            cancel(new Error("The selected wallet changed while connecting. Please retry."));
            return;
          }
          observedProvider = rawProvider;
          const provider = bridgeProvider(rawProvider);
          try {
            const [chain, accounts] = await Promise.all([
              provider.request({ method: "eth_chainId" }),
              provider.request({ method: "eth_accounts" })
            ]);
            if (settled || signal.aborted || attempt.cancelled) return;
            if (appKit.getProvider("eip155") !== rawProvider) {
              cancel(new Error("The selected wallet changed while connecting. Please retry."));
              return;
            }
            if (typeof chain !== "string" || Number(BigInt(chain)) !== 11155111 || !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== account.address?.toLowerCase()) {
              throw new Error("The selected wallet did not return the approved Ethereum Sepolia account.");
            }
            await adapter.waitForController(attempt);
            if (settled || signal.aborted || attempt.cancelled) return;
            if (appKit.getProvider("eip155") !== rawProvider) {
              cancel(new Error("The selected wallet changed while connecting. Please retry."));
              return;
            }
            const currentAccount = appKit.getAccount("eip155");
            const [currentChain, currentAccounts] = await Promise.all([
              provider.request({ method: "eth_chainId" }),
              provider.request({ method: "eth_accounts" })
            ]);
            if (settled || signal.aborted || attempt.cancelled) return;
            if (appKit.getProvider("eip155") !== rawProvider || currentAccount?.address?.toLowerCase() !== account.address?.toLowerCase() || typeof currentChain !== "string" || Number(BigInt(currentChain)) !== 11155111 || !Array.isArray(currentAccounts) || typeof currentAccounts[0] !== "string" || currentAccounts[0].toLowerCase() !== currentAccount?.address?.toLowerCase()) {
              cancel(new Error("The selected wallet changed while connecting. Please retry."));
              return;
            }
            connectedConnector = key ? ConnectorController.getConnectorId("eip155") : undefined;
            connectedProvider = rawProvider;
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
          else if (opened && !connected && !observedProvider && !adapter.hasCompletedConnection(attempt)) cancel();
        });
        const unsubscribeEvents = appKit.subscribeEvents(state => {
          const event = state.data?.event;
          if (event === "CONNECT_ERROR" || event === "USER_REJECTED") {
            cancel(new Error(event === "USER_REJECTED" ? "Wallet connection was rejected." : "Wallet connection failed."));
          }
        });
        const abort = () => cancel();
        signal.addEventListener("abort", abort, { once: true });
        if (typeof document !== "undefined") {
          stopAccessibility = observeWalletConnectModal(document);
          unsubscribeConnectors = ConnectorController.subscribeKey("connectors", () => {
            if (!settled && !signal.aborted && !attempt.cancelled) refreshWalletConnectConnectorLists(document);
          });
        }
        const opening = adapter.trackOpening(attempt, async () => {
          await appKit.open({ view: "Connect", namespace: "eip155" });
          if (signal.aborted || attempt.cancelled) {
            try { await appKit.close(); }
            catch {
              cleanupFailed = true;
              throw new WalletChooserReloadError();
            }
            return false;
          }
          return true;
        });
        void opening.catch(error => cancel(error instanceof Error ? error : new Error("Wallet chooser could not open.")));
        resultCleanup = () => {
          unsubscribeAccount();
          unsubscribeState();
          unsubscribeEvents();
          unsubscribeCancellation();
          signal.removeEventListener("abort", abort);
          unsubscribeConnectors();
          stopAccessibility?.();
        };
      });
      try {
        return await result;
      } finally {
        resultCleanup();
        if (!connected) {
          adapter.cancelAttempt(attempt, Boolean(appKit.getState().connectingWallet));
        }
        try { await appKit.close(); }
        catch { cleanupFailed = true; }
        adapter.finishChooser(attempt);
        if (!connected) {
          void attempt.settled.finally(() => {
            if (pendingAttempt === attempt) pendingAttempt = undefined;
          });
        } else if (pendingAttempt === attempt) {
          pendingAttempt = undefined;
        }
      }
    },
    async disconnect() {
      if (disconnecting) return disconnecting;
      if (cleanupLease && cleanupLease.owner !== owner) return cleanupLease.promise;
      if (!connected && !ownedAttempt) return;
      disconnecting = (async () => {
        let failure: unknown;
        try { await appKit.close(); }
        catch (error) { failure = error; }
        if (connected) {
          const walletConnect = appKit.getWalletProviderType() === "WALLET_CONNECT";
          let walletConnectCleanupFailed = false;
          if (walletConnect) {
            try { await adapter.disconnectWalletConnectSession(); }
            catch (error) {
              walletConnectCleanupFailed = true;
              failure ??= error;
            }
          }
          if (!walletConnectCleanupFailed) {
            try { await appKit.disconnect("eip155"); }
            catch (error) { failure ??= error; }
          }
        }
        if (ownedAttempt) await ownedAttempt.settled;
        if (cleanupFailed) failure ??= new WalletChooserReloadError();
        connected = false;
        ownedAttempt = undefined;
        if (failure) throw new WalletChooserReloadError();
      })();
      const lease = { owner, promise: disconnecting };
      cleanupLease = lease;
      void disconnecting.then(() => {
        if (cleanupLease === lease) cleanupLease = undefined;
      }, () => { cleanupFailed = true; });
      return disconnecting;
    }
  };
}

function isWalletProvider(provider: unknown): provider is WalletProvider {
  return Boolean(provider && typeof provider === "object" && "request" in provider && typeof provider.request === "function");
}

function bridgeProvider(raw: WalletProvider): WalletProvider {
  const key = raw as object;
  const existing = providerBridges.get(key);
  if (existing) return existing;
  const listeners = new Map<string, Map<(...args: unknown[]) => void, (...args: unknown[]) => void>>();
  const bridge: WalletProvider = {
    async request(input) {
      const result = await raw.request.call(raw, input);
      return input.method === "eth_chainId" ? normalizedChainId(result) : result;
    },
    on(event, listener) {
      const forwarded = event === "chainChanged"
        ? (chain: unknown, ...rest: unknown[]) => {
            let forwardedChain = chain;
            try { forwardedChain = normalizedChainEvent(chain); }
            catch {}
            listener(forwardedChain, ...rest);
          }
        : listener;
      const eventListeners = listeners.get(event) ?? new Map();
      eventListeners.set(listener, forwarded);
      listeners.set(event, eventListeners);
      raw.on?.call(raw, event, forwarded);
    },
    removeListener(event, listener) {
      const eventListeners = listeners.get(event);
      const forwarded = eventListeners?.get(listener) ?? listener;
      eventListeners?.delete(listener);
      if (eventListeners?.size === 0) listeners.delete(event);
      raw.removeListener?.call(raw, event, forwarded);
    }
  };
  providerBridges.set(key, bridge);
  return bridge;
}

function normalizedChainEvent(value: unknown): string {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const numeric = BigInt(value);
    if (numeric > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Wallet returned an invalid network.");
    return `0x${numeric.toString(16)}`;
  }
  return normalizedChainId(value);
}

function normalizedChainId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Wallet returned an invalid network.");
    return `0x${value.toString(16)}`;
  }
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("Wallet returned an invalid network.");
  const numeric = BigInt(value);
  if (numeric > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Wallet returned an invalid network.");
  return `0x${numeric.toString(16)}`;
}
