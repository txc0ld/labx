import type { RemoteWallet } from "./wallet-connectors";
import { bounded, WalletConnectBusyError } from "./wallet-connectors";

let modalTurn: Promise<void> = Promise.resolve();
let initializing = false;
let pendingApprovals = 0;

export async function createWalletConnectProvider(projectId: string): Promise<RemoteWallet> {
  if (initializing) throw new WalletConnectBusyError();
  initializing = true;
  try { return await initializeProvider(projectId); }
  finally { initializing = false; }
}

async function initializeProvider(projectId: string): Promise<RemoteWallet> {
  const [{ EthereumProvider }, { createAppKit }, { sepolia }] = await Promise.all([
    import("@walletconnect/ethereum-provider"), import("@reown/appkit/core"), import("@reown/appkit/networks")
  ]);
  let retired = false;
  const storage = new Map<string, string>();
  const memoryStorage = {
    async getKeys() { return [...storage.keys()]; },
    async getEntries<T>(): Promise<[string, T][]> {
      return [...storage.entries()].map(([key, value]) => [key, JSON.parse(value)]);
    },
    async getItem<T>(key: string): Promise<T | undefined> {
      const value = storage.get(key);
      return value === undefined ? undefined : JSON.parse(value);
    },
    async setItem<T>(key: string, value: T) { if (!retired) storage.set(key, JSON.stringify(value)); },
    async removeItem(key: string) { storage.delete(key); }
  };
  // Each attempt has isolated SDK storage. A cancelled proposal can still be approved remotely.
  const attemptId = `labx-${crypto.randomUUID()}`;
  const provider = await EthereumProvider.init({
    projectId,
    chains: [11155111], optionalChains: [],
    methods: ["personal_sign", "eth_sendTransaction"], optionalMethods: [],
    events: ["accountsChanged", "chainChanged"], optionalEvents: [],
    showQrModal: false, telemetryEnabled: false,
    customStoragePrefix: attemptId,
    storage: memoryStorage,
    rpcMap: { 11155111: "https://ethereum-sepolia-rpc.publicnode.com" },
    metadata: { name: "LABx", description: "LABx on Ethereum Sepolia", url: window.location.origin, icons: [`${window.location.origin}/favicon.svg`] }
  });
  let closeModal: (() => void) | undefined;
  let cleaning: Promise<void> | undefined;
  const disconnect = (): Promise<void> => {
    retired = true;
    closeModal?.();
    closeModal = undefined;
    if (cleaning) return cleaning;
    cleaning = (async () => {
      const core = provider.signer.client.core;
      try {
        const results = await bounded(Promise.allSettled([
          provider.disconnect(),
          ...core.pairing.getPairings().map(({ topic }) => core.pairing.disconnect({ topic }))
        ]), 3_000);
        if (results.some(result => result.status === "rejected")) throw new Error("Remote wallet cleanup failed.");
      } finally {
        core.heartbeat.stop();
        provider.events.removeAllListeners();
        provider.signer.events.removeAllListeners();
        storage.clear();
        await bounded(core.relayer.transportClose(), 1_000);
      }
    })();
    return cleaning;
  };
  return {
    provider: {
      request: ({ method, params }) => provider.request({ method, params: params ? [...params] : undefined }),
      on: (event, listener) => {
        if (event === "accountsChanged" || event === "chainChanged" || event === "disconnect" || event === "session_delete") provider.on(event, listener);
      },
      removeListener: (event, listener) => {
        if (event === "accountsChanged" || event === "chainChanged" || event === "disconnect" || event === "session_delete") provider.removeListener(event, listener);
      }
    },
    disconnect,
    connect(signal) {
      const operation = modalTurn.then(() => connect(signal));
      modalTurn = operation.catch(() => {});
      return operation;
    }
  };
  async function connect(signal: AbortSignal) {
      if (retired || signal.aborted) throw new Error("Wallet connection cancelled.");
      if (pendingApprovals >= 3) throw new WalletConnectBusyError();
      const modal = createAppKit({
        projectId, networks: [sepolia], universalProvider: provider.signer,
        manualWCControl: true, enableReconnect: false, enableInjected: false, enableEIP6963: false, enableCoinbase: false,
        features: { analytics: false, email: false, socials: false, onramp: false, swaps: false },
        themeMode: "light", themeVariables: { "--w3m-accent": "#111111", "--w3m-z-index": 1000 },
        metadata: { name: "LABx", description: "LABx on Ethereum Sepolia", url: window.location.origin, icons: [`${window.location.origin}/favicon.svg`] }
      });
      let opened = false;
      let rejectCancellation: (reason: Error) => void = () => {};
      const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
      void cancelled.catch(() => {});
      const cancel = () => rejectCancellation(new Error("Wallet connection cancelled."));
      const unsubscribe = modal.subscribeState(state => {
        if (state.open) opened = true;
        else if (opened && !provider.session) cancel();
      });
      const displayUri = (uri: string) => {
        if (!retired && !signal.aborted) void modal.open({ view: "ConnectingWalletConnectBasic", uri }).catch(() => cancel());
      };
      closeModal = () => {
        unsubscribe();
        provider.removeListener("display_uri", displayUri);
        signal.removeEventListener("abort", cancel);
        void modal.close().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      provider.on("display_uri", displayUri);
      try {
        await bounded(modal.ready(), 20_000);
        if (retired || signal.aborted) throw new Error("Wallet connection cancelled.");
      } catch (error) {
        closeModal?.();
        closeModal = undefined;
        throw error;
      }
      pendingApprovals++;
      const connecting = Promise.resolve().then(() => provider.connect()).finally(() => { pendingApprovals--; });
      void connecting.then(() => {
        if ((retired || signal.aborted) && provider.session) {
          const core = provider.signer.client.core;
          void bounded(provider.signer.client.disconnect({ topic: provider.session.topic, reason: { code: 6000, message: "Connection cancelled" } }), 3_000)
            .catch(() => {}).finally(() => {
              storage.clear();
              void bounded(core.relayer.transportClose(), 1_000).catch(() => {});
            });
        }
      }, () => {});
      try {
        await Promise.race([connecting, cancelled]);
        if (retired || signal.aborted) throw new Error("Wallet connection cancelled.");
      } finally {
        closeModal?.();
        closeModal = undefined;
      }
  }
}
