"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Piece } from "./seed";
import { connectSepolia } from "./wallet";

export const LEGACY_BENCH_KEY = "labx-bench-v1";
export const PREFERENCE_KEY = "labx-preferences-v1";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
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

function readPreference(storage: BrowserStorage): string {
  try {
    const parsed = JSON.parse(storage.getItem(PREFERENCE_KEY) || "null") as { email?: unknown } | null;
    return validEmail(parsed?.email);
  } catch {
    return "";
  }
}

export function migrateBrowserPreference(storage: BrowserStorage): string {
  const current = readPreference(storage);
  let legacy = "";
  try {
    const parsed = JSON.parse(storage.getItem(LEGACY_BENCH_KEY) || "null") as { email?: unknown } | null;
    legacy = validEmail(parsed?.email);
  } catch {
    // Malformed or unavailable legacy data is discarded below when possible.
  }

  const email = current || legacy;
  if (!current && email) {
    try {
      storage.setItem(PREFERENCE_KEY, JSON.stringify({ email }));
    } catch {
      // A blocked preference write must not restore any legacy runtime records.
    }
  }
  try {
    storage.removeItem(LEGACY_BENCH_KEY);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  return email;
}

function initial(): State {
  return { pieces: [], wallet: "", email: "" };
}

export function BenchProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(initial);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let email = "";
    try {
      email = migrateBrowserPreference(window.localStorage);
    } catch {
      // Access to the storage object itself can be blocked by browser policy.
    }
    setState((current) => ({ ...current, email }));
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
