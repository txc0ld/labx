import type { Hex } from "viem";
import { createNotificationReadBudget, notificationWorkflow, NotificationRangeTooDenseError, NotificationReadBudgetError, NotificationRpcTimeoutError, readFinalizedEvents, type NotificationEvent, type NotificationWorkflow } from "./events";

const RANGE_SIZE = 500n;
const MAX_RANGES = 4;
const MAX_LIMIT = 50;
const FRESH_AFTER_SECONDS = 20 * 60;
const CACHE_MS = 60_000;

type PublicCursor =
  | { kind: "event"; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; transactionIndex: number; logIndex: number }
  | { kind: "range"; beforeBlock: bigint };
export type PublicNotificationPage = {
  kind: "available";
  deployment: string;
  items: readonly NotificationEvent[];
  nextCursor: string | null;
  range: { fromBlock: string; toBlock: string };
  finalized: { blockNumber: string; blockHash: Hex; occurredAt: string };
  fresh: boolean;
};

const cache = new Map<string, { expiresAt: number; value: Promise<PublicNotificationPage> }>();

export async function readRecentNotifications(args: {
  cursor?: string;
  limit?: number;
  workflow?: () => Promise<NotificationWorkflow>;
  now?: number;
} = {}): Promise<PublicNotificationPage> {
  const limit = args.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("Notification page size is invalid.");
  const cursor = args.cursor === undefined ? null : parsePublicCursor(args.cursor);
  const workflow = await within((args.workflow ?? notificationWorkflow)(), 8_000);
  const finalizedRaw = await within(workflow.client.getBlock({ blockTag: "finalized" }), 8_000);
  if (finalizedRaw.number === null || finalizedRaw.hash === null || finalizedRaw.timestamp < 0n) {
    throw new Error("Finalized notification history is unavailable.");
  }
  const finalized = { number: finalizedRaw.number, hash: finalizedRaw.hash, timestamp: finalizedRaw.timestamp };
  let end = cursor?.kind === "event" ? cursor.blockNumber : cursor?.beforeBlock ?? finalized.number;
  if (end > finalized.number || end < workflow.manifest.deploymentBlock) throw new Error("Notification cursor is outside the reviewed deployment.");

  const collected: NotificationEvent[] = [];
  let lowest = end;
  let cursorFound = cursor === null || cursor.kind === "range";
  let completedRanges = 0;
  let attempts = 0;
  const readBudget = createNotificationReadBudget(64, 8_000);
  scan: while (completedRanges < MAX_RANGES && attempts < MAX_RANGES * 4 && end >= workflow.manifest.deploymentBlock && collected.length <= limit) {
    const possibleStart = end - RANGE_SIZE + 1n;
    let start = possibleStart > workflow.manifest.deploymentBlock ? possibleStart : workflow.manifest.deploymentBlock;
    let page: Awaited<ReturnType<typeof readFinalizedEvents>> | null = null;
    while (page === null && attempts < MAX_RANGES * 4) {
      attempts += 1;
      try {
        page = await readFinalizedEvents({ fromBlock: start, toBlock: end, workflow: async () => workflow, budget: readBudget });
      } catch (error) {
        if (
          completedRanges > 0
          && cursorFound
          && (error instanceof NotificationReadBudgetError || error instanceof NotificationRpcTimeoutError)
        ) break scan;
        if (!(error instanceof NotificationRangeTooDenseError) || start === end) throw error;
        start = start + (end - start + 1n) / 2n;
      }
    }
    if (page === null) break;
    completedRanges += 1;
    const descending = [...page.events].reverse();
    if (cursor?.kind === "event" && end === cursor.blockNumber) {
      cursorFound = descending.some(item => matchesCursor(item, cursor));
      collected.push(...descending.filter(item => compareToCursor(item, cursor) < 0));
    } else {
      collected.push(...descending);
    }
    lowest = start;
    if (start === workflow.manifest.deploymentBlock) break;
    end = start - 1n;
  }
  if (!cursorFound) throw new Error("Notification cursor no longer matches finalized history.");

  const items = collected.slice(0, limit);
  const hasPotentiallyMore = collected.length > limit || lowest > workflow.manifest.deploymentBlock;
  const last = items.at(-1);
  const milliseconds = Number(finalized.timestamp) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Finalized notification time is invalid.");
  const now = args.now ?? Date.now();
  return {
    kind: "available",
    deployment: `${workflow.manifest.chainId}:${workflow.manifest.address.toLowerCase()}`,
    items,
    nextCursor: hasPotentiallyMore ? last ? formatPublicCursor(last) : formatRangeCursor(lowest - 1n) : null,
    range: { fromBlock: lowest.toString(), toBlock: (cursor?.kind === "event" ? cursor.blockNumber : cursor?.beforeBlock ?? finalized.number).toString() },
    finalized: { blockNumber: finalized.number.toString(), blockHash: finalized.hash, occurredAt: new Date(milliseconds).toISOString() },
    fresh: Number.isSafeInteger(now) && now >= milliseconds && now - milliseconds <= FRESH_AFTER_SECONDS * 1_000
  };
}

