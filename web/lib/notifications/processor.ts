import type { Hex } from "viem";
import { serverWorkflow } from "../chain/server";
import type { BlockRef } from "../chain/types";
import type { Store } from "../points";
import type { MailSender } from "../receipt-delivery";
import { deliverNotification, NotificationSendCapacityError } from "./delivery";
import { adaptNotificationWorkflow, createNotificationReadBudget, NotificationRangeTooDenseError, NotificationReadBudgetError, NotificationRpcTimeoutError, parseNotificationEvent, readFinalizedEvents, type NotificationEvent, type NotificationWorkflow, type VerifiedEventPage } from "./events";

const PAGE_BLOCKS = 250n;
const MAX_INGESTION_PAGES = 2;
const MAX_RETRY_PAGES = 4;
const MAX_EVENT_CHECKS = 400;
const TERMINAL_CHECKPOINT_EVENTS = 32;
const MAX_SENDS = 3;
const DELIVERY_RUNTIME_MS = 31_000;
// Includes progress-proof reads and page persistence as well as source calls.
const INGESTION_RUNTIME_MS = 18_000;
const RESPONSE_MARGIN_MS = 1_000;
const SOURCE_CALL_MS = 6_000;
const MAIL_SEND_RUNTIME_MS = 10_000;
const PROCESSOR_RUNTIME_MS = 43_000;
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
  events(fromBlock: bigint, toBlock: bigint, deadline: number): Promise<VerifiedEventPage>;
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
  processingFailures: number;
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
    async events(fromBlock, toBlock, deadline) {
      const budget = createNotificationReadBudget();
      budget.deadline = Math.min(budget.deadline, deadline);
      return readFinalizedEvents({ fromBlock, toBlock, workflow: pinnedWorkflow, budget });
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
  deadline?: number;
}): Promise<NotificationRunReport> {
  const now = args.now ?? Date.now();
  const deliveryClock = args.clock ?? (args.now === undefined ? Date.now : () => now);
  const requestDeadline = args.deadline ?? Date.now() + PROCESSOR_RUNTIME_MS;
  if (!Number.isSafeInteger(requestDeadline) || requestDeadline <= Date.now()) {
    throw new Error("Notification processing deadline is invalid.");
  }
  const requestStore = deadlineStore(args.store, requestDeadline);
  const workDeadline = requestDeadline - Math.min(RESPONSE_MARGIN_MS, Math.floor((requestDeadline - Date.now()) / 10));
  const prefix = `raffle-notifications:v1:${args.source.deployment}`;
  const activationKey = `${prefix}:activation`;
  const activationCandidate: StoredActivation = {
    version: 1,
    deployment: args.source.deployment,
    blockNumber: args.source.latest.number.toString(),
    blockHash: args.source.latest.hash
  };
  const createdActivation = await requestStore.setIfAbsent({ [activationKey]: JSON.stringify(activationCandidate) });
  const activationRaw = await requestStore.get(activationKey);
  if (activationRaw === null) throw new Error("Notification activation was not persisted.");
  const activation = parseActivation(activationRaw, args.source.deployment);
  const activationBlock = BigInt(activation.blockNumber);
  const firstEventBlock = activationBlock + 1n;
  const empty = baseReport(activation.blockNumber, activation.blockNumber, firstEventBlock);
  if (createdActivation) return { ...empty, status: "activated" };

  const terminalKey = `${prefix}:activation-reconciliation`;
  const existingTerminal = await requestStore.get(terminalKey);
  if (existingTerminal !== null) {
    parseActivationReconciliation(existingTerminal);
    return { ...empty, status: "reconciliation-required", reconciliation: "The activation boundary needs reconciliation." };
  }

  const verifiedBoundaryKey = `${prefix}:activation-verified`;
  const verifiedBoundary = await requestStore.get(verifiedBoundaryKey);
  if (verifiedBoundary === null) {
    const finalized = await withinDeadline(() => args.source.finalized(), SOURCE_CALL_MS, requestDeadline);
    empty.finalizedBlock = finalized.number.toString();
    if (finalized.number < activationBlock) return { ...empty, status: "idle" };
    const boundary = await withinDeadline(() => args.source.block(activationBlock), SOURCE_CALL_MS, requestDeadline);
    if (boundary.hash.toLowerCase() !== activation.blockHash.toLowerCase()) {
      const marker = JSON.stringify({ version: 1, reason: "activation-boundary-changed", recordedAt: now });
      await requestStore.setIfAbsent({ [terminalKey]: marker });
      return { ...empty, status: "reconciliation-required", reconciliation: "The activation boundary changed and needs reconciliation." };
    }
    await requestStore.setIfAbsent({ [verifiedBoundaryKey]: JSON.stringify({ version: 1, blockNumber: activation.blockNumber, blockHash: activation.blockHash }) });
  } else {
    parseVerifiedBoundary(verifiedBoundary, activation);
  }

  const ingestionHintKey = `${prefix}:ingestion-hint`;
  const retryHintKey = `${prefix}:retry-hint`;
  const lastPageKey = `${prefix}:last-ingested-page`;
  const retryStarted = Date.now();
  const delivery: DeliveryState = {
    deadline: minimumDeadline(retryStarted + DELIVERY_RUNTIME_MS, workDeadline - INGESTION_RUNTIME_MS),
    remainingRuntime: DELIVERY_RUNTIME_MS,
    checkedEvents: 0,
    sends: 0,
    accepted: 0,
    pending: 0,
    processingFailures: 0,
    reconciliationRequired: 0,
    retryNext: firstEventBlock
  };
  const retryStore = deadlineStore(requestStore, delivery.deadline);
  let retryStarts: bigint[] = [];
  try {
    delivery.retryNext = await verifiedProgressHint(retryStore, await retryStore.get(retryHintKey), firstEventBlock, prefix, "retry");
    retryStarts = await retryPageStarts(retryStore, prefix, delivery.retryNext);
    const lastPage = parseOptionalHint(await retryStore.get(lastPageKey));
    if (lastPage !== null && !retryStarts.includes(lastPage)) retryStarts.push(lastPage);
    delivery.lastIncident = await readLatestIncident(retryStore, prefix);
    await processDeliveryPages({ ...args, store: retryStore }, prefix, retryStarts, delivery, now, deliveryClock);
  } catch (error) {
    if (!(error instanceof NotificationRuntimeDeadlineError)) throw error;
    delivery.processingFailures += 1;
  }
  delivery.remainingRuntime = remainingRuntime(delivery.remainingRuntime, retryStarted);

  let ingestionStart = firstEventBlock;
  let ingestedPages = 0;
  let ingestedEvents = 0;
  const ingestedStarts: bigint[] = [];
  let ingestion: NotificationRunReport["ingestion"] = { status: "idle" };
  const ingestionDeadline = minimumDeadline(Date.now() + INGESTION_RUNTIME_MS, workDeadline);
  const ingestionStore = deadlineStore(requestStore, ingestionDeadline);
  let finalizedBlock = activation.blockNumber;
  let progressVerified = false;
  try {
    ingestionStart = await verifiedProgressHint(ingestionStore, await ingestionStore.get(ingestionHintKey), firstEventBlock, prefix, "ingestion");
    progressVerified = true;
    const finalized = await withinDeadline(() => args.source.finalized(), SOURCE_CALL_MS, ingestionDeadline);
    finalizedBlock = finalized.number.toString();
    if (finalized.number < activationBlock) throw new Error("Finalized height regressed below activation.");
    while (ingestionStart <= finalized.number && ingestedPages < MAX_INGESTION_PAGES && Date.now() < ingestionDeadline) {
      const requestedEnd = minimum(ingestionStart + PAGE_BLOCKS - 1n, finalized.number);
      const page = await loadOrCreatePage(ingestionStore, args.source, prefix, ingestionStart, finalized.number, ingestionDeadline);
      await ingestionStore.set(ingestionHintKey, page.nextBlock);
      await ingestionStore.set(lastPageKey, page.startBlock);
      ingestionStart = BigInt(page.nextBlock);
      ingestedStarts.push(BigInt(page.startBlock));
      ingestedPages += 1;
      ingestedEvents += page.events.length;
      ingestion = { status: "advanced", fromBlock: page.startBlock, toBlock: page.actualEnd };
      await ingestionStore.set(`${prefix}:ingestion-status`, JSON.stringify({ version: 1, state: "advanced", nextBlock: page.nextBlock, recordedAt: now }));
      if (BigInt(page.actualEnd) < requestedEnd) break;
    }
  } catch (error) {
    if (!progressVerified && !(error instanceof NotificationRuntimeDeadlineError)) throw error;
    const reason = ingestionFailureReason(error);
    const incident = `${prefix}:incident:ingestion:${ingestionStart}`;
    const marker = JSON.stringify({ version: 1, kind: "ingestion", reason, fromBlock: ingestionStart.toString(), recordedAt: now });
    ingestion = { status: "blocked", fromBlock: ingestionStart.toString(), reason };
    try {
      await requestStore.setIfAbsent({ [incident]: marker });
      ingestion.incident = incident;
      await requestStore.set(`${prefix}:ingestion-status`, marker);
      const summary = { id: incident, kind: "ingestion" as const, reason };
      await writeLatestIncident(requestStore, prefix, summary);
      delivery.lastIncident = summary;
    } catch {
      // Report the failure even if the request has no time to persist diagnostics.
    }
  }

  const freshStarts = ingestedStarts.filter(start => !retryStarts.includes(start));
  delivery.deadline = minimumDeadline(Date.now() + delivery.remainingRuntime, workDeadline);
  try {
    await processDeliveryPages({ ...args, store: deadlineStore(requestStore, delivery.deadline) }, prefix, freshStarts, delivery, now, deliveryClock);
  } catch (error) {
    if (!(error instanceof NotificationRuntimeDeadlineError)) throw error;
    delivery.processingFailures += 1;
  }

  return {
    status: ingestion.status === "blocked" || delivery.processingFailures > 0
      ? "degraded"
      : delivery.reconciliationRequired ? "reconciliation-required" : ingestedPages || delivery.checkedEvents ? "ok" : "idle",
    activationBlock: activation.blockNumber,
    finalizedBlock,
    ingestedPages,
    ingestedEvents,
    checkedEvents: delivery.checkedEvents,
    sends: delivery.sends,
    accepted: delivery.accepted,
    pending: delivery.pending,
    processingFailures: delivery.processingFailures,
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
        const readDeadline = minimumDeadline(Date.now() + SOURCE_CALL_MS, deadline);
        candidate = await withinDeadline(() => source.events(start, actualEnd, readDeadline), SOURCE_CALL_MS, readDeadline);
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
      const canonical = verified.singleBlock ?? await withinDeadline(() => source.block(start), SOURCE_CALL_MS, deadline);
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
  remainingRuntime: number;
  checkedEvents: number;
  sends: number;
  accepted: number;
  pending: number;
  processingFailures: number;
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
    if (!canStartDeliveryWork(state)) break;
    const phaseStore = args.store;
    const raw = await phaseStore.get(pageKey(prefix, pageStart));
    if (raw === null) continue;
    const page = parsePage(raw, args.source.deployment, pageStart);
    const resumeKey = `${pageKey(prefix, pageStart)}:resume`;
    let index = parseResume(await phaseStore.get(resumeKey), page.events.length);
    let scanned = 0;
    while (
      scanned < page.events.length
      && state.checkedEvents < MAX_EVENT_CHECKS
      && canStartDeliveryWork(state)
      && state.sends < MAX_SENDS
    ) {
      const event = page.events[index]!;
      try {
        const result = await deliverNotification({
          store: phaseStore,
          canStartSend: () => canStartDeliveryWork(state),
          event,
          deployment: args.source.deployment,
          origin: args.source.origin,
          sender: async (payload, key) => {
            if (!canStartDeliveryWork(state)) {
              state.processingFailures += 1;
              throw new NotificationRuntimeDeadlineError();
            }
            state.sends += 1;
            return withinRuntime(() => args.sender(payload, key), state.deadline);
          },
          from: args.from,
          transportIdentity: args.transportIdentity,
          now,
          clock
        });
        if (result.status === "accepted") {
          state.accepted += 1;
          await markEventTerminal(phaseStore, prefix, pageStart, index);
        } else if (result.status === "pending") state.pending += 1;
        else {
          state.reconciliationRequired += 1;
          await markEventTerminal(phaseStore, prefix, pageStart, index);
          const incident = `${result.key}:reconciliation`;
          const summary = { id: incident, kind: "reconciliation" as const, reason: result.reason };
          await writeLatestIncident(phaseStore, prefix, summary);
          state.lastIncident = summary;
        }
      } catch (error) {
        if (error instanceof NotificationRuntimeDeadlineError || error instanceof NotificationSendCapacityError) {
          state.processingFailures += 1;
          break;
        }
        const incident = `${pageKey(prefix, pageStart)}:event-incident:${index}`;
        const marker = JSON.stringify({ version: 1, kind: "delivery", reason: "processing-failed", blockNumber: event.blockNumber, logIndex: event.logIndex, recordedAt: now });
        const summary = { id: incident, kind: "delivery" as const, reason: "processing-failed" };
        state.processingFailures += 1;
        state.pending += 1;
        try {
          await phaseStore.setIfAbsent({ [incident]: marker });
          await writeLatestIncident(phaseStore, prefix, summary);
          state.lastIncident = summary;
        } catch {
          // The run report remains degraded even when the bounded incident write is uncertain.
        }
      }
      state.checkedEvents += 1;
      scanned += 1;
      index = page.events.length === 0 ? 0 : (index + 1) % page.events.length;
      try {
        await phaseStore.set(resumeKey, index.toString());
      } catch {
        state.processingFailures += 1;
        break;
      }
    }
    const terminalPrefix = await advanceTerminalPrefix(phaseStore, prefix, pageStart, page.events.length, state.deadline);
    const allTerminal = terminalPrefix === page.events.length;
    if (pageStart === state.retryNext && allTerminal) {
      const proofKey = `${prefix}:retry-proof:${page.nextBlock}`;
      await phaseStore.setIfAbsent({ [proofKey]: page.startBlock });
      state.retryNext = BigInt(page.nextBlock);
      await phaseStore.set(`${prefix}:retry-hint`, page.nextBlock);
    }
  }
}

