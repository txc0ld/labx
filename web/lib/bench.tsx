"use client";

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Piece } from "./seed";
import { WalletSession } from "./chain/wallet-session";
import { configuredBrowserService } from "./chain/browser";
import type { BrowserService } from "./chain/ports";
import type { BlockRef, RaffleSnapshot, WalletSnapshot } from "./chain/types";

export const LEGACY_BENCH_KEY = "labx-bench-v1";
export const PREFERENCE_KEY = "labx-preferences-v1";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type StoredEmail = { kind: "read"; email: string } | { kind: "unavailable" };
export type PreferenceMigration =
  | { kind: "complete"; email: string }
  | { kind: "cleanup-pending"; email: string }
  | { kind: "storage-unavailable"; email: "" };
type State = {
  pieces: Piece[];
  wallet: string;
  email: string;
  banner?: { tone: "warning" | "error" | "ok"; text: string };
};

const BenchContext = createContext<Bench | null>(null);

export type CatalogState =
  | { kind: "loading" }
  | { kind: "unavailable" | "error"; reason: string }
  | { kind: "ready"; items: readonly RaffleSnapshot[]; nextCursor: bigint | null; block: BlockRef };

export type Bench = State & {
  browser: BrowserService;
  walletSession: WalletSnapshot;
  catalog: CatalogState;
  refreshCatalog: () => Promise<void>;
  loadMoreCatalog: () => Promise<void>;
  disconnect: () => void;
  ready: boolean;
  connect: () => Promise<void>;
  saveEmail: (email: string) => string;
  clearBanner: () => void;
};

function validEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function emailFromJson(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("email" in parsed)) return "";
    return validEmail(parsed.email);
  } catch {
    return "";
  }
}

function readStoredEmail(storage: BrowserStorage, key: string): StoredEmail {
  try {
    return { kind: "read", email: emailFromJson(storage.getItem(key)) };
  } catch {
    return { kind: "unavailable" };
  }
}

function removeLegacy(storage: BrowserStorage, email: string): PreferenceMigration {
  try {
    storage.removeItem(LEGACY_BENCH_KEY);
    return { kind: "complete", email };
  } catch {
    return email ? { kind: "cleanup-pending", email } : { kind: "storage-unavailable", email: "" };
  }
}

export function migrateBrowserPreference(storage: BrowserStorage): PreferenceMigration {
  const current = readStoredEmail(storage, PREFERENCE_KEY);
  const legacy = readStoredEmail(storage, LEGACY_BENCH_KEY);

  if (current.kind === "unavailable") {
    return legacy.kind === "read" && legacy.email
      ? { kind: "cleanup-pending", email: legacy.email }
      : { kind: "storage-unavailable", email: "" };
  }
  if (current.email) return removeLegacy(storage, current.email);
  if (legacy.kind === "unavailable") return { kind: "storage-unavailable", email: "" };
  if (legacy.email) {
    try {
      storage.setItem(PREFERENCE_KEY, JSON.stringify({ email: legacy.email }));
    } catch {
      return { kind: "cleanup-pending", email: legacy.email };
    }
    return removeLegacy(storage, legacy.email);
  }
  return removeLegacy(storage, "");
}

function initial(): State {
  return { pieces: [], wallet: "", email: "" };
}

