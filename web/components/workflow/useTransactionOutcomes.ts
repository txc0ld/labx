"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import { transactionOutcomes, type TransactionOutcome } from "@/lib/chain/transaction-outcomes";
import { useWalletSnapshot } from "./WalletGate";

const EMPTY: readonly TransactionOutcome[] = [];
export function useTransactionOutcomes(service: RaffleService, wallet: WalletSessionPort) {
  const snapshot = useWalletSnapshot(wallet);
  const owner = transactionOutcomes(service);
  const account = snapshot.kind === "connected" && snapshot.chainId === service.manifest.chainId ? snapshot.account : null;
  const getSnapshot = useCallback(() => account ? owner.getSnapshot(account) : EMPTY, [owner, account]);
  const outcomes = useSyncExternalStore(owner.subscribe, getSnapshot, getSnapshot);
  useEffect(() => { if (account) owner.hydrate(account); }, [owner, account]);
  return { owner, outcomes };
}