function canStartDeliveryWork(state: DeliveryState): boolean {
  return Date.now() + MAIL_SEND_RUNTIME_MS <= state.deadline;
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
  length: number,
  deadline: number
): Promise<number> {
  if (Date.now() >= deadline) return 0;
  const hintKey = `${pageKey(prefix, start)}:terminal-prefix`;
  let prefixLength = await verifiedTerminalPrefix(store, prefix, start, length, await store.get(hintKey));
  let durablePrefix = prefixLength;
  const checkpoint = async () => {
    const proofKey = `${pageKey(prefix, start)}:terminal-proof:${prefixLength}`;
    await store.setIfAbsent({ [proofKey]: "proved" });
    if (await store.get(proofKey) !== "proved") throw new Error("Notification terminal progress proof was not persisted.");
    await store.set(hintKey, prefixLength.toString());
    durablePrefix = prefixLength;
  };
  let checked = 0;
  while (prefixLength < length && checked < MAX_EVENT_CHECKS && Date.now() < deadline) {
    if (await store.get(terminalMarkerKey(prefix, start, prefixLength)) !== "terminal") break;
    prefixLength += 1;
    checked += 1;
    if (checked % TERMINAL_CHECKPOINT_EVENTS === 0) await checkpoint();
  }
  if (prefixLength > durablePrefix && Date.now() < deadline) await checkpoint();
  return durablePrefix;
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
    checkedEvents: 0, sends: 0, accepted: 0, pending: 0, processingFailures: 0, reconciliationRequired: 0,
    ingestionNextBlock: next.toString(), retryNextBlock: next.toString(), ingestion: { status: "idle" }
  };
}

