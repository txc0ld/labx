import type { Hex } from "viem";
import { serverWorkflow } from "../chain/server";
import type { BlockRef } from "../chain/types";
import type { Store } from "../points";
import type { MailSender } from "../receipt-delivery";
import { deliverNotification } from "./delivery";
import { adaptNotificationWorkflow, NotificationRangeTooDenseError, parseNotificationEvent, readFinalizedEvents, type NotificationEvent, type NotificationWorkflow, type VerifiedEventPage } from "./events";

const PAGE_BLOCKS = 250n;
const MAX_INGESTION_PAGES = 2;
const MAX_RETRY_PAGES = 4;
const MAX_EVENT_CHECKS = 400;
const MAX_SENDS = 3;
const MAX_RUNTIME_MS = 8_000;

type StoredActivation = { version: 1; deployment: string; blockNumber: string; blockHash: Hex };
type StoredPage = {
  version: 1;
  deployment: string;
  startBlock: string;
  actualEnd: string;
  nextBlock: string;
  events: readonly NotificationEvent[];
};

export type NotificationProcessorSource = {
  deployment: string;
  origin: string;
  latest: BlockRef;
  finalized(): Promise<BlockRef>;
  block(number: bigint): Promise<BlockRef>;
  events(fromBlock: bigint, toBlock: bigint): Promise<VerifiedEventPage>;
};

export type NotificationRunReport = {
  status: "activated" | "ok" | "idle" | "reconciliation-required";
  activationBlock: string;
  finalizedBlock: string;
  ingestedPages: number;
  ingestedEvents: number;
  checkedEvents: number;
  sends: number;
  accepted: number;
  pending: number;
  reconciliationRequired: number;
  ingestionNextBlock: string;
  retryNextBlock: string;
  reconciliation?: string;
};

export async function notificationProcessorSource(): Promise<NotificationProcessorSource> {
  const server = await serverWorkflow();
  const workflow = adaptNotificationWorkflow(server);
  const deployment = `${workflow.manifest.chainId}:${workflow.manifest.address.toLowerCase()}`;
  const pinnedWorkflow = async (): Promise<NotificationWorkflow> => workflow;
  return {
    deployment,
    origin: workflow.context.origin,
    latest: workflow.block,
    async finalized() {
      const block = await workflow.client.getBlock({ blockTag: "finalized" });
      return checkedBlock(block);
    },
    async block(number) {
      const block = await workflow.client.getBlock({ blockNumber: number });
      const checked = checkedBlock(block);
      if (checked.number !== number) throw new Error("Notification block number is invalid.");
      return checked;
    },
    async events(fromBlock, toBlock) {
      return readFinalizedEvents({ fromBlock, toBlock, workflow: pinnedWorkflow });
    }
  };
}

