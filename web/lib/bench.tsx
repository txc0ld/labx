"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Piece } from "./seed";
import { connectSepolia } from "./wallet";

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

export type Bench = State & {
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
    ready,
    clearBanner: () => setState((current) => ({ ...current, banner: undefined })),
    connect: async () => {
      try {
        const account = await connectSepolia();
        setState((current) => ({ ...current, wallet: account, banner: { tone: "ok", text: "Sepolia wallet connected." } }));
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
  }), [state, ready]);

  return <BenchContext.Provider value={api}>{children}</BenchContext.Provider>;
}

export function useBench(): Bench {
  const value = useContext(BenchContext);
  if (!value) throw new Error("Bench missing");
  return value;
}
