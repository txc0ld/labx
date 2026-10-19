"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { OutcomeJournal, PendingSettlement } from "@/lib/chain/types";
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
type CheckOwner = Pick<TransactionOutcomes, "getSnapshot" | "resume" | "settlePending">;

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
 * receipt for this exact hash with the required confirmations and the journal's own intent. A hash the chain no longer
 * knows was replaced or dropped, so owner.settlePending decides that record from the account's nonces and clears only
 * that record and the hash's own unfinished outcomes. A reverted receipt, a different intent, an unknown hash the nonces
 * cannot settle, a failed confirmation in this tab, or a send still pending after three minutes calls onAttention and
 * leaves the decision to the person.
 * onSettled reports that the journal no longer holds the hash.
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
        const settled = await owner.settlePending({ wallet, expected: pending });
        if (stopped) return;
        if (settled.kind === "spent" || settled.kind === "dropped") { onSettled(); return; }
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

/**
 * For a pending record without a hash: "checking" until the first chain read, then "waiting" (something is pending that
 * may be the send) or "unsent" (nothing is at its nonce), and "unknown" after two failed reads in a row. "spent" and
 * "settled" are final: the record was cleared, after a send at its nonce was mined for "spent", or it changed.
 */
export type PendingSendStatus = "checking" | "waiting" | "unsent" | "unknown" | "spent" | "settled";
export const PENDING_SEND_POLL_MS = 4_000;

/**
 * Settles a pending record without a hash from the chain: once now, then while the page is visible. It only reads and
 * clears that exact record through service.settlePending; it never prepares, signs, sends, connects or switches networks.
 * continueUnsent is the person's Continue: it also clears the record when nothing is at its nonce.
 */
export function startPendingSendCheck({ service, wallet, expected, onStatus, visibility = documentVisibility, intervalMs = PENDING_SEND_POLL_MS }: {
  service: Pick<RaffleService, "settlePending">;
  wallet: WalletSessionPort;
  expected: OutcomeJournal;
  onStatus(status: PendingSendStatus): void;
  visibility?: PageVisibility;
  intervalMs?: number;
}) {
  let running: Promise<void> | null = null, stopped = false, failures = 0, last: PendingSendStatus | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = (status: PendingSendStatus) => { if (status !== last) { last = status; onStatus(status); } };
  function apply(result: PendingSettlement) {
    failures = 0;
    if (result.kind === "waiting" || result.kind === "unsent") { report(result.kind); return; }
    stopped = true;
    if (timer) clearTimeout(timer);
    report(result.kind === "spent" ? "spent" : "settled");
  }
  function read(continueUnsent: boolean) {
    const work = (async () => {
      try {
        const result = await service.settlePending({ wallet, expected, continueUnsent });
        if (!stopped) apply(result);
      } catch {
        if (!stopped && ++failures >= 2) report("unknown");
      }
    })();
    running = work;
    void work.finally(() => { if (running === work) running = null; });
    return work;
  }
  async function tick(always = false) {
    timer = undefined;
    if (stopped || running) return;
    if (!always && !visibility.visible()) return;
    await read(false);
    if (!stopped && !timer && visibility.visible()) timer = setTimeout(() => void tick(), intervalMs);
  }
  const stopListening = visibility.onVisible(() => { if (!stopped && !running && !timer) void tick(); });
  void tick(true);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopListening();
    },
    async continueUnsent() {
      while (running) await running;
      if (!stopped) await read(true);
    }
  };
}

// panels counts the visible TransactionFlow panels that show this record, so a page-level ResumeTransaction can hide its copy.
type SendEntry = { status: PendingSendStatus; users: number; panels: number; listeners: Set<() => void>; check: ReturnType<typeof startPendingSendCheck> | null };
const pendingSendChecks = new WeakMap<TransactionOutcomes, Map<string, SendEntry>>();
function sendEntry(owner: TransactionOutcomes, key: string) {
  let entries = pendingSendChecks.get(owner);
  if (!entries) { entries = new Map(); pendingSendChecks.set(owner, entries); }
  let entry = entries.get(key);
  if (!entry) { entry = { status: "checking", users: 0, panels: 0, listeners: new Set(), check: null }; entries.set(key, entry); }
  return entry;
}
function notifySend(entry: SendEntry) { for (const listener of entry.listeners) listener(); }

/**
 * Shares one chain check per wallet session and pending record without a hash across every component that shows it.
 * showPanel(element) marks a rendered panel as shown while the element is visible on the page, and returns its cleanup;
 * panelShown is whether any such panel is shown, so the page shows one panel for the record.
 */
export function usePendingSend(service: RaffleService, wallet: WalletSessionPort, pending: Pick<OutcomeJournal, "id" | "hash" | "nonce"> | null) {
  const snapshot = useWalletSnapshot(wallet);
  const owner = transactionOutcomes(service);
  const account = snapshot.kind === "connected" && snapshot.chainId === service.manifest.chainId ? snapshot.account : null;
  const id = pending && pending.hash === null ? pending.id : null, nonce = pending?.nonce ?? null;
  const key = account && id !== null ? `${account.toLowerCase()}:${snapshot.revision}:${id}:${nonce}` : null;
  const entry = key ? sendEntry(owner, key) : null;
  const subscribe = useCallback((listener: () => void) => {
    entry?.listeners.add(listener);
    return () => { entry?.listeners.delete(listener); };
  }, [entry]);
  const getStatus = useCallback(() => entry?.status ?? null, [entry]);
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);
  const getPanelShown = useCallback(() => (entry?.panels ?? 0) > 0, [entry]);
  const panelShown = useSyncExternalStore(subscribe, getPanelShown, getPanelShown);
  useEffect(() => {
    if (!entry || !account || id === null || nonce === null) return;
    const publish = (next: PendingSendStatus) => {
      if (entry.status === next) return;
      entry.status = next;
      notifySend(entry);
    };
    if (entry.users++ === 0) entry.check = startPendingSendCheck({ service, wallet, expected: { id, hash: null, nonce }, onStatus: publish });
    return () => {
      if (--entry.users > 0) return;
      entry.check?.stop();
      entry.check = null;
    };
  }, [entry, service, wallet, account, id, nonce]);
  const continueUnsent = useCallback(() => entry?.check?.continueUnsent() ?? Promise.resolve(), [entry]);
  const showPanel = useCallback((element: Element | null) => {
    // A panel inside a closed disclosure has no layout box, so it does not count as shown.
    if (!entry || !element || element.getClientRects().length === 0) return undefined;
    entry.panels += 1;
    notifySend(entry);
    return () => { entry.panels -= 1; notifySend(entry); };
  }, [entry]);
  return { status, continueUnsent, panelShown, showPanel };
}
