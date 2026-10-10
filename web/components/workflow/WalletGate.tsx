"use client";

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { WalletSessionPort } from "@/lib/chain/ports";
import { shortAddress } from "./format";
import { WalletConnectionControls } from "./WalletConnectionControls";

export function useWalletSnapshot(wallet: WalletSessionPort) {
  const subscribe = useCallback((listener: () => void) => wallet.subscribe(listener), [wallet]);
  const getSnapshot = useCallback(() => wallet.getSnapshot(), [wallet]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** goal finishes "Connect your wallet to …", for example "buy". Seller pages default to managing raffles. */
export function WalletGate({ wallet, goal, children }: { wallet: WalletSessionPort; goal?: string; children: ReactNode }) {
  const snapshot = useWalletSnapshot(wallet);
  const path = usePathname();

  if (snapshot.kind === "disconnected") {
    const purpose = goal ?? (path?.startsWith("/seller") ? "manage your raffles" : "continue");
    return (
      <div className="well pad stack workflow-gate">
        <h3>Connect your wallet to {purpose}</h3>
        <WalletConnectionControls wallet={wallet} />
      </div>
    );
  }

  if (snapshot.chainId !== 11155111 && snapshot.chainId !== 31337) {
    return (
      <div className="notice warning stack" role="status">
        <strong>Wrong network</strong>
        <span>Switch your wallet to Ethereum Sepolia.</span>
        <WalletConnectionControls wallet={wallet} />
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="wallet-identity"><span>Connected</span><strong>{shortAddress(snapshot.account)}</strong></p>
      {children}
    </div>
  );
}
