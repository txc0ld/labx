import { isHex, stringToHex, toHex } from "viem";
import type { WalletSessionPort } from "./ports";
import type { WalletProvider, WalletSnapshot } from "./types";
import { address, hash, sameAddress } from "./validation";

export class WalletSession implements WalletSessionPort {
  private state: WalletSnapshot = { kind: "disconnected", revision: 0 };
  private listeners = new Set<() => void>();
  private suspended = false;
  private readonly invalidate = () => { this.publish({ kind: "disconnected", revision: this.state.revision + 1 }); void this.refresh().catch(() => {}); };
  private readonly disconnected = () => { this.publish({ kind: "disconnected", revision: this.state.revision + 1 }); };
  constructor(private readonly provider: WalletProvider | undefined, private readonly chainId = 11155111) {
    provider?.on?.("accountsChanged", this.invalidate); provider?.on?.("chainChanged", this.invalidate); provider?.on?.("disconnect", this.disconnected);
  }
  dispose() {
    this.provider?.removeListener?.("accountsChanged", this.invalidate); this.provider?.removeListener?.("chainChanged", this.invalidate); this.provider?.removeListener?.("disconnect", this.disconnected);
    this.listeners.clear();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: WalletSnapshot) { this.state = state; for (const listener of this.listeners) listener(); }
  private requiredProvider() { if (!this.provider) throw new Error("Open this website in a wallet browser or install a wallet to continue."); return this.provider; }
  async refresh(): Promise<WalletSnapshot> {
    if (!this.provider || this.suspended) return this.state;
    const revision = this.state.revision;
    const [chain, accounts] = await Promise.all([this.provider.request({ method: "eth_chainId" }), this.provider.request({ method: "eth_accounts" })]);
    if (this.state.revision !== revision || this.suspended) return this.state;
    if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || !Array.isArray(accounts)) throw new Error("Wallet returned an invalid session.");
    const chainId = Number(BigInt(chain));
    if (!Number.isSafeInteger(chainId)) throw new Error("Wallet returned an invalid network.");
    if (!accounts.length) { if (this.state.kind !== "disconnected") this.disconnected(); return this.state; }
    const account = address(accounts[0]);
    if (this.state.kind !== "connected" || !sameAddress(this.state.account, account) || this.state.chainId !== chainId) this.publish({ kind: "connected", account, chainId, revision: revision + 1 });
    return this.state;
  }
  async connect(): Promise<WalletSnapshot> {
    const provider = this.requiredProvider(); this.suspended = false;
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(this.chainId) }] });
    await provider.request({ method: "eth_requestAccounts" });
    const snapshot = await this.refresh();
    if (snapshot.kind !== "connected" || snapshot.chainId !== this.chainId) throw new Error("Connect the requested test network to continue.");
    return snapshot;
  }
  disconnect() { this.suspended = true; this.disconnected(); }
  async assertCurrent(expected: Extract<WalletSnapshot, { kind: "connected" }>) {
    const current = await this.refresh();
    if (current.kind !== "connected" || current.revision !== expected.revision || current.chainId !== expected.chainId || current.chainId !== this.chainId || !sameAddress(current.account, expected.account)) throw new Error("Wallet or network changed. Review this action again.");
  }
  async requestTransaction(expected: Extract<WalletSnapshot, { kind: "connected" }>, transaction: Parameters<WalletSessionPort["requestTransaction"]>[1], beforeRequest?: () => Promise<void>) {
    await this.assertCurrent(expected);
    await beforeRequest?.();
    const result = await this.requiredProvider().request({ method: "eth_sendTransaction", params: [{ from: expected.account, to: transaction.to, data: transaction.data, value: toHex(transaction.value), chainId: toHex(expected.chainId), ...(transaction.nonce === undefined ? {} : { nonce: toHex(transaction.nonce) }) }] });
    return hash(result);
  }
  async signMessage({ message, expected }: Parameters<WalletSessionPort["signMessage"]>[0]) {
    await this.assertCurrent(expected);
    if (!message.startsWith("LABx ") || message.length > 24_000) throw new Error("Invalid LABx authorization message.");
    const result = await this.requiredProvider().request({ method: "personal_sign", params: [stringToHex(message), expected.account] });
    await this.assertCurrent(expected);
    if (typeof result !== "string" || !isHex(result, { strict: true }) || result.length > 16_386) throw new Error("Wallet returned an invalid signature.");
    return result;
  }
}
