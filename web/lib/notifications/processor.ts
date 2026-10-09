import type { Hex } from "viem";
import { serverWorkflow } from "../chain/server";
import type { BlockRef } from "../chain/types";
import type { Store } from "../points";
import type { MailSender } from "../receipt-delivery";
import { deliverNotification } from "./delivery";
import { adaptNotificationWorkflow, NotificationRangeTooDenseError, NotificationReadBudgetError, NotificationRpcTimeoutError, parseNotificationEvent, readFinalizedEvents, type NotificationEvent, type NotificationWorkflow, type VerifiedEventPage } from "./events";

const PAGE_BLOCKS = 250n;
const MAX_INGESTION_PAGES = 2;
const MAX_RETRY_PAGES = 4;
const MAX_EVENT_CHECKS = 400;
const MAX_SENDS = 3;
const DELIVERY_RUNTIME_MS = 31_000;
const INGESTION_RUNTIME_MS = 10_000;
const SOURCE_CALL_MS = 6_000;
const MIN_NOTIFICATION_LOG_GAS = 1_125n;

type StoredActivation = { version: 1; deployment: string; blockNumber: string; blockHash: Hex };
type StoredPageV1 = {
  version: 1;
  deployment: string;
  startBlock: string;
  actualEnd: string;
  nextBlock: string;
  events: readonly NotificationEvent[];
};
type StoredRangePage = Omit<StoredPageV1, "version"> & { version: 2; kind: "range" };
type StoredSingleBlockPage = Omit<StoredPageV1, "version"> & {
  version: 2;
  kind: "single-block";
  blockNumber: string;
  blockHash: Hex;
  gasLimit: string;
};
type StoredPage = StoredPageV1 | StoredRangePage | StoredSingleBlockPage;

export type NotificationProcessorSource = {
  deployment: string;
  origin: string;
  latest: BlockRef;
  finalized(): Promise<BlockRef>;
  block(number: bigint): Promise<BlockRef & { gasLimit?: bigint }>;
  events(fromBlock: bigint, toBlock: bigint): Promise<VerifiedEventPage>;
};

export type NotificationRunReport = {
  status: "activated" | "ok" | "idle" | "degraded" | "reconciliation-required";
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
  ingestion: { status: "idle" | "advanced" | "blocked"; fromBlock?: string; toBlock?: string; reason?: IngestionFailureReason; incident?: string };
  lastIncident?: { id: string; kind: "ingestion" | "delivery" | "reconciliation"; reason: string };
};