export async function processNotifications(args: {
  store: Store;
  source: NotificationProcessorSource;
  sender: MailSender;
  from: string;
  transportIdentity: string;
  now?: number;
  clock?: () => number;
}): Promise<NotificationRunReport> {
  const now = args.now ?? Date.now();
  const deliveryClock = args.clock ?? (args.now === undefined ? Date.now : () => now);
  const startedAt = Date.now();
  const prefix = `raffle-notifications:v1:${args.source.deployment}`;
  const activationKey = `${prefix}:activation`;
  const activationCandidate: StoredActivation = {
    version: 1,
    deployment: args.source.deployment,
    blockNumber: args.source.latest.number.toString(),
    blockHash: args.source.latest.hash
  };
  const createdActivation = await args.store.setIfAbsent({ [activationKey]: JSON.stringify(activationCandidate) });
  const activationRaw = await args.store.get(activationKey);
  if (activationRaw === null) throw new Error("Notification activation was not persisted.");
  const activation = parseActivation(activationRaw, args.source.deployment);
  const activationBlock = BigInt(activation.blockNumber);
  const firstEventBlock = activationBlock + 1n;
  const empty = baseReport(activation.blockNumber, activation.blockNumber, firstEventBlock);
  if (createdActivation) return { ...empty, status: "activated" };

  const terminalKey = `${prefix}:activation-reconciliation`;
  const existingTerminal = await args.store.get(terminalKey);
  if (existingTerminal !== null) {
    parseActivationReconciliation(existingTerminal);
    return { ...empty, status: "reconciliation-required", reconciliation: "The activation boundary needs reconciliation." };
  }

  const finalized = await args.source.finalized();
  empty.finalizedBlock = finalized.number.toString();
  if (finalized.number < activationBlock) return { ...empty, status: "idle" };
  const verifiedBoundaryKey = `${prefix}:activation-verified`;
  const verifiedBoundary = await args.store.get(verifiedBoundaryKey);
  if (verifiedBoundary === null) {
    const boundary = await args.source.block(activationBlock);
    if (boundary.hash.toLowerCase() !== activation.blockHash.toLowerCase()) {
      const marker = JSON.stringify({ version: 1, reason: "activation-boundary-changed", recordedAt: now });
      await args.store.setIfAbsent({ [terminalKey]: marker });
      return { ...empty, status: "reconciliation-required", reconciliation: "The activation boundary changed and needs reconciliation." };
    }
    await args.store.setIfAbsent({ [verifiedBoundaryKey]: JSON.stringify({ version: 1, blockNumber: activation.blockNumber, blockHash: activation.blockHash }) });
  } else {
    parseVerifiedBoundary(verifiedBoundary, activation);
  }
  if (finalized.number < firstEventBlock) return { ...empty, status: "idle" };

  const ingestionHintKey = `${prefix}:ingestion-hint`;
  const retryHintKey = `${prefix}:retry-hint`;
  const lastPageKey = `${prefix}:last-ingested-page`;
  let ingestionStart = await verifiedProgressHint(args.store, await args.store.get(ingestionHintKey), firstEventBlock, prefix, "ingestion");
  let ingestedPages = 0;
  let ingestedEvents = 0;
  const ingestedStarts: bigint[] = [];
  while (
    ingestionStart <= finalized.number
    && ingestedPages < MAX_INGESTION_PAGES
    && Date.now() - startedAt < MAX_RUNTIME_MS
  ) {
    const page = await loadOrCreatePage(args.store, args.source, prefix, ingestionStart, finalized.number);
    await args.store.set(ingestionHintKey, page.nextBlock);
    await args.store.set(lastPageKey, page.startBlock);
    ingestionStart = BigInt(page.nextBlock);
    ingestedStarts.push(BigInt(page.startBlock));
    ingestedPages += 1;
    ingestedEvents += page.events.length;
  }

  const retryStart = await verifiedProgressHint(args.store, await args.store.get(retryHintKey), firstEventBlock, prefix, "retry");
  const retryStarts = await retryPageStarts(args.store, prefix, retryStart);
  const lastPage = parseOptionalHint(await args.store.get(lastPageKey));
  if (lastPage !== null && !retryStarts.includes(lastPage)) retryStarts.push(lastPage);
  for (const start of ingestedStarts) if (!retryStarts.includes(start)) retryStarts.push(start);

  let checkedEvents = 0;
  let sends = 0;
  let accepted = 0;
  let pending = 0;
  let reconciliationRequired = 0;
  let retryNext = retryStart;
  for (const pageStart of retryStarts) {
    if (checkedEvents >= MAX_EVENT_CHECKS || Date.now() - startedAt >= MAX_RUNTIME_MS) break;
    const raw = await args.store.get(pageKey(prefix, pageStart));
    if (raw === null) continue;
    const page = parsePage(raw, args.source.deployment, pageStart);
    const resumeKey = `${pageKey(prefix, pageStart)}:resume`;
    let index = parseResume(await args.store.get(resumeKey), page.events.length);
    let scanned = 0;
    let allTerminal = true;
    while (scanned < page.events.length && checkedEvents < MAX_EVENT_CHECKS) {
      let budgetBlocked = false;
      const budgetedSender: MailSender = async (payload, key) => {
        if (sends >= MAX_SENDS) {
          budgetBlocked = true;
          return false;
        }
        sends += 1;
        return args.sender(payload, key);
      };
      const result = await deliverNotification({
        store: args.store,
        event: page.events[index]!,
        deployment: args.source.deployment,
        origin: args.source.origin,
        sender: budgetedSender,
        from: args.from,
        transportIdentity: args.transportIdentity,
        now,
        clock: deliveryClock
      });
      checkedEvents += 1;
      scanned += 1;
      index = (index + 1) % page.events.length;
      await args.store.set(resumeKey, index.toString());
      if (result.status === "accepted") accepted += 1;
      else if (result.status === "pending") { pending += 1; allTerminal = false; }
      else reconciliationRequired += 1;
      if (budgetBlocked || Date.now() - startedAt >= MAX_RUNTIME_MS) break;
    }
    if (scanned < page.events.length) allTerminal = false;
    if (pageStart === retryNext && allTerminal) {
      const proofKey = `${prefix}:retry-proof:${page.nextBlock}`;
      await args.store.setIfAbsent({ [proofKey]: page.startBlock });
      retryNext = BigInt(page.nextBlock);
      await args.store.set(retryHintKey, page.nextBlock);
    }
  }

  return {
    status: ingestedPages || checkedEvents ? "ok" : "idle",
    activationBlock: activation.blockNumber,
    finalizedBlock: finalized.number.toString(),
    ingestedPages,
    ingestedEvents,
    checkedEvents,
    sends,
    accepted,
    pending,
    reconciliationRequired,
    ingestionNextBlock: ingestionStart.toString(),
    retryNextBlock: retryNext.toString()
  };
}

