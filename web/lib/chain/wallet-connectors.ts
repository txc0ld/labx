import { WalletSession } from "./wallet-session";
import type { WalletProvider, WalletSnapshot } from "./types";

export type WalletConnector = "appkit";
export type WalletConnectOptions = { connector?: WalletConnector; owner?: object };
export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "pending"; connector: WalletConnector }
  | { kind: "error"; message: string };
export type ConnectionOption = { connector: WalletConnector; label: string; unavailable: string | null };

export interface WalletChooser {
  connect(signal: AbortSignal): Promise<WalletProvider>;
  disconnect(): Promise<void>;
}

export class WalletChooserBusyError extends Error {
  constructor() {
    super("A wallet request is still pending. Finish or reject it in the wallet, or reload this page before retrying.");
  }
}

export class WalletChooserReloadError extends Error {
  constructor() {
    super("The wallet chooser could not initialize safely. Reload this page before retrying.");
  }
}

export type WalletChooserFactory = (projectId: string) => Promise<WalletChooser>;

export async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Wallet connection timed out. Please retry.")), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export class BrowserWalletSession extends WalletSession {
  private connection: ConnectionStatus = { kind: "idle" };
  private attempt = 0;
  private abort: AbortController | undefined;
  private chooser: WalletChooser | undefined;
  private cleanup: Promise<void> = Promise.resolve();
  private inFlight: Promise<WalletSnapshot> | undefined;
  private activeOwner: object | undefined;
  readonly connectionOptions: readonly ConnectionOption[];

  constructor(
    private readonly localInjected: WalletProvider | undefined,
    chainId: 11155111 | 31337,
    private readonly projectId: string | undefined,
    private readonly loadChooser: WalletChooserFactory
  ) {
    super(chainId === 31337 ? localInjected : undefined, chainId);
    this.connectionOptions = [{
      connector: "appkit",
      label: "Connect wallet",
      unavailable: chainId === 31337
        ? localInjected ? null : "No local test wallet found."
        : !projectId || !/^[a-f0-9]{32}$/i.test(projectId) ? "Wallet connection is not configured." : null
    }];
  }

  getConnectionStatus = () => this.connection;

  private status(connection: ConnectionStatus) {
    this.connection = connection;
    this.notify();
  }

  private retire() {
    this.abort?.abort();
    this.abort = undefined;
    const chooser = this.chooser;
    this.chooser = undefined;
    if (!chooser) return;
    const attempt = this.attempt;
    this.cleanup = this.cleanup.catch(() => {}).then(() => bounded(chooser.disconnect(), 8_000)).catch(() => {
      if (attempt === this.attempt && this.connection.kind === "idle") {
        this.status({ kind: "error", message: "Disconnected locally. Remove the LABx session in your wallet if it is still listed." });
      }
    });
  }

  override disconnect() {
    ++this.attempt;
    super.disconnect();
    this.retire();
    this.inFlight = undefined;
    this.activeOwner = undefined;
    this.status({ kind: "idle" });
  }

  override connect(options: WalletConnectOptions = {}): Promise<WalletSnapshot> {
    const connector = options.connector ?? "appkit";
    if (this.inFlight) {
      if (this.activeOwner === options.owner) return this.inFlight;
      return Promise.reject(new WalletChooserBusyError());
    }
    const unavailable = this.connectionOptions[0]?.unavailable;
    if (unavailable) {
      this.status({ kind: "error", message: unavailable });
      return Promise.reject(new Error(unavailable));
    }
    const attempt = ++this.attempt;
    this.retire();
    this.replaceProvider(undefined);
    const abort = new AbortController();
    this.abort = abort;
    this.activeOwner = options.owner;
    this.status({ kind: "pending", connector });
    const promise = this.establish(attempt, abort).finally(() => {
      if (attempt === this.attempt) {
        this.inFlight = undefined;
        this.activeOwner = undefined;
      }
    });
    this.inFlight = promise;
    return promise;
  }

  cancelConnection(owner: object) {
    if (!this.inFlight || this.activeOwner !== owner) return;
    ++this.attempt;
    super.disconnect();
    this.retire();
    this.inFlight = undefined;
    this.activeOwner = undefined;
    this.status({ kind: "idle" });
  }

  private active(attempt: number, abort: AbortController) {
    if (attempt !== this.attempt || abort.signal.aborted) throw new Error("Wallet connection cancelled.");
  }

  private async establish(attempt: number, abort: AbortController): Promise<WalletSnapshot> {
    try {
      await this.cleanup;
      this.active(attempt, abort);
      if (this.chainId === 31337) {
        this.replaceProvider(this.localInjected);
        const snapshot = await super.connect();
        this.active(attempt, abort);
        this.status({ kind: "idle" });
        return snapshot;
      }
      if (!this.projectId) throw new Error("Wallet connection is not configured.");
      const loading = this.loadChooser(this.projectId);
      void loading.then(chooser => {
        if (attempt !== this.attempt || abort.signal.aborted) void bounded(chooser.disconnect(), 8_000).catch(() => {});
      }, () => {});
      const chooser = await bounded(loading, 20_000);
      this.active(attempt, abort);
      this.chooser = chooser;
      const provider = await bounded(chooser.connect(abort.signal), 120_000);
      this.active(attempt, abort);
      this.replaceProvider(provider);
      const snapshot = await this.refresh();
      this.active(attempt, abort);
      if (snapshot.kind !== "connected" || snapshot.chainId !== 11155111) {
        throw new Error("Connect Ethereum Sepolia to continue.");
      }
      this.status({ kind: "idle" });
      return snapshot;
    } catch (error) {
      if (attempt === this.attempt) {
        super.disconnect();
        this.retire();
        const message = error instanceof WalletChooserBusyError || error instanceof WalletChooserReloadError
          ? error.message
          : error instanceof Error && /still pending|finish or reject/i.test(error.message)
            ? error.message
            : "Wallet connection was cancelled or could not connect to Ethereum Sepolia. Please retry.";
        this.status({ kind: "error", message });
      }
      throw error;
    }
  }
}