export function readRecentNotificationsCached(args: { cursor?: string; limit?: number } = {}): Promise<PublicNotificationPage> {
  const key = `${args.cursor ?? "latest"}:${args.limit ?? 20}`;
  const now = Date.now();
  const current = cache.get(key);
  if (current && current.expiresAt > now) return current.value;
  for (const [cachedKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(cachedKey);
  if (cache.size >= 128) cache.delete(cache.keys().next().value ?? "");
  const value = readRecentNotifications(args);
  cache.set(key, { expiresAt: now + CACHE_MS, value });
  void value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

export function parsePublicCursor(value: string): PublicCursor {
  const range = /^before\.(0|[1-9]\d{0,77})$/.exec(value);
  if (range) return { kind: "range", beforeBlock: BigInt(range[1]!) };
  const match = /^(0|[1-9]\d{0,77})\.([0-9a-fA-F]{64})\.([0-9a-fA-F]{64})\.(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})$/.exec(value);
  if (!match) throw new Error("Notification cursor is invalid.");
  const transactionIndex = Number(match[4]);
  const logIndex = Number(match[5]);
  if (!Number.isSafeInteger(transactionIndex) || !Number.isSafeInteger(logIndex)) throw new Error("Notification cursor is invalid.");
  return {
    kind: "event",
    blockNumber: BigInt(match[1]!),
    blockHash: `0x${match[2]}`,
    transactionHash: `0x${match[3]}`,
    transactionIndex,
    logIndex
  };
}

function formatRangeCursor(beforeBlock: bigint): string {
  return `before.${beforeBlock}`;
}

function formatPublicCursor(event: NotificationEvent): string {
  return `${event.blockNumber}.${event.blockHash.slice(2)}.${event.transactionHash.slice(2)}.${event.transactionIndex}.${event.logIndex}`;
}

function matchesCursor(event: NotificationEvent, cursor: PublicCursor): boolean {
  if (cursor.kind !== "event") return false;
  return BigInt(event.blockNumber) === cursor.blockNumber
    && event.blockHash.toLowerCase() === cursor.blockHash.toLowerCase()
    && event.transactionHash.toLowerCase() === cursor.transactionHash.toLowerCase()
    && event.transactionIndex === cursor.transactionIndex
    && event.logIndex === cursor.logIndex;
}

function compareToCursor(event: NotificationEvent, cursor: PublicCursor): number {
  if (cursor.kind !== "event") return -1;
  const block = BigInt(event.blockNumber);
  if (block !== cursor.blockNumber) return block < cursor.blockNumber ? -1 : 1;
  if (event.transactionIndex !== cursor.transactionIndex) return event.transactionIndex - cursor.transactionIndex;
  return event.logIndex - cursor.logIndex;
}

async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Notification public read timed out.")), milliseconds); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
