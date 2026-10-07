import { WalletSession } from "./wallet-session";
import type { WalletProvider, WalletSnapshot } from "./types";

export type WalletConnector = "injected" | "walletconnect";
export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "pending"; connector: WalletConnector }
  | { kind: "error"; message: string };
export type ConnectionOption = { connector: WalletConnector; label: string; unavailable: string | null };
export interface RemoteWallet {
  provider: WalletProvider;
  connect(signal: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
}
export class WalletConnectBusyError extends Error {
  constructor() { super("Earlier WalletConnect requests are still closing. Wait a few minutes or reload this page before retrying."); }
}

export type RemoteWalletFactory = (projectId: string) => Promise<RemoteWallet>;

export async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Wallet connection timed out. Please retry.")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export class BrowserWalletSession extends WalletSession {
  private connection: ConnectionStatus = { kind: "idle" };
  private attempt = 0;
  private abort: AbortController | undefined;
  private remote: RemoteWallet | undefined;
  private inFlight: { connector: WalletConnector; promise: Promise<WalletSnapshot> } | undefined;
  readonly connectionOptions: readonly ConnectionOption[];

  constructor(private readonly injected: WalletProvider | undefined, chainId: 11155111 | 31337, private readonly projectId: string | undefined, private readonly loadRemote: RemoteWalletFactory) {
    super(injected, chainId);
    this.connectionOptions = [
      { connector: "injected", label: "Browser wallet", unavailable: injected ? null : "No browser wallet found." },
      { connector: "walletconnect", label: "WalletConnect", unavailable: chainId !== 11155111 ? "WalletConnect is unavailable for local test networks." : !projectId || !/^[a-f0-9]{32}$/i.test(projectId) ? "WalletConnect is not configured." : null }
    ];
  }
  getConnectionStatus = () => this.connection;
  private status(connection: ConnectionStatus) { this.connection = connection; this.notify(); }
  private retire() {
    this.abort?.abort();
    this.abort = undefined;
    const remote = this.remote;
    this.remote = undefined;
    const attempt = this.attempt;
    if (remote) void bounded(remote.disconnect(), 5_000).catch(() => {
      if (attempt === this.attempt && this.connection.kind === "idle") this.status({ kind: "error", message: "Disconnected locally. Remove the LABx session in your wallet if it is still listed." });
    });
  }
  override disconnect() {
    ++this.attempt;
    super.disconnect();
    this.retire();
    this.inFlight = undefined;
    this.status({ kind: "idle" });
  }
  override connect(connector: WalletConnector = "injected"): Promise<WalletSnapshot> {
    if (this.inFlight?.connector === connector) return this.inFlight.promise;
    const unavailable = this.connectionOptions.find(option => option.connector === connector)?.unavailable;
    if (unavailable) {
      this.status({ kind: "error", message: unavailable });
      return Promise.reject(new Error(unavailable));
    }
    const attempt = ++this.attempt;
    this.retire();
    this.replaceProvider(undefined);
    const abort = new AbortController();
    this.abort = abort;
    this.status({ kind: "pending", connector });
    const promise = this.establish(connector, attempt, abort).finally(() => {
      if (attempt === this.attempt) this.inFlight = undefined;
    });
    this.inFlight = { connector, promise };
    return promise;
  }
  private active(attempt: number, abort: AbortController) {
    if (attempt !== this.attempt || abort.signal.aborted) throw new Error("Wallet connection cancelled.");
  }
  private async establish(connector: WalletConnector, attempt: number, abort: AbortController): Promise<WalletSnapshot> {
    try {
      if (connector === "injected") {
        this.replaceProvider(this.injected);
        const snapshot = await super.connect();
        this.active(attempt, abort);
        this.status({ kind: "idle" });
        return snapshot;
      }
      if (!this.projectId) throw new Error("WalletConnect is not configured.");
      const loading = this.loadRemote(this.projectId);
      void loading.then(remote => {
        if (attempt !== this.attempt || abort.signal.aborted) void bounded(remote.disconnect(), 5_000).catch(() => {});
      }, () => {});
      const remote = await bounded(loading, 20_000);
      this.active(attempt, abort);
      this.remote = remote;
      await bounded(remote.connect(abort.signal), 120_000);
      this.active(attempt, abort);
      this.replaceProvider(remote.provider);
      const snapshot = await this.refresh();
      this.active(attempt, abort);
      if (snapshot.kind !== "connected" || snapshot.chainId !== 11155111) throw new Error("Connect Ethereum Sepolia to continue.");
      this.status({ kind: "idle" });
      return snapshot;
    } catch (error) {
      if (attempt === this.attempt) {
        super.disconnect();
        this.retire();
        const message = error instanceof WalletConnectBusyError ? error.message : connector === "walletconnect" ? "WalletConnect was cancelled or could not connect to Sepolia. Please retry." : "Browser wallet could not connect. Approve the request on the test network and retry.";
        this.status({ kind: "error", message });
      }
      throw error;
    }
  }
}
