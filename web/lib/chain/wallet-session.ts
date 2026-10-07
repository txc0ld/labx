import { isHex, stringToHex, toHex } from "viem";
import type { WalletSessionPort } from "./ports";
import type { WalletProvider, WalletSnapshot } from "./types";
import { address, hash, sameAddress } from "./validation";

export class WalletSession implements WalletSessionPort {
  private state: WalletSnapshot = { kind: "disconnected", revision: 0 };
  private listeners = new Set<() => void>();
  private suspended = false;
  private disposed = false;
  private epoch = 0;
  private retireListeners = () => {};
  constructor(private provider: WalletProvider | undefined, protected readonly chainId = 11155111) {
    this.listen();
  }
  private listen() {
    const provider = this.provider, epoch = this.epoch;
    const current = () => this.provider === provider && this.epoch === epoch && !this.disposed;
    const invalidate = () => {
      if (!current()) return;
      this.invalidateSnapshot();
      void this.refresh().catch(() => {});
    };
    const disconnected = () => { if (current()) this.disconnect(); };
    provider?.on?.("accountsChanged", invalidate);
    provider?.on?.("chainChanged", invalidate);
    provider?.on?.("disconnect", disconnected);
    provider?.on?.("session_delete", disconnected);
    this.retireListeners = () => {
      provider?.removeListener?.("accountsChanged", invalidate);
      provider?.removeListener?.("chainChanged", invalidate);
      provider?.removeListener?.("disconnect", disconnected);
      provider?.removeListener?.("session_delete", disconnected);
    };
  }
  protected replaceProvider(provider: WalletProvider | undefined) {
    if (this.disposed) throw new Error("Wallet session has been disposed.");
    this.retireListeners();
    this.epoch++;
    this.provider = provider;
    this.suspended = false;
    this.invalidateSnapshot();
    this.listen();
  }
  dispose() {
    this.disconnect();
    this.disposed = true;
    this.retireListeners();
    this.listeners.clear();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  protected notify() { for (const listener of this.listeners) listener(); }
  private publish(state: WalletSnapshot) { this.state = state; this.notify(); }
  private invalidateSnapshot() { this.publish({ kind: "disconnected", revision: this.state.revision + 1 }); }
  private requiredProvider() {
    if (this.disposed || !this.provider) throw new Error("Open this website in a wallet browser or install a wallet to continue.");
    return this.provider;
  }
  private assertProvider(provider: WalletProvider, epoch: number) {
    if (this.disposed || this.suspended || this.provider !== provider || this.epoch !== epoch) throw new Error("Wallet or network changed. Review this action again.");
  }
  private assertSnapshot(expected: Extract<WalletSnapshot, { kind: "connected" }>) {
    const current = this.state;
    if (this.disposed || this.suspended || current.kind !== "connected" || current.revision !== expected.revision || current.chainId !== expected.chainId || current.chainId !== this.chainId || !sameAddress(current.account, expected.account)) throw new Error("Wallet or network changed. Review this action again.");
  }
  async refresh(): Promise<WalletSnapshot> {
    if (!this.provider || this.suspended || this.disposed) return this.state;
    const provider = this.provider, epoch = this.epoch, revision = this.state.revision;
    const [chain, accounts] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" })]);
    if (this.provider !== provider || this.epoch !== epoch || this.state.revision !== revision || this.suspended || this.disposed) return this.state;
    if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || !Array.isArray(accounts)) throw new Error("Wallet returned an invalid session.");
    const chainId = Number(BigInt(chain));
    if (!Number.isSafeInteger(chainId)) throw new Error("Wallet returned an invalid network.");
    if (!accounts.length) { if (this.state.kind !== "disconnected") this.invalidateSnapshot(); return this.state; }
    const account = address(accounts[0]);
    if (this.state.kind !== "connected" || !sameAddress(this.state.account, account) || this.state.chainId !== chainId) this.publish({ kind: "connected", account, chainId, revision: revision + 1 });
    return this.state;
  }
  async connect(): Promise<WalletSnapshot> {
    const provider = this.requiredProvider();
    this.retireListeners();
    this.epoch++;
    const epoch = this.epoch;
    this.suspended = false;
    this.invalidateSnapshot();
    this.listen();
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(this.chainId) }] });
    this.assertProvider(provider, epoch);
    await provider.request({ method: "eth_requestAccounts" });
    this.assertProvider(provider, epoch);
    const snapshot = await this.refresh();
    this.assertProvider(provider, epoch);
    if (snapshot.kind !== "connected" || snapshot.chainId !== this.chainId) throw new Error("Connect the requested test network to continue.");
    return snapshot;
  }
  disconnect() {
    this.suspended = true;
    this.epoch++;
    this.retireListeners();
    this.invalidateSnapshot();
  }
  async assertCurrent(expected: Extract<WalletSnapshot, { kind: "connected" }>) {
    await this.refresh();
    this.assertSnapshot(expected);
  }
  async requestTransaction(expected: Extract<WalletSnapshot, { kind: "connected" }>, transaction: Parameters<WalletSessionPort["requestTransaction"]>[1], beforeRequest?: () => Promise<void>, onProviderRequest?: () => void) {
    const provider = this.requiredProvider(), epoch = this.epoch;
    await this.assertCurrent(expected);
    this.assertProvider(provider, epoch);
    this.assertSnapshot(expected);
    await beforeRequest?.();
    await this.assertCurrent(expected);
    this.assertProvider(provider, epoch);
    this.assertSnapshot(expected);
    onProviderRequest?.();
    this.assertProvider(provider, epoch);
    this.assertSnapshot(expected);
    const result = await provider.request({ method: "eth_sendTransaction", params: [{ from: expected.account, to: transaction.to, data: transaction.data, value: toHex(transaction.value), chainId: toHex(expected.chainId), ...(transaction.nonce === undefined ? {} : { nonce: toHex(transaction.nonce) }) }] });
    return hash(result);
  }
  async signMessage({ message, expected }: Parameters<WalletSessionPort["signMessage"]>[0]) {
    const provider = this.requiredProvider(), epoch = this.epoch;
    await this.assertCurrent(expected);
    this.assertProvider(provider, epoch);
    this.assertSnapshot(expected);
    if (!message.startsWith("LABx ") || message.length > 24_000) throw new Error("Invalid LABx authorization message.");
    const result = await provider.request({ method: "personal_sign", params: [stringToHex(message), expected.account] });
    await this.assertCurrent(expected);
    this.assertProvider(provider, epoch);
    this.assertSnapshot(expected);
    if (typeof result !== "string" || !isHex(result, { strict: true }) || result.length > 16_386) throw new Error("Wallet returned an invalid signature.");
    return result;
  }
}