type IngestionFailureReason = "range-too-dense" | "rpc-budget-exhausted" | "rpc-timeout" | "source-unavailable";

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

  const verifiedBoundaryKey = `${prefix}:activation-verified`;
  const verifiedBoundary = await args.store.get(verifiedBoundaryKey);
  if (verifiedBoundary === null) {
    const finalized = await within(() => args.source.finalized(), SOURCE_CALL_MS);
    empty.finalizedBlock = finalized.number.toString();
    if (finalized.number < activationBlock) return { ...empty, status: "idle" };
    const boundary = await within(() => args.source.block(activationBlock), SOURCE_CALL_MS);
    if (boundary.hash.toLowerCase() !== activation.blockHash.toLowerCase()) {
      const marker = JSON.stringify({ version: 1, reason: "activation-boundary-changed", recordedAt: now });
      await args.store.setIfAbsent({ [terminalKey]: marker });
      return { ...empty, status: "reconciliation-required", reconciliation: "The activation boundary changed and needs reconciliation." };
    }
    await args.store.setIfAbsent({ [verifiedBoundaryKey]: JSON.stringify({ version: 1, blockNumber: activation.blockNumber, blockHash: activation.blockHash }) });
  } else {
    parseVerifiedBoundary(verifiedBoundary, activation);
  }

  const ingestionHintKey = `${prefix}:ingestion-hint`;
  const retryHintKey = `${prefix}:retry-hint`;
  const lastPageKey = `${prefix}:last-ingested-page`;
  const retryStart = await verifiedProgressHint(args.store, await args.store.get(retryHintKey), firstEventBlock, prefix, "retry");
  const retryStarts = await retryPageStarts(args.store, prefix, retryStart);
  const lastPage = parseOptionalHint(await args.store.get(lastPageKey));
  if (lastPage !== null && !retryStarts.includes(lastPage)) retryStarts.push(lastPage);
  const delivery = {
    deadline: Date.now() + DELIVERY_RUNTIME_MS,
    checkedEvents: 0,
    sends: 0,
    accepted: 0,
    pending: 0,
    reconciliationRequired: 0,
    retryNext: retryStart,
    lastIncident: await readLatestIncident(args.store, prefix)
  };
  await processDeliveryPages(args, prefix, retryStarts, delivery, now, deliveryClock);

  let ingestionStart = await verifiedProgressHint(args.store, await args.store.get(ingestionHintKey), firstEventBlock, prefix, "ingestion");
  let ingestedPages = 0;
  let ingestedEvents = 0;
  const ingestedStarts: bigint[] = [];
  let ingestion: NotificationRunReport["ingestion"] = { status: "idle" };
  const ingestionDeadline = Date.now() + INGESTION_RUNTIME_MS;
  let finalizedBlock = activation.blockNumber;
  try {
    const finalized = await within(() => args.source.finalized(), SOURCE_CALL_MS);
    finalizedBlock = finalized.number.toString();
    if (finalized.number < activationBlock) throw new Error("Finalized height regressed below activation.");
    while (ingestionStart <= finalized.number && ingestedPages < MAX_INGESTION_PAGES && Date.now() < ingestionDeadline) {
      const requestedEnd = minimum(ingestionStart + PAGE_BLOCKS - 1n, finalized.number);
      const page = await loadOrCreatePage(args.store, args.source, prefix, ingestionStart, finalized.number, ingestionDeadline);
      await args.store.set(ingestionHintKey, page.nextBlock);
      await args.store.set(lastPageKey, page.startBlock);
      ingestionStart = BigInt(page.nextBlock);
      ingestedStarts.push(BigInt(page.startBlock));
      ingestedPages += 1;
      ingestedEvents += page.events.length;
      ingestion = { status: "advanced", fromBlock: page.startBlock, toBlock: page.actualEnd };
      await args.store.set(`${prefix}:ingestion-status`, JSON.stringify({ version: 1, state: "advanced", nextBlock: page.nextBlock, recordedAt: now }));
      if (BigInt(page.actualEnd) < requestedEnd) break;
    }
  } catch (error) {
    const reason = ingestionFailureReason(error);
    const incident = `${prefix}:incident:ingestion:${ingestionStart}`;
    const marker = JSON.stringify({ version: 1, kind: "ingestion", reason, fromBlock: ingestionStart.toString(), recordedAt: now });
    await args.store.setIfAbsent({ [incident]: marker });
    await args.store.set(`${prefix}:ingestion-status`, marker);
    await writeLatestIncident(args.store, prefix, { id: incident, kind: "ingestion", reason });
    delivery.lastIncident = { id: incident, kind: "ingestion", reason };
    ingestion = { status: "blocked", fromBlock: ingestionStart.toString(), reason, incident };
  }

  const freshStarts = ingestedStarts.filter(start => !retryStarts.includes(start));
  await processDeliveryPages(args, prefix, freshStarts, delivery, now, deliveryClock);

  return {
    status: ingestion.status === "blocked" ? "degraded" : delivery.reconciliationRequired ? "reconciliation-required" : ingestedPages || delivery.checkedEvents ? "ok" : "idle",
    activationBlock: activation.blockNumber,
    finalizedBlock,
    ingestedPages,
    ingestedEvents,
    checkedEvents: delivery.checkedEvents,
    sends: delivery.sends,
    accepted: delivery.accepted,
    pending: delivery.pending,
    reconciliationRequired: delivery.reconciliationRequired,
    ingestionNextBlock: ingestionStart.toString(),
    retryNextBlock: delivery.retryNext.toString(),
    ingestion,
    ...(delivery.lastIncident ? { lastIncident: delivery.lastIncident } : {})
  };
}