export function BenchProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(initial);
  const [ready, setReady] = useState(false);
  const [browser, setBrowser] = useState<BrowserService>(() => ({ kind: "unavailable", reason: "Loading deployment configuration.", wallet: new WalletSession(undefined) }));
  const [walletSession, setWalletSession] = useState<WalletSnapshot>({ kind: "disconnected", revision: 0 });
  const [catalog, setCatalog] = useState<CatalogState>({ kind: "loading" });
  const generation = useRef(0);
  const loadingPage = useRef(false);
  const refreshCatalog = useCallback(async () => {
    const request = ++generation.current;
    if (browser.kind !== "configured") { setCatalog({ kind: "unavailable", reason: browser.reason }); return; }
    setCatalog({ kind: "loading" });
    try {
      const page = await browser.service.listRaffles();
      if (request === generation.current) setCatalog({ kind: "ready", ...page });
    } catch { if (request === generation.current) setCatalog({ kind: "error", reason: "Raffle data could not be loaded. Please retry." }); }
  }, [browser]);
  const loadMoreCatalog = useCallback(async () => {
    if (browser.kind !== "configured" || catalog.kind !== "ready" || catalog.nextCursor === null || loadingPage.current) return;
    loadingPage.current = true; const request = generation.current;
    try {
      const page = await browser.service.listRaffles({ cursor: catalog.nextCursor, block: catalog.block });
      if (request === generation.current) setCatalog({ kind: "ready", ...page, items: [...catalog.items, ...page.items] });
    } catch { if (request === generation.current) setState(current => ({ ...current, banner: { tone: "error", text: "More raffles could not be loaded. Refresh and retry." } })); }
    finally { loadingPage.current = false; }
  }, [browser, catalog]);
  useEffect(() => { setBrowser(configuredBrowserService()); }, []);
  useEffect(() => {
    const update = () => { const session = browser.wallet.getSnapshot(); setWalletSession(session); setState(current => ({ ...current, wallet: session.kind === "connected" ? session.account : "" })); };
    update(); const unsubscribe = browser.wallet.subscribe(update);
    void browser.wallet.refresh().catch(() => {});
    return unsubscribe;
  }, [browser]);
  useEffect(() => { void refreshCatalog(); return () => { generation.current++; }; }, [refreshCatalog]);

  useEffect(() => {
    let migration: PreferenceMigration = { kind: "storage-unavailable", email: "" };
    try {
      migration = migrateBrowserPreference(window.localStorage);
    } catch {
      // Access to the storage object itself can be blocked by browser policy.
    }
    const banner: State["banner"] = migration.kind === "cleanup-pending"
      ? { tone: "warning", text: "Email restored. Old browser data cleanup will retry next time." }
      : migration.kind === "storage-unavailable"
        ? { tone: "error", text: "Browser storage is unavailable. Email preferences may not persist." }
        : undefined;
    setState((current) => ({ ...current, email: migration.email, banner }));
    setReady(true);
  }, []);

  const api = useMemo<Bench>(() => ({
    ...state,
    browser, walletSession, catalog, refreshCatalog, loadMoreCatalog,
    disconnect: () => browser.wallet.disconnect(),
    ready,
    clearBanner: () => setState((current) => ({ ...current, banner: undefined })),
    connect: async () => {
      try {
        const session = await browser.wallet.connect();
        if (session.kind !== "connected") throw new Error("Wallet connection failed.");
        setState((current) => ({ ...current, wallet: session.account, banner: { tone: "ok", text: "Test-network wallet connected." } }));
      } catch (error) {
        const text = error instanceof Error ? error.message : "Wallet connection failed.";
        setState((current) => ({ ...current, banner: { tone: "error", text } }));
      }
    },
    saveEmail: (value) => {
      const email = validEmail(value);
      if (!email) return "Enter a valid email address.";
      try {
        localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ email }));
      } catch {
        return "Email preference could not be saved in this browser. Please retry.";
      }
      setState((current) => ({ ...current, email }));
      try {
        localStorage.removeItem(LEGACY_BENCH_KEY);
      } catch {
        return "Email preference saved. Old browser data cleanup will retry next time.";
      }
      return "Email preference saved in this browser.";
    }
  }), [state, ready, browser, walletSession, catalog, refreshCatalog, loadMoreCatalog]);

  return <BenchContext.Provider value={api}>{children}</BenchContext.Provider>;
}

export function useBench(): Bench {
  const value = useContext(BenchContext);
  if (!value) throw new Error("Bench missing");
  return value;
}
