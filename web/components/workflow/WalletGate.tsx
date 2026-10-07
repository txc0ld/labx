"use client";

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { WalletSessionPort } from "@/lib/chain/ports";
import { shortAddress } from "./format";
import { WalletConnectionControls } from "./WalletConnectionControls";

export function useWalletSnapshot(wallet: WalletSessionPort) {
  const subscribe = useCallback((listener: () => void) => wallet.subscribe(listener), [wallet]);
  const getSnapshot = useCallback(() => wallet.getSnapshot(), [wallet]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function WalletGate({ wallet, children }: { wallet: WalletSessionPort; children: ReactNode }) {
  const snapshot = useWalletSnapshot(wallet);

  if (snapshot.kind === "disconnected") {
    return (
      <div className="well pad stack workflow-gate">
        <div><h3>Connect your wallet</h3><p>LABx checks your account and network before showing available actions.</p></div>
        <WalletConnectionControls wallet={wallet} />
      </div>
    );
  }

  if (snapshot.chainId !== 11155111 && snapshot.chainId !== 31337) {
    return (
      <div className="notice warning stack" role="status">
        <strong>Wrong network</strong>
        <span>Switch to Ethereum Sepolia in your wallet, or disconnect and reconnect.</span>
        <WalletConnectionControls wallet={wallet} />
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