async function loadOrCreatePage(
  store: Store,
  source: NotificationProcessorSource,
  prefix: string,
  start: bigint,
  finalized: bigint,
  deadline: number
): Promise<StoredPage> {
  const key = pageKey(prefix, start);
  let raw = await store.get(key);
  if (raw === null) {
    let actualEnd = minimum(start + PAGE_BLOCKS - 1n, finalized);
    let verified: VerifiedEventPage | null = null;
    while (verified === null) {
      if (Date.now() >= deadline) throw new NotificationRpcTimeoutError();
      let candidate: VerifiedEventPage;
      try {
        candidate = await within(() => source.events(start, actualEnd), Math.min(SOURCE_CALL_MS, deadline - Date.now()));
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
      if (actualEnd === start) {
        verified = candidate;
        break;
      }
      actualEnd = start + (actualEnd - start) / 2n;
    }
    const common = {
      deployment: source.deployment,
      startBlock: start.toString(),
      actualEnd: actualEnd.toString(),
      nextBlock: (actualEnd + 1n).toString(),
      events: verified.events
    };
    let candidate: StoredPage;
    if (actualEnd === start) {
      const canonical = verified.singleBlock ?? await within(() => source.block(start), Math.min(SOURCE_CALL_MS, deadline - Date.now()));
      if (canonical.number !== start || canonical.gasLimit === undefined || canonical.gasLimit <= 0n) {
        throw new Error("Notification single-block page lacks its canonical gas bound.");
      }
      candidate = {
        version: 2,
        kind: "single-block",
        ...common,
        blockNumber: start.toString(),
        blockHash: canonical.hash,
        gasLimit: canonical.gasLimit.toString()
      };
    } else {
      candidate = { version: 2, kind: "range", ...common };
    }
    await store.setIfAbsent({
      [key]: JSON.stringify(candidate),
      [`${prefix}:ingestion-proof:${candidate.nextBlock}`]: candidate.startBlock
    });
    raw = await store.get(key);
  }
  if (raw === null) throw new Error("Notification event page was not persisted.");
  return parsePage(raw, source.deployment, start);
}

type DeliveryState = {
  deadline: number;
  checkedEvents: number;
  sends: number;
  accepted: number;
  pending: number;
  reconciliationRequired: number;
  retryNext: bigint;
  lastIncident?: NotificationRunReport["lastIncident"];
};

async function processDeliveryPages(
  args: {
    store: Store;
    source: NotificationProcessorSource;
    sender: MailSender;
    from: string;
    transportIdentity: string;
  },
  prefix: string,
  starts: readonly bigint[],
  state: DeliveryState,
  now: number,
  clock: () => number
): Promise<void> {
  for (const pageStart of starts) {
    if (state.checkedEvents >= MAX_EVENT_CHECKS || Date.now() >= state.deadline || state.sends >= MAX_SENDS) break;
    const raw = await args.store.get(pageKey(prefix, pageStart));
    if (raw === null) continue;
    const page = parsePage(raw, args.source.deployment, pageStart);
    const resumeKey = `${pageKey(prefix, pageStart)}:resume`;
    let index = parseResume(await args.store.get(resumeKey), page.events.length);
    let scanned = 0;
    while (
      scanned < page.events.length
      && state.checkedEvents < MAX_EVENT_CHECKS
      && Date.now() < state.deadline
      && state.sends < MAX_SENDS
    ) {
      const event = page.events[index]!;
      try {
        const result = await deliverNotification({
          store: args.store,
          event,
          deployment: args.source.deployment,
          origin: args.source.origin,
          sender: async (payload, key) => {
            state.sends += 1;
            return args.sender(payload, key);
          },
          from: args.from,
          transportIdentity: args.transportIdentity,
          now,
          clock
        });
        if (result.status === "accepted") {
          state.accepted += 1;
          await markEventTerminal(args.store, prefix, pageStart, index);
        } else if (result.status === "pending") state.pending += 1;
        else {
          state.reconciliationRequired += 1;
          await markEventTerminal(args.store, prefix, pageStart, index);
          const incident = `${result.key}:reconciliation`;
          const summary = { id: incident, kind: "reconciliation" as const, reason: result.reason };
          await writeLatestIncident(args.store, prefix, summary);
          state.lastIncident = summary;
        }
      } catch {
        const incident = `${pageKey(prefix, pageStart)}:event-incident:${index}`;
        const marker = JSON.stringify({ version: 1, kind: "delivery", reason: "processing-failed", blockNumber: event.blockNumber, logIndex: event.logIndex, recordedAt: now });
        await args.store.setIfAbsent({ [incident]: marker });
        const summary = { id: incident, kind: "delivery" as const, reason: "processing-failed" };
        await writeLatestIncident(args.store, prefix, summary);
        state.lastIncident = summary;
        state.pending += 1;
      }
      state.checkedEvents += 1;
      scanned += 1;
      index = page.events.length === 0 ? 0 : (index + 1) % page.events.length;
      await args.store.set(resumeKey, index.toString());
    }
    const terminalPrefix = await advanceTerminalPrefix(args.store, prefix, pageStart, page.events.length);
    const allTerminal = terminalPrefix === page.events.length;
    if (pageStart === state.retryNext && allTerminal) {
      const proofKey = `${prefix}:retry-proof:${page.nextBlock}`;
      await args.store.setIfAbsent({ [proofKey]: page.startBlock });
      state.retryNext = BigInt(page.nextBlock);
      await args.store.set(`${prefix}:retry-hint`, page.nextBlock);
    }
  }
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

function terminalMarkerKey(prefix: string, start: bigint, index: number): string {
  return `${pageKey(prefix, start)}:terminal:${index}`;
}

async function markEventTerminal(store: Store, prefix: string, start: bigint, index: number): Promise<void> {
  const key = terminalMarkerKey(prefix, start, index);
  await store.setIfAbsent({ [key]: "terminal" });
  if (await store.get(key) !== "terminal") throw new Error("Notification terminal marker was not persisted.");
}

async function advanceTerminalPrefix(
  store: Store,
  prefix: string,
  start: bigint,
  length: number
): Promise<number> {
  const hintKey = `${pageKey(prefix, start)}:terminal-prefix`;
  let prefixLength = await verifiedTerminalPrefix(store, prefix, start, length, await store.get(hintKey));
  let checked = 0;
  while (prefixLength < length && checked < MAX_EVENT_CHECKS) {
    if (await store.get(terminalMarkerKey(prefix, start, prefixLength)) !== "terminal") break;
    prefixLength += 1;
    checked += 1;
  }
  if (prefixLength > 0) {
    const proofKey = `${pageKey(prefix, start)}:terminal-proof:${prefixLength}`;
    await store.setIfAbsent({ [proofKey]: "proved" });
    if (await store.get(proofKey) !== "proved") throw new Error("Notification terminal progress proof was not persisted.");
    await store.set(hintKey, prefixLength.toString());
  }
  return prefixLength;
}

async function verifiedTerminalPrefix(
  store: Store,
  prefix: string,
  start: bigint,
  length: number,
  raw: string | null
): Promise<number> {
  if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > length) return 0;
  if (value === 0) return 0;
  return await store.get(`${pageKey(prefix, start)}:terminal-proof:${value}`) === "proved" ? value : 0;
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
    (version !== 1 && version !== 2) || storedDeployment !== deployment || !isBlockString(startBlock) || BigInt(startBlock) !== expectedStart
    || !isBlockString(actualEnd) || BigInt(actualEnd) < expectedStart
    || !isBlockString(nextBlock) || BigInt(nextBlock) !== BigInt(actualEnd) + 1n
    || !Array.isArray(rawEvents)
  ) throw new Error("Notification event page is invalid.");
  const kind = Reflect.get(value, "kind");
  if (version === 1 && rawEvents.length > 100) throw new Error("Notification event page is invalid.");
  if (version === 2 && kind !== "range" && kind !== "single-block") throw new Error("Notification event page is invalid.");
  if (version === 2 && kind === "range" && (BigInt(actualEnd) === expectedStart || rawEvents.length > 100)) {
    throw new Error("Notification event page is invalid.");
  }
  const events = rawEvents.map(parseNotificationEvent);
  let previous: NotificationEvent | null = null;
  for (const event of events) {
    const block = BigInt(event.blockNumber);
    if (block < expectedStart || block > BigInt(actualEnd)) throw new Error("Notification event page is invalid.");
    if (previous && compareEvents(previous, event) >= 0) throw new Error("Notification event page is invalid.");
    previous = event;
  }
  if (version === 1) return { version, deployment: storedDeployment, startBlock, actualEnd, nextBlock, events };
  if (kind === "range") return { version, kind, deployment: storedDeployment, startBlock, actualEnd, nextBlock, events };
  const blockNumber = Reflect.get(value, "blockNumber");
  const blockHash = Reflect.get(value, "blockHash");
  const gasLimit = Reflect.get(value, "gasLimit");
  if (
    !isBlockString(blockNumber) || BigInt(blockNumber) !== expectedStart || BigInt(actualEnd) !== expectedStart
    || !isHash(blockHash) || !isBlockString(gasLimit) || BigInt(gasLimit) <= 0n
    || BigInt(events.length) > 5n * BigInt(gasLimit) / (4n * MIN_NOTIFICATION_LOG_GAS)
    || events.some(event => BigInt(event.blockNumber) !== expectedStart || event.blockHash.toLowerCase() !== blockHash.toLowerCase())
  ) throw new Error("Notification event page is invalid.");
  return { version, kind, deployment: storedDeployment, startBlock, actualEnd, nextBlock, events, blockNumber, blockHash, gasLimit };
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
  return raw !== null && isBlockString(raw) ? BigInt(raw) : null;
}

