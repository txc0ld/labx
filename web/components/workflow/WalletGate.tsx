"use client";

import { useCallback, useRef, useSyncExternalStore, useState, type ReactNode } from "react";
import type { WalletSessionPort } from "@/lib/chain/ports";
import { shortAddress } from "./format";

export function useWalletSnapshot(wallet: WalletSessionPort) {
  const subscribe = useCallback((listener: () => void) => wallet.subscribe(listener), [wallet]);
  const getSnapshot = useCallback(() => wallet.getSnapshot(), [wallet]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function WalletGate({ wallet, children }: { wallet: WalletSessionPort; children: ReactNode }) {
  const snapshot = useWalletSnapshot(wallet);
  const [message, setMessage] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const connectInFlight = useRef(false);

  async function connect() {
    if (connectInFlight.current) return;
    connectInFlight.current = true;
    setConnecting(true);
    setMessage(null);
    try {
      const next = await wallet.connect();
      if (next.kind !== "connected") setMessage("Connect a wallet to continue.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Wallet connection failed.");
    } finally {
      connectInFlight.current = false;
      setConnecting(false);
    }
  }

  if (snapshot.kind === "disconnected") {
    return (
      <div className="well pad stack workflow-gate">
        <div><h3>Connect your wallet</h3><p>LABx checks your account and network before showing available actions.</p></div>
        <button className="btn" type="button" disabled={connecting} onClick={() => void connect()}>{connecting ? "Opening wallet…" : "Connect wallet"}</button>
        {message ? <p className="notice error" role="alert">{message}</p> : null}
      </div>
    );
  }

  if (snapshot.chainId !== 11155111 && snapshot.chainId !== 31337) {
    return (
      <div className="notice warning stack" role="status">
        <strong>Wrong network</strong>
        <span>Switch to Ethereum Sepolia, then refresh the wallet connection.</span>
        <button className="btn btn-dark" type="button" onClick={() => void wallet.refresh()}>Refresh network</button>
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="wallet-identity"><span>Connected</span><strong>{shortAddress(snapshot.account)}</strong><span>Chain {snapshot.chainId}</span></p>
      {children}
    </div>
  );
}
