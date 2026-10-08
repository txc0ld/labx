"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WalletSessionPort } from "@/lib/chain/ports";
import type { ConnectionStatus, WalletConnector } from "@/lib/chain/wallet-connectors";

const idle: ConnectionStatus = { kind: "idle" };
const fallbackOptions = [{ connector: "appkit", label: "Connect wallet", unavailable: null }] as const;

export function WalletConnectionControls({ wallet }: { wallet: WalletSessionPort }) {
  const subscribe = useCallback((listener: () => void) => wallet.subscribe(listener), [wallet]);
  const getStatus = useCallback(() => wallet.getConnectionStatus?.() ?? idle, [wallet]);
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);
  const snapshot = useSyncExternalStore(subscribe, wallet.getSnapshot, wallet.getSnapshot);
  const controls = useRef<HTMLDivElement>(null);
  const initiator = useRef<HTMLButtonElement | null>(null);
  const initiatedStatus = useRef<ConnectionStatus | undefined>(undefined);
  const pendingOwner = useRef<object | null>(null);
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  useEffect(() => {
    if (status.kind === "pending") {
      if (initiatedStatus.current !== status) initiator.current = null;
      return;
    }
    if (!initiator.current) return;
    const trigger = initiator.current;
    const frame = requestAnimationFrame(() => {
      if (initiator.current !== trigger || wallet.getConnectionStatus?.().kind === "pending") return;
      initiator.current = null;
      const target = trigger.isConnected && !trigger.disabled ? trigger : controls.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [status, wallet]);
  useEffect(() => () => {
    const owner = pendingOwner.current;
    if (owner) wallet.cancelConnection?.(owner);
  }, [wallet]);
  async function connect(connector: WalletConnector, trigger: HTMLButtonElement) {
    const owner = {};
    pendingOwner.current = owner;
    initiator.current = trigger;
    setFallbackError(null);
    try {
      const connection = wallet.connect({ connector, owner });
      initiatedStatus.current = wallet.getConnectionStatus?.();
      await connection;
    }
    catch { if (!wallet.getConnectionStatus) setFallbackError("Wallet connection failed. Please retry."); }
    finally { if (pendingOwner.current === owner) pendingOwner.current = null; }
  }
  const options = wallet.connectionOptions ?? fallbackOptions;
  const error = status.kind === "error" ? status.message : fallbackError;
  return (
    <div className="stack" ref={controls}>
      <div className="btn-row">
        {snapshot.kind === "connected" ? <button className="btn btn-dark" type="button" onClick={() => wallet.disconnect()}>Disconnect wallet</button> : options.map(option => (
          <button className="btn" key={option.connector} type="button" disabled={Boolean(option.unavailable) || status.kind === "pending" && status.connector === option.connector} title={option.unavailable ?? undefined} onClick={event => void connect(option.connector, event.currentTarget)}>
            {status.kind === "pending" && status.connector === option.connector ? "Opening wallet…" : option.label}
          </button>
        ))}
        {status.kind === "pending" ? <button className="btn btn-dark" type="button" onClick={() => {
          const owner = pendingOwner.current;
          if (owner && wallet.cancelConnection) wallet.cancelConnection(owner);
          else wallet.disconnect();
        }}>Cancel connection</button> : null}
      </div>
      {status.kind === "pending" ? <p role="status">Choose an installed wallet or scan the QR code, then approve Ethereum Sepolia in that wallet.</p> : null}
      {snapshot.kind === "disconnected" ? options.filter(option => option.unavailable).map(option => <p className="muted" key={option.connector}>{option.unavailable}</p>) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </div>
  );
}