async function verifiedProgressHint(
  store: Store,
  raw: string | null,
  fallback: bigint,
  prefix: string,
  kind: "ingestion" | "retry"
): Promise<bigint> {
  if (raw === null) return fallback;
  if (!isBlockString(raw)) return fallback;
  const hint = BigInt(raw);
  if (hint === fallback) return hint;
  if (hint < fallback) return fallback;
  const proof = await store.get(`${prefix}:${kind}-proof:${hint}`);
  if (proof === null) return fallback;
  if (!isBlockString(proof)) throw new Error("Notification progress proof is invalid.");
  const pageRaw = await store.get(pageKey(prefix, BigInt(proof)));
  if (pageRaw === null) throw new Error("Notification progress proof has no durable page.");
  const page = parsePage(pageRaw, prefix.slice("raffle-notifications:v1:".length), BigInt(proof));
  if (page.nextBlock !== hint.toString()) throw new Error("Notification progress proof does not match its durable page.");
  return hint;
}

function parseResume(raw: string | null, length: number): number {
  if (length === 0) return 0;
  if (raw === null) return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return 0;
  const index = Number(raw);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) return 0;
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

function checkedBlock(block: { number: bigint | null; hash: Hex | null; timestamp: bigint; gasLimit?: bigint }): BlockRef & { gasLimit?: bigint } {
  if (block.number === null || block.hash === null || block.timestamp < 0n) throw new Error("Notification block metadata is incomplete.");
  const gasLimit = Reflect.get(block, "gasLimit");
  if (gasLimit !== undefined && (typeof gasLimit !== "bigint" || gasLimit <= 0n)) throw new Error("Notification block gas limit is invalid.");
  return { number: block.number, hash: block.hash, timestamp: block.timestamp, ...(typeof gasLimit === "bigint" ? { gasLimit } : {}) };
}