async function loadOrCreatePage(
  store: Store,
  source: NotificationProcessorSource,
  prefix: string,
  start: bigint,
  finalized: bigint
): Promise<StoredPage> {
  const key = pageKey(prefix, start);
  let raw = await store.get(key);
  if (raw === null) {
    let actualEnd = start + PAGE_BLOCKS - 1n < finalized ? start + PAGE_BLOCKS - 1n : finalized;
    let verified: VerifiedEventPage | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let candidate: VerifiedEventPage;
      try {
        candidate = await source.events(start, actualEnd);
      } catch (error) {
        if (!(error instanceof NotificationRangeTooDenseError) || actualEnd === start) throw error;
        actualEnd = start + (actualEnd - start) / 2n;
        continue;
      }
      if (candidate.range.fromBlock !== start || candidate.range.toBlock !== actualEnd || candidate.finalized.number < actualEnd) {
        throw new Error("Notification event page does not match its requested finalized range.");
      }
      if (candidate.events.length <= 100) {
        verified = candidate;
        break;
      }
      if (actualEnd === start) throw new Error("A finalized block exceeds the notification event page limit.");
      actualEnd = start + (actualEnd - start) / 2n;
    }
    if (verified === null) throw new Error("Notification event page could not fit its bounded page size.");
    const candidate: StoredPage = {
      version: 1,
      deployment: source.deployment,
      startBlock: start.toString(),
      actualEnd: actualEnd.toString(),
      nextBlock: (actualEnd + 1n).toString(),
      events: verified.events
    };
    await store.setIfAbsent({
      [key]: JSON.stringify(candidate),
      [`${prefix}:ingestion-proof:${candidate.nextBlock}`]: candidate.startBlock
    });
    raw = await store.get(key);
  }
  if (raw === null) throw new Error("Notification event page was not persisted.");
  return parsePage(raw, source.deployment, start);
}

async function retryPageStarts(store: Store, prefix: string, start: bigint): Promise<bigint[]> {
  const starts: bigint[] = [];
  let current = start;
  for (let count = 0; count < MAX_RETRY_PAGES; count += 1) {
    const raw = await store.get(pageKey(prefix, current));
    if (raw === null) break;
    const page = parsePage(raw, prefix.slice("raffle-notifications:v1:".length), current);
    starts.push(current);
    current = BigInt(page.nextBlock);
  }
  return starts;
}

function pageKey(prefix: string, start: bigint): string {
  return `${prefix}:page:${start}`;
}

function parseActivation(raw: string, deployment: string): StoredActivation {
  const value = parseObject(raw, "Notification activation record is invalid.");
  const version = Reflect.get(value, "version");
  const storedDeployment = Reflect.get(value, "deployment");
  const blockNumber = Reflect.get(value, "blockNumber");
  const blockHash = Reflect.get(value, "blockHash");
  if (version !== 1 || storedDeployment !== deployment || !isBlockString(blockNumber) || !isHash(blockHash)) {
    throw new Error("Notification activation record is invalid.");
  }
  return { version, deployment: storedDeployment, blockNumber, blockHash };
}

