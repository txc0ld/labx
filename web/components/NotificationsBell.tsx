"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type LatestActivity = { deployment: string; identity: string };
const POLL_MS = 60_000;

export function NotificationsBell() {
  const [latest, setLatest] = useState<LatestActivity | null>(null);
  const [unread, setUnread] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (document.visibilityState === "hidden") return;
    try {
      const response = await fetch("/api/notifications?limit=1", { signal, headers: { Accept: "application/json" } });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object") return;
      const deployment = Reflect.get(body, "deployment");
      const items = Reflect.get(body, "items");
      if (typeof deployment !== "string" || !Array.isArray(items) || items.length === 0) {
        setUnread(false);
        return;
      }
      const item = items[0];
      if (!item || typeof item !== "object") return;
      const blockHash = Reflect.get(item, "blockHash");
      const transactionHash = Reflect.get(item, "transactionHash");
      const logIndex = Reflect.get(item, "logIndex");
      if (typeof blockHash !== "string" || typeof transactionHash !== "string" || !Number.isSafeInteger(logIndex)) return;
      const activity = { deployment, identity: `${blockHash}:${transactionHash}:${logIndex}` };
      setLatest(activity);
      setUnread(readLastSeen(deployment) !== activity.identity);
    } catch {
      // The bell remains usable as a link when the public feed is unavailable.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => void refresh(controller.signal), POLL_MS);
    const onVisibility = () => void refresh(controller.signal);
    const onRead = () => void refresh(controller.signal);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("labx-notifications-read", onRead);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("labx-notifications-read", onRead);
    };
  }, [refresh]);

  function markVisibleActivityRead() {
    if (!latest) return;
    try {
      localStorage.setItem(storageKey(latest.deployment), latest.identity);
      setUnread(false);
    } catch {
      // Storage is optional; navigation still succeeds.
    }
  }

  return (
    <Link
      className="notification-bell"
      href="/notifications"
      aria-label={unread ? "Notifications, unread raffle activity" : "Notifications"}
      title="Notifications"
      onClick={markVisibleActivityRead}
    >
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </svg>
      {unread ? <span className="notification-dot" aria-hidden="true" /> : null}
    </Link>
  );
}

export function markNotificationRead(deployment: string, identity: string): void {
  try {
    localStorage.setItem(storageKey(deployment), identity);
    window.dispatchEvent(new Event("labx-notifications-read"));
  } catch {
    // Device-local unread state is optional.
  }
}

function storageKey(deployment: string): string {
  return `labx:notifications:read:${deployment}`;
}

function readLastSeen(deployment: string): string | null {
  try { return localStorage.getItem(storageKey(deployment)); } catch { return null; }
}