function baseReport(activationBlock: string, finalizedBlock: string, next: bigint): NotificationRunReport {
  return {
    status: "idle", activationBlock, finalizedBlock, ingestedPages: 0, ingestedEvents: 0,
    checkedEvents: 0, sends: 0, accepted: 0, pending: 0, reconciliationRequired: 0,
    ingestionNextBlock: next.toString(), retryNextBlock: next.toString(), ingestion: { status: "idle" }
  };
}

function ingestionFailureReason(error: unknown): IngestionFailureReason {
  if (error instanceof NotificationRangeTooDenseError) return "range-too-dense";
  if (error instanceof NotificationReadBudgetError) return "rpc-budget-exhausted";
  if (error instanceof NotificationRpcTimeoutError) return "rpc-timeout";
  return "source-unavailable";
}

async function writeLatestIncident(
  store: Store,
  prefix: string,
  incident: NonNullable<NotificationRunReport["lastIncident"]>
): Promise<void> {
  await store.set(`${prefix}:latest-incident`, JSON.stringify({ version: 1, ...incident }));
}

async function readLatestIncident(store: Store, prefix: string): Promise<NotificationRunReport["lastIncident"]> {
  const raw = await store.get(`${prefix}:latest-incident`);
  if (raw === null) return undefined;
  const value = parseObject(raw, "Notification incident record is invalid.");
  const id = Reflect.get(value, "id");
  const kind = Reflect.get(value, "kind");
  const reason = Reflect.get(value, "reason");
  if (
    Reflect.get(value, "version") !== 1 || typeof id !== "string" || typeof reason !== "string"
    || (kind !== "ingestion" && kind !== "delivery" && kind !== "reconciliation")
  ) throw new Error("Notification incident record is invalid.");
  return { id, kind, reason };
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

async function within<T>(operation: () => Promise<T>, milliseconds: number): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new NotificationRpcTimeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NotificationRpcTimeoutError()), milliseconds); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