function parsePage(raw: string, deployment: string, expectedStart: bigint): StoredPage {
  const value = parseObject(raw, "Notification event page is invalid.");
  const version = Reflect.get(value, "version");
  const storedDeployment = Reflect.get(value, "deployment");
  const startBlock = Reflect.get(value, "startBlock");
  const actualEnd = Reflect.get(value, "actualEnd");
  const nextBlock = Reflect.get(value, "nextBlock");
  const rawEvents = Reflect.get(value, "events");
  if (
    version !== 1 || storedDeployment !== deployment || !isBlockString(startBlock) || BigInt(startBlock) !== expectedStart
    || !isBlockString(actualEnd) || BigInt(actualEnd) < expectedStart
    || !isBlockString(nextBlock) || BigInt(nextBlock) !== BigInt(actualEnd) + 1n
    || !Array.isArray(rawEvents) || rawEvents.length > 100
  ) throw new Error("Notification event page is invalid.");
  const events = rawEvents.map(parseNotificationEvent);
  let previous: NotificationEvent | null = null;
  for (const event of events) {
    const block = BigInt(event.blockNumber);
    if (block < expectedStart || block > BigInt(actualEnd)) throw new Error("Notification event page is invalid.");
    if (previous && compareEvents(previous, event) >= 0) throw new Error("Notification event page is invalid.");
    previous = event;
  }
  return { version, deployment: storedDeployment, startBlock, actualEnd, nextBlock, events };
}

function compareEvents(left: NotificationEvent, right: NotificationEvent): number {
  const leftBlock = BigInt(left.blockNumber);
  const rightBlock = BigInt(right.blockNumber);
  if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) return left.transactionIndex - right.transactionIndex;
  return left.logIndex - right.logIndex;
}

function parseObject(raw: string, message: string): object {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(message); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value;
}

function parseOptionalHint(raw: string | null): bigint | null {
  return raw === null ? null : parseHintValue(raw);
}

async function verifiedProgressHint(
  store: Store,
  raw: string | null,
  fallback: bigint,
  prefix: string,
  kind: "ingestion" | "retry"
): Promise<bigint> {
  if (raw === null) return fallback;
  const hint = parseHintValue(raw);
  if (hint === fallback) return hint;
  if (hint < fallback) return fallback;
  const proof = await store.get(`${prefix}:${kind}-proof:${hint}`);
  if (proof === null || !isBlockString(proof)) return fallback;
  const pageRaw = await store.get(pageKey(prefix, BigInt(proof)));
  if (pageRaw === null) return fallback;
  const page = parsePage(pageRaw, prefix.slice("raffle-notifications:v1:".length), BigInt(proof));
  if (page.nextBlock !== hint.toString()) return fallback;
  return hint;
}

function parseHintValue(raw: string): bigint {
  if (!isBlockString(raw)) throw new Error("Notification progress hint is invalid.");
  return BigInt(raw);
}

function parseResume(raw: string | null, length: number): number {
  if (length === 0) return 0;
  if (raw === null) return 0;
  if (!/^\d{1,3}$/.test(raw)) throw new Error("Notification retry position is invalid.");
  const index = Number(raw);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new Error("Notification retry position is invalid.");
  return index;
}

function parseActivationReconciliation(raw: string): void {
  const value = parseObject(raw, "Notification activation reconciliation record is invalid.");
  if (
    Reflect.get(value, "version") !== 1 || Reflect.get(value, "reason") !== "activation-boundary-changed"
    || !Number.isSafeInteger(Reflect.get(value, "recordedAt"))
  ) throw new Error("Notification activation reconciliation record is invalid.");
}

function parseVerifiedBoundary(raw: string, activation: StoredActivation): void {
  const value = parseObject(raw, "Notification activation verification record is invalid.");
  if (
    Reflect.get(value, "version") !== 1
    || Reflect.get(value, "blockNumber") !== activation.blockNumber
    || Reflect.get(value, "blockHash") !== activation.blockHash
  ) throw new Error("Notification activation verification record is invalid.");
}

function isBlockString(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value);
}

function isHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function checkedBlock(block: { number: bigint | null; hash: Hex | null; timestamp: bigint }): BlockRef {
  if (block.number === null || block.hash === null || block.timestamp < 0n) throw new Error("Notification block metadata is incomplete.");
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}

function baseReport(activationBlock: string, finalizedBlock: string, next: bigint): NotificationRunReport {
  return {
    status: "idle", activationBlock, finalizedBlock, ingestedPages: 0, ingestedEvents: 0,
    checkedEvents: 0, sends: 0, accepted: 0, pending: 0, reconciliationRequired: 0,
    ingestionNextBlock: next.toString(), retryNextBlock: next.toString()
  };
}
