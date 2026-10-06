import { describe, expect, it } from "vitest";
import { WalletSession } from "../lib/chain/wallet-session";
import type { WalletProvider } from "../lib/chain/types";
const account = "0x1111111111111111111111111111111111111111";
function fixture() {
  let chain = "0xaa36a7", accounts = [account]; const calls: string[] = [], listeners = new Map<string, (...args: unknown[]) => void>();
  const provider: WalletProvider = { async request({ method }) { calls.push(method); if (method === "eth_chainId") return chain; if (method === "eth_accounts" || method === "eth_requestAccounts") return accounts; if (method === "wallet_switchEthereumChain") return null; throw new Error("Unexpected signing request"); }, on(event, fn) { listeners.set(event, fn); }, removeListener(event) { listeners.delete(event); } };
  const wallet = new WalletSession(provider);
  return { wallet, calls, listeners, setChain(value: string) { chain = value; }, setAccounts(value: string[]) { accounts = value; } };
}
describe("wallet session revision boundary", () => {
  it("refreshes without requesting authorization or signatures and invalidates old reviews on account events", async () => {
    const f = fixture(); const original = await f.wallet.refresh(); if (original.kind !== "connected") throw new Error("Missing session");
    expect(f.calls).toEqual(["eth_chainId", "eth_accounts"]);
    f.listeners.get("accountsChanged")?.([account]);
    expect(f.wallet.getSnapshot().revision).toBeGreaterThan(original.revision);
    await expect(f.wallet.assertCurrent(original)).rejects.toThrow(/changed/);
    expect(f.calls).not.toContain("eth_sendTransaction"); expect(f.calls).not.toContain("personal_sign");
  });
  it("catches silent provider account/network drift and respects local disconnect", async () => {
    const f = fixture(); const original = await f.wallet.connect(); if (original.kind !== "connected") throw new Error("Missing session");
    f.setChain("0x1"); await expect(f.wallet.assertCurrent(original)).rejects.toThrow(/changed/);
    f.wallet.disconnect(); expect((await f.wallet.refresh()).kind).toBe("disconnected");
    f.wallet.dispose(); expect(f.listeners.size).toBe(0);
  });
  it("does not reconnect a disconnected wallet through passive refresh", async () => {
    const f = fixture(); await f.wallet.connect(); f.wallet.disconnect();
    f.listeners.get("accountsChanged")?.([account]); expect((await f.wallet.refresh()).kind).toBe("disconnected");
    f.setAccounts([]); await expect(f.wallet.connect()).rejects.toThrow(/Connect/);
  });
  it.each(["account", "chain", "disconnect"])("does not invoke the provider if %s changes while journal acquisition waits", async (kind) => {
    const f = fixture(); const expected = await f.wallet.connect(); if (expected.kind !== "connected") throw new Error("Missing session");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let providerInvoked = false;
    const sending = f.wallet.requestTransaction(expected, { to: account, data: "0x", value: 0n }, async () => { entered(); await gate; }, () => { providerInvoked = true; });
    const rejected = expect(sending).rejects.toThrow(/changed/);
    await started;
    if (kind === "account") f.setAccounts(["0x2222222222222222222222222222222222222222"]);
    else if (kind === "chain") f.setChain("0x1");
    else f.wallet.disconnect();
    release(); await rejected;
    expect(providerInvoked).toBe(false); expect(f.calls).not.toContain("eth_sendTransaction");
  });

});
