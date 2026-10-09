import { consentKey, readWalletConsent, revokeWalletConsent, sameConsent, saveWalletConsent } from "./wallet-consent";
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
  restore?(signal: AbortSignal): Promise<WalletProvider | null>;
  remember?(snapshot: Extract<WalletSnapshot, { kind: "connected" }>): void;
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

export type WalletChooserFactory = (projectId: string, scope?: string) => Promise<WalletChooser>;

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
  private restoring = false;
  private restorationDisposed = false;
  private retireStorageListener = () => {};
  readonly connectionOptions: readonly ConnectionOption[];

  constructor(
    private readonly localInjected: WalletProvider | undefined,
    chainId: 11155111 | 31337,
    private readonly projectId: string | undefined,
    private readonly loadChooser: WalletChooserFactory,
    private readonly restoreScope?: string
  ) {
    super(undefined, chainId);
    if (restoreScope && typeof window !== "undefined") {
      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === consentKey(this.projectId, restoreScope)) {
          ++this.attempt;
          this.abort?.abort();
          this.restoring = false;
          this.inFlight = undefined;
          this.activeOwner = undefined;
          super.disconnect();
          this.replaceProvider(undefined);
          this.chooser = undefined;
          this.status({ kind: "idle" });
        }
      };
      window.addEventListener("storage", onStorage);
      this.retireStorageListener = () => window.removeEventListener("storage", onStorage);
    }
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
    this.cleanup = this.cleanup.catch(() => {}).then(() => bounded(chooser.disconnect(), 8_000)).catch(error => {
      if (attempt === this.attempt && this.connection.kind === "idle") {
        this.status({
          kind: "error",
          message: error instanceof WalletChooserReloadError
            ? error.message
            : "Wallet cleanup could not be confirmed. Reload this page before connecting again."
        });
      }
    });
  }

  override dispose() { this.restorationDisposed = true; this.retireStorageListener(); super.dispose(); }

  restore(): Promise<WalletSnapshot> {
    if (this.restorationDisposed) return Promise.resolve(this.getSnapshot());
    if (this.inFlight) return this.inFlight;
    if (!this.restoreScope || typeof window === "undefined") return Promise.resolve(this.getSnapshot());
    const key = consentKey(this.projectId, this.restoreScope);
    let consent;
    try { consent = readWalletConsent(key); } catch { return Promise.resolve(this.getSnapshot()); }
    if (!consent || consent.chainId !== this.chainId || this.connectionOptions[0]?.unavailable) return Promise.resolve(this.getSnapshot());
    const expectedConsent = consent;
    const attempt = ++this.attempt;
    const abort = new AbortController();
    this.abort = abort;
    this.restoring = true;
    const promise = (async () => {
      try {
        await this.cleanup;
        this.active(attempt, abort);
        const project = this.projectId;
        if (this.chainId !== 31337 && !project) return this.getSnapshot();
        const chooser = this.chainId === 31337 || !project ? undefined : await bounded(this.loadChooser(project, this.restoreScope), 20_000);
        this.active(attempt, abort);
        const provider = this.chainId === 31337 ? this.localInjected : await chooser?.restore?.(abort.signal);
        this.active(attempt, abort);
        if (!provider || !sameConsent(readWalletConsent(key), expectedConsent)) return this.getSnapshot();
        const [accounts, chain] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
        this.active(attempt, abort);
        if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== expectedConsent.account.toLowerCase() || typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || Number(BigInt(chain)) !== expectedConsent.chainId || !sameConsent(readWalletConsent(key), expectedConsent)) return this.getSnapshot();
        this.replaceProvider(provider);
        const snapshot = await this.refresh();
        this.active(attempt, abort);
        if (!sameConsent(readWalletConsent(key), expectedConsent) || snapshot.kind !== "connected" || snapshot.account.toLowerCase() !== expectedConsent.account.toLowerCase() || snapshot.chainId !== expectedConsent.chainId) {
          this.replaceProvider(undefined);
          return this.getSnapshot();
        }
        this.chooser = chooser;
        return snapshot;
      } catch {
        if (attempt === this.attempt) this.replaceProvider(undefined);
        return this.getSnapshot();
      } finally {
        if (attempt === this.attempt) { this.inFlight = undefined; this.restoring = false; }
      }
    })();
    this.inFlight = promise;
    return promise;
  }

  override disconnect() {
    let persistenceError: string | undefined;
    if (this.restoreScope && typeof window !== "undefined") {
      try { revokeWalletConsent(consentKey(this.projectId, this.restoreScope)); } catch { persistenceError = "Disconnected. Browser storage could not save this change. Close this tab before returning."; }
    }
    this.restoring = false;
    ++this.attempt;
    super.disconnect();
    this.retire();
    this.inFlight = undefined;
    this.activeOwner = undefined;
    this.status(persistenceError ? { kind: "error", message: persistenceError } : { kind: "idle" });
  }

  override connect(options: WalletConnectOptions = {}): Promise<WalletSnapshot> {
    const connector = options.connector ?? "appkit";
    if (this.restoring) { ++this.attempt; this.abort?.abort(); this.inFlight = undefined; this.restoring = false; this.replaceProvider(undefined); }
    if (this.inFlight) {
      if (this.activeOwner === options.owner) return this.inFlight;
      return Promise.reject(new WalletChooserBusyError());
    }
    const unavailable = this.connectionOptions[0]?.unavailable;
    if (unavailable) {
      this.status({ kind: "error", message: unavailable });
      return Promise.reject(new Error(unavailable));
    }
    if (this.restoreScope && typeof window !== "undefined") window.localStorage.removeItem(consentKey(this.projectId, this.restoreScope));
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
    if (this.getSnapshot().kind === "connected") return;
    ++this.attempt;
    super.disconnect();
    this.retire();
    this.inFlight = undefined;
    this.activeOwner = undefined;
    this.status({ kind: "idle" });
  }

  private active(attempt: number, abort: AbortController) {
    if (this.restorationDisposed || attempt !== this.attempt || abort.signal.aborted) throw new Error("Wallet connection cancelled.");
  }

  private async establish(attempt: number, abort: AbortController): Promise<WalletSnapshot> {
    try {
      await this.cleanup;
      this.active(attempt, abort);
      if (this.chainId === 31337) {
        this.replaceProvider(this.localInjected);
        const snapshot = await super.connect();
        this.active(attempt, abort);
        if (this.restoreScope && snapshot.kind === "connected") saveWalletConsent(consentKey(this.projectId, this.restoreScope), { connectorId: "local-injected", account: snapshot.account, chainId: snapshot.chainId });
        this.status({ kind: "idle" });
        return snapshot;
      }
      if (!this.projectId) throw new Error("Wallet connection is not configured.");
      const loading = this.loadChooser(this.projectId, this.restoreScope);
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
      chooser.remember?.(snapshot);
      this.status({ kind: "idle" });
      return snapshot;
    } catch (error) {
      if (attempt === this.attempt) {
        if (this.restoreScope && typeof window !== "undefined") {
          try { window.localStorage.removeItem(consentKey(this.projectId, this.restoreScope)); } catch {}
        }
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
