import { describe, expect, it } from "vitest";
import { WalletSession } from "../lib/chain/wallet-session";
import type { WalletProvider } from "../lib/chain/types";

const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const transactionHash = `0x${"ab".repeat(32)}`;

describe("independent wallet invocation boundary", () => {
  it.each([
    { name: "account", change: (state: State) => { state.account = buyer; state.emit("accountsChanged", [buyer]); } },
    { name: "chain", change: (state: State) => { state.chain = "0x1"; state.emit("chainChanged", "0x1"); } },
    { name: "connection", change: (state: State) => { state.emit("disconnect", { code: 4900 }); } }
  ])("does not invoke the provider after $name drift during the awaited journal callback", async ({ change }) => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const sent: (readonly unknown[])[] = [];
    const state: State = {
      account: seller,
      chain: "0x7a69",
      emit(event, value) { for (const listener of listeners.get(event) ?? []) listener(value); }
    };
    const provider: WalletProvider = {
      async request({ method, params }) {
        if (method === "eth_chainId") return state.chain;
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [state.account];
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_sendTransaction") { sent.push(params ?? []); return transactionHash; }
        throw new Error(`Unexpected method ${method}`);
      },
      on(event, listener) { const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); },
      removeListener(event, listener) { listeners.get(event)?.delete(listener); }
    };
    const wallet = new WalletSession(provider, 31337);
    const snapshot = await wallet.connect();
    if (snapshot.kind !== "connected") throw new Error("Fixture wallet did not connect.");
    let unlock: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    let providerInvoked = false;
    const request = wallet.requestTransaction(
      snapshot,
      { to: target, data: "0x", value: 0n },
      async () => { entered?.(); await gate; },
      () => { providerInvoked = true; }
    );
    await inside;
    change(state);
    unlock?.();
    await expect(request).rejects.toThrow(/changed/);
    expect(providerInvoked).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

type State = {
  account: string;
  chain: string;
  emit(event: string, value: unknown): void;
};
