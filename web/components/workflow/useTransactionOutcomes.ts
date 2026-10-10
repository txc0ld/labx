"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import { transactionIntent } from "@/lib/chain/pending-journal";
import { transactionOutcomes, type TransactionOutcome, type TransactionOutcomes } from "@/lib/chain/transaction-outcomes";
import { useWalletSnapshot } from "./WalletGate";

const EMPTY: readonly TransactionOutcome[] = [];
export function useTransactionOutcomes(service: RaffleService, wallet: WalletSessionPort) {
  const snapshot = useWalletSnapshot(wallet);
  const owner = transactionOutcomes(service);
  const account = snapshot.kind === "connected" && snapshot.chainId === service.manifest.chainId ? snapshot.account : null;
  const getSnapshot = useCallback(() => account ? owner.getSnapshot(account) : EMPTY, [owner, account]);
  const outcomes = useSyncExternalStore(owner.subscribe, getSnapshot, getSnapshot);
  useEffect(() => account ? owner.observe(account) : undefined, [owner, account]);
  return { owner, outcomes };
}

/**
 * "checking" while a saved hash is re-checked normally, "attention" once a person needs the manual form, and
 * "settled" once the journal no longer holds the hash, so the page reads the journal again.
 */
export type SavedHashCheck = "checking" | "attention" | "settled";
export type PageVisibility = { visible(): boolean; onVisible(listener: () => void): () => void };
type CheckService = Pick<RaffleService, "pending" | "inspectOutcome">;
type CheckOwner = Pick<TransactionOutcomes, "getSnapshot" | "resume">;

const FIRST_RETRY_MS = 2_000, MAX_RETRY_MS = 15_000;
export const SAVED_HASH_ATTENTION_MS = 180_000;
const documentVisibility: PageVisibility = {
  visible: () => document.visibilityState === "visible",
  onVisible(listener) {
    const changed = () => { if (document.visibilityState === "visible") listener(); };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }
};
function sameHash(left: Hex | null | undefined, right: Hex) {
  return left?.toLowerCase() === right.toLowerCase();
}
function ownCheckFailed(outcomes: readonly TransactionOutcome[], hash: Hex) {
  return outcomes.some(item => item.kind === "error" && sameHash(item.submitted?.hash, hash));
}

/**
 * Re-checks a transaction hash that the pending journal already holds, while the page is visible, with backoff.
 * It only reads: it never prepares, signs, sends, connects or switches networks. The journal is cleared only through
 * owner.resume, the same canonical path as the manual check, and only after a read-only inspection finds a successful
 * receipt for this exact hash with the required confirmations and the journal's own intent. A reverted receipt, a
 * different intent, an unknown hash, a failed confirmation in this tab, or a send still pending after three minutes
 * calls onAttention and leaves the decision to the person. onSettled reports that the journal no longer holds the hash.
 */
export function startSavedHashCheck({ owner, service, wallet, account, hash, onAttention, onSettled, visibility = documentVisibility, now = Date.now }: {
  owner: CheckOwner;
  service: CheckService;
  wallet: WalletSessionPort;
  account: Address;
  hash: Hex;
  onAttention(): void;
  onSettled(): void;
  visibility?: PageVisibility;
  now?: () => number;
}) {
  const started = now();
  let delay = FIRST_RETRY_MS, failures = 0, running = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attention = () => { if (!stopped) onAttention(); };
  async function tick() {
    timer = undefined;
    if (stopped || running || !visibility.visible()) return;
    running = true;
    try {
      const outcomes = owner.getSnapshot(account);
      if (ownCheckFailed(outcomes, hash)) { attention(); return; }
      // This tab is already confirming the hash.
      if (outcomes.some(item => item.kind === "checking" && sameHash(item.submitted.hash, hash))) return;
      const pending = await service.pending({ wallet });
      if (stopped) return;
      if (!pending || !sameHash(pending.hash, hash)) { onSettled(); return; }
      const inspection = await service.inspectOutcome({ hash, account, timeoutMs: 0 });
      if (stopped) return;
      if (inspection.kind === "pending") {
        failures = 0;
        if (now() - started >= SAVED_HASH_ATTENTION_MS) attention();
      } else if (inspection.kind === "unknown") {
        if (++failures >= 2) attention();
      } else if (inspection.kind === "confirmed" && sameHash(inspection.hash, hash) && inspection.receipt.to) {
        const expectedIntent = transactionIntent({ to: inspection.receipt.to, data: inspection.receipt.data, value: inspection.receipt.value });
        const journal = await service.pending({ wallet, expectedIntent }).catch(() => null);
        if (stopped) return;
        if (!journal || !sameHash(journal.hash, hash)) { attention(); return; }
        const result = await owner.resume(hash, wallet);
        if (result.kind !== "terminal" || result.confirmation.kind !== "confirmed") attention();
        else delay = 0;
      } else attention();
    } catch {
      if (++failures >= 2) attention();
    } finally {
      running = false;
      if (!stopped && !timer) {
        timer = setTimeout(() => void tick(), delay);
        delay = Math.min(Math.max(delay * 2, FIRST_RETRY_MS), MAX_RETRY_MS);
      }
    }
  }
  const stopListening = visibility.onVisible(() => {
    if (stopped || running) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    delay = FIRST_RETRY_MS;
    void tick();
  });
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stopListening();
  };
}

type CheckEntry = { status: SavedHashCheck; users: number; listeners: Set<() => void>; stop: (() => void) | null };
const savedHashChecks = new WeakMap<TransactionOutcomes, Map<string, CheckEntry>>();
function checkEntry(owner: TransactionOutcomes, key: string) {
  let entries = savedHashChecks.get(owner);
  if (!entries) { entries = new Map(); savedHashChecks.set(owner, entries); }
  let entry = entries.get(key);
  if (!entry) { entry = { status: "checking", users: 0, listeners: new Set(), stop: null }; entries.set(key, entry); }
  return entry;
}

/** Shares one automatic check per wallet session and saved hash across every component that shows it. */
export function useSavedHashCheck(service: RaffleService, wallet: WalletSessionPort, hash: Hex | null): SavedHashCheck | null {
  const snapshot = useWalletSnapshot(wallet);
  const owner = transactionOutcomes(service);
  const account = snapshot.kind === "connected" && snapshot.chainId === service.manifest.chainId ? snapshot.account : null;
  const key = account && hash ? `${account.toLowerCase()}:${snapshot.revision}:${hash.toLowerCase()}` : null;
  const entry = key ? checkEntry(owner, key) : null;
  const subscribe = useCallback((listener: () => void) => {
    entry?.listeners.add(listener);
    return () => { entry?.listeners.delete(listener); };
  }, [entry]);
  const getStatus = useCallback(() => entry?.status ?? null, [entry]);
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);
  useEffect(() => {
    if (!entry || !account || !hash) return;
    const publish = (status: SavedHashCheck) => {
      if (entry.status === status) return;
      entry.status = status;
      for (const listener of entry.listeners) listener();
    };
    if (entry.users++ === 0) entry.stop = startSavedHashCheck({ owner, service, wallet, account, hash, onAttention: () => publish("attention"), onSettled: () => publish("settled") });
    return () => {
      if (--entry.users > 0) return;
      entry.stop?.();
      entry.stop = null;
    };
  }, [entry, owner, service, wallet, account, hash]);
  if (!status || !account || !hash) return null;
  return status === "checking" && ownCheckFailed(owner.getSnapshot(account), hash) ? "attention" : status;
}
