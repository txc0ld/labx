"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

export type NotificationActivity = {
  deployment: string;
  identity: string;
  blockNumber: string;
  logIndex: number;
};
export type NotificationReadWatermark =
  | { kind: "legacy"; identity: string }
  | { kind: "ordered"; activity: NotificationActivity };
const POLL_MS = 60_000;
const READ_EVENT = "labx-notifications-read";

export function NotificationsBell() {
  const [unread, setUnread] = useState(false);
  const latestRef = useRef<NotificationActivity | null>(null);
  const lastStartedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback((signal?: AbortSignal): Promise<void> => {
    if (document.visibilityState === "hidden") return Promise.resolve();
    if (inFlightRef.current) return inFlightRef.current;
    const now = Date.now();
    if (now - lastStartedAtRef.current < POLL_MS) return Promise.resolve();
    lastStartedAtRef.current = now;
    const request = (async () => {
      try {
        const response = await fetch("/api/notifications?limit=1", { signal, headers: { Accept: "application/json" } });
        const body: unknown = await response.json();
        if (!response.ok || !body || typeof body !== "object") return;
        const deployment = Reflect.get(body, "deployment");
        const items = Reflect.get(body, "items");
        if (typeof deployment !== "string" || !Array.isArray(items) || items.length === 0) {
          latestRef.current = null;
          setUnread(false);
          return;
        }
        const item = items[0];
        if (!item || typeof item !== "object") return;
        const blockHash = Reflect.get(item, "blockHash");
        const transactionHash = Reflect.get(item, "transactionHash");
        const blockNumber = Reflect.get(item, "blockNumber");
        const logIndex = Reflect.get(item, "logIndex");
        if (typeof blockHash !== "string" || typeof transactionHash !== "string" || !isBlockNumber(blockNumber) || !isLogIndex(logIndex)) return;
        const activity = { deployment, identity: `${blockHash}:${transactionHash}:${logIndex}`, blockNumber, logIndex };
        const latest = selectLatestActivity(latestRef.current, activity);
        latestRef.current = latest;
        setUnread(isNotificationUnread(latest, readWatermark(latest.deployment)));
      } catch {
        // The bell remains usable as a link when the public feed is unavailable.
      }
    })();
    inFlightRef.current = request;
    void request.finally(() => {
      if (inFlightRef.current === request) inFlightRef.current = null;
    });
    return request;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => void refresh(controller.signal), POLL_MS);
    const onVisibility = () => void refresh(controller.signal);
    const onRead = (event: Event) => {
      const read = parseReadActivity(event);
      if (!read) return;
      const latest = latestRef.current;
      const reconciled = reconcileNotificationRead(latest, readWatermark(read.deployment), read);
      if (!reconciled) return;
      latestRef.current = reconciled.latest;
      writeWatermark(reconciled.watermark);
      setUnread(reconciled.unread);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(READ_EVENT, onRead);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(READ_EVENT, onRead);
    };
  }, [refresh]);

  function markVisibleActivityRead() {
    const latest = latestRef.current;
    if (!latest) return;
    try {
      const watermark = advanceWatermark(readWatermark(latest.deployment), latest, true);
      writeWatermark(watermark);
      setUnread(isNotificationUnread(latest, watermark));
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

export function markNotificationRead(activity: NotificationActivity): void {
  try {
    writeWatermark(advanceWatermark(readWatermark(activity.deployment), activity, false));
    window.dispatchEvent(new CustomEvent(READ_EVENT, { detail: activity }));
  } catch {
    // Device-local unread state is optional.
  }
}

export function selectLatestActivity(
  current: NotificationActivity | null,
  candidate: NotificationActivity
): NotificationActivity {
  if (!current || current.deployment !== candidate.deployment) return candidate;
  return compareActivity(candidate, current) >= 0 ? candidate : current;
}

export function reconcileNotificationRead(
  latest: NotificationActivity | null,
  stored: NotificationReadWatermark | null,
  read: NotificationActivity
): { latest: NotificationActivity; watermark: NotificationReadWatermark; unread: boolean } | null {
  if (!latest) {
    const watermark = advanceWatermark(stored, read, true);
    return { latest: read, watermark, unread: isNotificationUnread(read, watermark) };
  }
  if (latest.deployment !== read.deployment) return null;
  const nextLatest = selectLatestActivity(latest, read);
  let watermark = advanceWatermark(stored, read, compareActivity(read, latest) >= 0);
  if (watermark.kind === "legacy" && watermark.identity === nextLatest.identity) {
    watermark = { kind: "ordered", activity: nextLatest };
  }
  return { latest: nextLatest, watermark, unread: isNotificationUnread(nextLatest, watermark) };
}

export function advanceWatermark(
  current: NotificationReadWatermark | null,
  candidate: NotificationActivity,
  replaceUnknownLegacy: boolean
): NotificationReadWatermark {
  if (!current) return { kind: "ordered", activity: candidate };
  if (current.kind === "legacy") {
    return current.identity === candidate.identity || replaceUnknownLegacy
      ? { kind: "ordered", activity: candidate }
      : current;
  }
  if (current.activity.deployment !== candidate.deployment) return current;
  return compareActivity(candidate, current.activity) >= 0
    ? { kind: "ordered", activity: candidate }
    : current;
}

export function isNotificationUnread(
  latest: NotificationActivity,
  watermark: NotificationReadWatermark | null
): boolean {
  if (!watermark) return true;
  if (watermark.kind === "legacy") return watermark.identity !== latest.identity;
  if (watermark.activity.deployment !== latest.deployment) return true;
  const order = compareActivity(latest, watermark.activity);
  return order > 0 || order === 0 && latest.identity !== watermark.activity.identity;
}

function compareActivity(left: NotificationActivity, right: NotificationActivity): number {
  const leftBlock = BigInt(left.blockNumber);
  const rightBlock = BigInt(right.blockNumber);
  if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
  return left.logIndex - right.logIndex;
}

function parseReadActivity(event: Event): NotificationActivity | null {
  const value = Reflect.get(event, "detail");
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deployment = Reflect.get(value, "deployment");
  const identity = Reflect.get(value, "identity");
  const blockNumber = Reflect.get(value, "blockNumber");
  const logIndex = Reflect.get(value, "logIndex");
  return typeof deployment === "string" && typeof identity === "string" && isBlockNumber(blockNumber) && isLogIndex(logIndex)
    ? { deployment, identity, blockNumber, logIndex }
    : null;
}

function isBlockNumber(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value);
}

function isLogIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function storageKey(deployment: string): string {
  return `labx:notifications:read:${deployment}`;
}

function readWatermark(deployment: string): NotificationReadWatermark | null {
  let raw: string | null;
  try { raw = localStorage.getItem(storageKey(deployment)); } catch { return null; }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.get(value, "version") !== 1) {
      return { kind: "legacy", identity: raw };
    }
    const activity = parseActivity(value);
    return activity?.deployment === deployment ? { kind: "ordered", activity } : null;
  } catch {
    return { kind: "legacy", identity: raw };
  }
}

function writeWatermark(watermark: NotificationReadWatermark): void {
  if (watermark.kind === "legacy") return;
  const { deployment, identity, blockNumber, logIndex } = watermark.activity;
  localStorage.setItem(storageKey(deployment), JSON.stringify({ version: 1, deployment, identity, blockNumber, logIndex }));
}

function parseActivity(value: object): NotificationActivity | null {
  const deployment = Reflect.get(value, "deployment");
  const identity = Reflect.get(value, "identity");
  const blockNumber = Reflect.get(value, "blockNumber");
  const logIndex = Reflect.get(value, "logIndex");
  return typeof deployment === "string" && typeof identity === "string" && isBlockNumber(blockNumber) && isLogIndex(logIndex)
    ? { deployment, identity, blockNumber, logIndex }
    : null;
}
