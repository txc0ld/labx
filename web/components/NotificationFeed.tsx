"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { markNotificationRead } from "./NotificationsBell";

type FeedItem = {
  kind: "draft-created" | "sales-opened";
  label: "Draft awaiting review" | "Raffle live";
  raffleId: string;
  occurredAt: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  href: string;
};
type FeedPage = { deployment: string; items: FeedItem[]; nextCursor: string | null; fresh: boolean };

export function NotificationFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [deployment, setDeployment] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const flowRef = useRef({ generation: 0, initial: false, refreshing: false, moreToken: 0 });
  const requestIdRef = useRef(0);
  const moreControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (cursor?: string, background = false) => {
    const flow = flowRef.current;
    let generation = flow.generation;
    let token = 0;
    let controller: AbortController | null = null;
    if (cursor) {
      if (flow.initial || flow.refreshing || flow.moreToken !== 0) return;
      token = ++requestIdRef.current;
      flow.moreToken = token;
      controller = new AbortController();
      moreControllerRef.current = controller;
      setLoadingMore(true);
      setMoreError(false);
    } else if (background) {
      if (flow.initial || flow.refreshing) return;
      generation = ++flow.generation;
      flow.refreshing = true;
      flow.moreToken = 0;
      moreControllerRef.current?.abort();
      moreControllerRef.current = null;
      setLoadingMore(false);
      setMoreError(false);
      setRefreshing(true);
      setRefreshError(false);
    } else {
      if (flow.initial || flow.refreshing) return;
      flow.initial = true;
      setState("loading");
    }
    try {
      const query = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : "?limit=20";
      const response = await fetch(`/api/notifications${query}`, { signal: controller?.signal, headers: { Accept: "application/json" } });
      const page = parseFeedPage(await response.json());
      if (!response.ok) throw new Error();
      if (generation !== flow.generation || cursor && token !== flow.moreToken) return;
      setItems(current => cursor ? mergeItems(current, page.items) : page.items);
      setDeployment(page.deployment);
      setNextCursor(page.nextCursor);
      setState("ready");
    } catch {
      if (generation !== flow.generation || cursor && token !== flow.moreToken) return;
      if (cursor) setMoreError(true);
      else if (background) setRefreshError(true);
      else setState("error");
    } finally {
      if (cursor && token === flow.moreToken) {
        flow.moreToken = 0;
        moreControllerRef.current = null;
        setLoadingMore(false);
      } else if (background && generation === flow.generation) {
        flow.refreshing = false;
        setRefreshing(false);
      } else if (!cursor && !background && generation === flow.generation) {
        flow.initial = false;
      }
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state === "loading") return <p className="notification-status" role="status">Loading finalized raffle activity...</p>;
  if (state === "error") {
    return (
      <div className="notification-status" role="alert">
        <p>Finalized raffle activity is unavailable right now.</p>
        <button className="btn btn-dark" type="button" onClick={() => void load()}>Retry</button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="notification-status">
        <p>{nextCursor ? "No draft or sales events appear in this finalized range." : "No finalized draft or sales activity has been recorded for this deployment."}</p>
        <div className="btn-row">
          <button className="btn" type="button" disabled={refreshing} onClick={() => void load(undefined, true)}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          {nextCursor ? (
            <button className="btn btn-dark" type="button" disabled={loadingMore || refreshing} onClick={() => void load(nextCursor)}>
              {loadingMore ? "Loading..." : moreError ? "Retry older activity" : "Check older activity"}
            </button>
          ) : null}
        </div>
        {moreError ? <p role="alert">Older activity could not be loaded. Your current list is unchanged.</p> : null}
        {refreshError ? <p role="alert">Current activity could not be refreshed. Retry when the connection recovers.</p> : null}
      </div>
    );
  }

  const latest = items[0]!;
  const latestIdentity = `${latest.blockHash}:${latest.transactionHash}:${latest.logIndex}`;
  return (
    <div className="notification-feed">
      <div className="notification-feed-actions">
        <p>Historical events from the reviewed Sepolia contract.</p>
        <div className="notification-feed-buttons">
          <button className="notification-read-button" type="button" disabled={refreshing} onClick={() => void load(undefined, true)}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          {deployment ? (
            <button className="notification-read-button" type="button" onClick={() => markNotificationRead({
              deployment,
              identity: latestIdentity,
              blockNumber: latest.blockNumber,
              logIndex: latest.logIndex
            })}>
              Mark current activity read
            </button>
          ) : null}
        </div>
      </div>
      {refreshError ? <p className="notification-refresh-error" role="alert">Current activity could not be refreshed. The existing list is unchanged.</p> : null}
      <ol className="notification-list">
        {items.map(item => (
          <li key={`${item.blockHash}:${item.transactionHash}:${item.logIndex}`}>
            <Link href={item.href}>
              <span className={`notification-label notification-label-${item.kind}`}>{item.label}</span>
              <strong>Raffle #{item.raffleId}</strong>
              <span>Recorded on Sepolia <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time></span>
            </Link>
          </li>
        ))}
      </ol>
      {nextCursor ? (
        <div className="notification-pagination">
          {moreError ? <p role="alert">Older activity could not be loaded. Your current list is unchanged.</p> : null}
          <button className="btn btn-dark notification-more" type="button" disabled={loadingMore || refreshing} onClick={() => void load(nextCursor)}>
            {loadingMore ? "Loading..." : moreError ? "Retry older activity" : "Load older activity"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function parseFeedPage(value: unknown): FeedPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const deployment = Reflect.get(value, "deployment");
  const rawItems = Reflect.get(value, "items");
  const nextCursor = Reflect.get(value, "nextCursor");
  const fresh = Reflect.get(value, "fresh");
  if (typeof deployment !== "string" || !Array.isArray(rawItems) || rawItems.length > 50 || nextCursor !== null && typeof nextCursor !== "string" || typeof fresh !== "boolean") throw new Error();
  const items = rawItems.map(parseFeedItem);
  return { deployment, items, nextCursor, fresh };
}

function parseFeedItem(value: unknown): FeedItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const kind = Reflect.get(value, "kind");
  const label = Reflect.get(value, "label");
  const raffleId = Reflect.get(value, "raffleId");
  const occurredAt = Reflect.get(value, "occurredAt");
  const blockNumber = Reflect.get(value, "blockNumber");
  const blockHash = Reflect.get(value, "blockHash");
  const transactionHash = Reflect.get(value, "transactionHash");
  const logIndex = Reflect.get(value, "logIndex");
  const href = Reflect.get(value, "href");
  const draft = kind === "draft-created" && label === "Draft awaiting review" && href === `/review/${raffleId}`;
  const opened = kind === "sales-opened" && label === "Raffle live" && href === `/piece/${raffleId}`;
  if ((!draft && !opened) || typeof raffleId !== "string" || typeof occurredAt !== "string" || typeof blockNumber !== "string" || !/^(0|[1-9]\d{0,77})$/.test(blockNumber) || typeof blockHash !== "string" || typeof transactionHash !== "string" || !Number.isSafeInteger(logIndex) || Number(logIndex) < 0) throw new Error();
  return { kind, label, raffleId, occurredAt, blockNumber, blockHash, transactionHash, logIndex, href };
}

function mergeItems(current: FeedItem[], incoming: FeedItem[]): FeedItem[] {
  const seen = new Set(current.map(item => `${item.blockHash}:${item.transactionHash}:${item.logIndex}`));
  return [...current, ...incoming.filter(item => !seen.has(`${item.blockHash}:${item.transactionHash}:${item.logIndex}`))];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
