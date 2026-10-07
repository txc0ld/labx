"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import type { WalletSessionPort } from "@/lib/chain/ports";
import type { ConnectionStatus, WalletConnector } from "@/lib/chain/wallet-connectors";

const idle: ConnectionStatus = { kind: "idle" };
const fallbackOptions = [{ connector: "injected", label: "Browser wallet", unavailable: null }] as const;

export function WalletConnectionControls({ wallet }: { wallet: WalletSessionPort }) {
  const subscribe = useCallback((listener: () => void) => wallet.subscribe(listener), [wallet]);
  const getStatus = useCallback(() => wallet.getConnectionStatus?.() ?? idle, [wallet]);
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);
  const snapshot = useSyncExternalStore(subscribe, wallet.getSnapshot, wallet.getSnapshot);
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  async function connect(connector: WalletConnector) {
    setFallbackError(null);
    try { await wallet.connect(connector); }
    catch { if (!wallet.getConnectionStatus) setFallbackError("Wallet connection failed. Please retry."); }
  }
  const options = wallet.connectionOptions ?? fallbackOptions;
  const error = status.kind === "error" ? status.message : fallbackError;
  return (
    <div className="stack">
      <div className="btn-row">
        {snapshot.kind === "connected" ? <button className="btn btn-dark" type="button" onClick={() => wallet.disconnect()}>Disconnect wallet</button> : options.map(option => (
          <button className="btn" key={option.connector} type="button" disabled={Boolean(option.unavailable) || status.kind === "pending" && status.connector === option.connector} title={option.unavailable ?? undefined} onClick={() => void connect(option.connector)}>
            {status.kind === "pending" && status.connector === option.connector ? "Opening wallet…" : option.label}
          </button>
        ))}
        {status.kind === "pending" ? <button className="btn btn-dark" type="button" onClick={() => wallet.disconnect()}>Cancel connection</button> : null}
      </div>
      {status.kind === "pending" ? <p role="status">{status.connector === "walletconnect" ? "Choose a wallet or scan the QR code. Approve Ethereum Sepolia in your wallet." : "Approve the test-network connection in your browser wallet."}</p> : null}
      {snapshot.kind === "disconnected" ? options.filter(option => option.unavailable).map(option => <p className="muted" key={option.connector}>{option.unavailable}</p>) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </div>
  );
}