function ingestionFailureReason(error: unknown): IngestionFailureReason {
  if (error instanceof NotificationRangeTooDenseError) return "range-too-dense";
  if (error instanceof NotificationReadBudgetError) return "rpc-budget-exhausted";
  if (error instanceof NotificationRpcTimeoutError || error instanceof NotificationRuntimeDeadlineError) return "rpc-timeout";
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

class NotificationRuntimeDeadlineError extends Error {
  constructor() {
    super("Notification processing deadline was reached.");
    this.name = "NotificationRuntimeDeadlineError";
  }
}

function minimumDeadline(left: number, right: number): number {
  return left < right ? left : right;
}

function remainingRuntime(runtime: number, started: number): number {
  return Math.max(0, runtime - Math.max(0, Date.now() - started));
}

function deadlineStore(store: Store, deadline: number): Store {
  return {
    get: key => withinRuntime(() => store.get(key), deadline),
    set: (key, value) => withinRuntime(() => store.set(key, value), deadline),
    setIfAbsent: entries => withinRuntime(() => store.setIfAbsent(entries), deadline)
  };
}

async function withinDeadline<T>(operation: () => Promise<T>, milliseconds: number, deadline: number): Promise<T> {
  return withinRuntime(operation, minimumDeadline(Date.now() + milliseconds, deadline), () => new NotificationRpcTimeoutError());
}

async function withinRuntime<T>(
  operation: () => Promise<T>,
  deadline: number,
  expired: () => Error = () => new NotificationRuntimeDeadlineError()
): Promise<T> {
  const available = deadline - Date.now();
  if (!Number.isFinite(available) || available <= 0) throw expired();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired()), available); })
    ]);
    if (Date.now() - started > available || Date.now() > deadline) throw expired();
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
