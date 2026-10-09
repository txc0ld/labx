import {
  decodeEventLog,
  isAddress,
  isHex,
  parseAbiItem,
  type Address,
  type Hex
} from "viem";
import { serverWorkflow } from "../chain/server";
import type { BlockRef, DeploymentManifest } from "../chain/types";
import { sameAddress } from "../chain/validation";

const MAX_BLOCK_RANGE = 500n;
const MAX_LOGS_PER_RANGE = 100;
const MAX_CANONICAL_BLOCKS = 25;
const MAX_LOG_REQUESTS = 32;
const createdEvent = parseAbiItem("event RaffleCreated(uint256 indexed id, address indexed seller, address indexed nft, uint256 tokenId, bytes32 reserveCommit)");
const openedEvent = parseAbiItem("event Opened(uint256 indexed id)");
const notificationAbi = [createdEvent, openedEvent] as const;

export type NotificationEvent = {
  kind: "draft-created" | "sales-opened";
  eventName: "RaffleCreated" | "Opened";
  label: "Draft awaiting review" | "Raffle live";
  raffleId: string;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  occurredAt: string;
  href: string;
};

export type VerifiedEventPage = {
  events: readonly NotificationEvent[];
  range: { fromBlock: bigint; toBlock: bigint };
  finalized: BlockRef;
};

export type NotificationChainReader = {
  getChainId(): Promise<number>;
  getBlock(args: { blockTag: "finalized" } | { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
  getLogs(args: { address: Address; events: typeof notificationAbi; fromBlock: bigint; toBlock: bigint; strict: false }): Promise<readonly unknown[]>;
};
export type NotificationWorkflow = {
  context: { chainId: number; contract: Address; origin: string };
  manifest: DeploymentManifest;
  client: NotificationChainReader;
  block: BlockRef;
};

export class NotificationRangeTooDenseError extends Error {
  constructor() { super("Notification event range is too dense."); }
}

export function parseNotificationEvent(value: unknown): NotificationEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Notification event record is invalid.");
  const kind = Reflect.get(value, "kind");
  const eventName = Reflect.get(value, "eventName");
  const label = Reflect.get(value, "label");
  const raffleId = Reflect.get(value, "raffleId");
  const blockNumber = Reflect.get(value, "blockNumber");
  const blockHash = Reflect.get(value, "blockHash");
  const transactionHash = Reflect.get(value, "transactionHash");
  const transactionIndex = Reflect.get(value, "transactionIndex");
  const logIndex = Reflect.get(value, "logIndex");
  const occurredAt = Reflect.get(value, "occurredAt");
  const href = Reflect.get(value, "href");
  const idValid = typeof raffleId === "string" && /^[1-9]\d{0,77}$/.test(raffleId);
  const blockValid = typeof blockNumber === "string" && /^(0|[1-9]\d{0,77})$/.test(blockNumber);
  const timeValid = typeof occurredAt === "string" && !Number.isNaN(Date.parse(occurredAt)) && new Date(occurredAt).toISOString() === occurredAt;
  const draft = kind === "draft-created" && eventName === "RaffleCreated" && label === "Draft awaiting review" && idValid && href === `/review/${raffleId}`;
  const opened = kind === "sales-opened" && eventName === "Opened" && label === "Raffle live" && idValid && href === `/piece/${raffleId}`;
  if (
    (!draft && !opened) || !blockValid || !isHash(blockHash) || !isHash(transactionHash)
    || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0
    || !Number.isSafeInteger(logIndex) || logIndex < 0 || !timeValid
  ) throw new Error("Notification event record is invalid.");
  return draft
    ? { kind, eventName, label, raffleId, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, occurredAt, href }
    : { kind, eventName, label, raffleId, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, occurredAt, href };
}

type RawLog = {
  address: Address;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  removed: false;
  data: Hex;
  topics: readonly [Hex, ...Hex[]];
};

export async function readFinalizedEvents(args: {
  fromBlock: bigint;
  toBlock: bigint;
  workflow?: () => Promise<NotificationWorkflow>;
}): Promise<VerifiedEventPage> {
  const workflow = await (args.workflow ?? defaultWorkflow)();
  requireApprovedWorkflow(workflow);
  if (await workflow.client.getChainId() !== workflow.manifest.chainId) throw new Error("Notification RPC network is invalid.");
  if (
    args.fromBlock < workflow.manifest.deploymentBlock
    || args.toBlock < args.fromBlock
    || args.toBlock - args.fromBlock + 1n > MAX_BLOCK_RANGE
  ) throw new Error("Notification block range is invalid or too large.");

  const finalized = await readBlock(workflow.client, { blockTag: "finalized" });
  if (finalized.number > workflow.block.number || args.toBlock > finalized.number) {
    throw new Error("Notification range is not finalized.");
  }

  const budget = { remaining: MAX_LOG_REQUESTS };
  const rawLogs = await fetchLogs(workflow.client, workflow.manifest.address, args.fromBlock, args.toBlock, budget);
  if (rawLogs.length > MAX_LOGS_PER_RANGE) {
    if (args.fromBlock === args.toBlock) throw new Error("A finalized block exceeds the notification log limit.");
    throw new NotificationRangeTooDenseError();
  }
  const parsed = rawLogs.map(parseRawLog);
  if (parsed.some(log => log.blockNumber < args.fromBlock || log.blockNumber > args.toBlock)) {
    throw new Error("Notification log is outside the requested range.");
  }
  const blockNumbers = [...new Set(parsed.map(log => log.blockNumber))];
  if (blockNumbers.length > MAX_CANONICAL_BLOCKS) throw new NotificationRangeTooDenseError();
  const blocks = new Map<bigint, BlockRef>();
  const results = await Promise.all(blockNumbers.map(number => readBlock(workflow.client, { blockNumber: number })));
  results.forEach((block, index) => blocks.set(blockNumbers[index]!, block));

  const seen = new Set<string>();
  const decoded = parsed.map(log => {
    if (!sameAddress(log.address, workflow.manifest.address)) throw new Error("Notification log contract is invalid.");
    const canonical = blocks.get(log.blockNumber);
    if (!canonical || !sameHex(canonical.hash, log.blockHash)) throw new Error("Notification log block is not canonical.");
    const identity = `${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    if (seen.has(identity)) throw new Error("Notification log is duplicated.");
    seen.add(identity);
    const decodedLog = decodeNotificationLog(log);
    const id = decodedLog.id;
    if (typeof id !== "bigint" || id <= 0n) throw new Error("Notification raffle ID is invalid.");
    return { log, eventName: decodedLog.eventName, id, timestamp: canonical.timestamp };
  });

  const recheckedFinalized = await readBlock(workflow.client, { blockTag: "finalized" });
  if (recheckedFinalized.number !== finalized.number || !sameHex(recheckedFinalized.hash, finalized.hash)) {
    throw new Error("The pinned finalized head changed during the notification read.");
  }

  decoded.sort((left, right) => {
    if (left.log.blockNumber !== right.log.blockNumber) return left.log.blockNumber < right.log.blockNumber ? -1 : 1;
    if (left.log.transactionIndex !== right.log.transactionIndex) return left.log.transactionIndex - right.log.transactionIndex;
    return left.log.logIndex - right.log.logIndex;
  });
  return {
    events: decoded.map(({ log, eventName, id, timestamp }) => publicEvent(eventName, id, log, timestamp)),
    range: { fromBlock: args.fromBlock, toBlock: args.toBlock },
    finalized
  };
}

async function defaultWorkflow(): Promise<NotificationWorkflow> {
  return notificationWorkflow();
}

export async function notificationWorkflow(): Promise<NotificationWorkflow> {
  return adaptNotificationWorkflow(await serverWorkflow());
}

export function adaptNotificationWorkflow(workflow: Awaited<ReturnType<typeof serverWorkflow>>): NotificationWorkflow {
  return {
    context: workflow.context,
    manifest: workflow.manifest,
    block: workflow.block,
    client: {
      getChainId: () => workflow.client.getChainId(),
      async getBlock(args) {
        const block = "blockTag" in args
          ? await workflow.client.getBlock({ blockTag: args.blockTag })
          : await workflow.client.getBlock({ blockNumber: args.blockNumber });
        return { number: block.number, hash: block.hash, timestamp: block.timestamp };
      },
      async getLogs(args) {
        return workflow.client.getLogs(args);
      }
    }
  };
}

function requireApprovedWorkflow(workflow: NotificationWorkflow): void {
  if (
    workflow.context.chainId !== workflow.manifest.chainId
    || !sameAddress(workflow.context.contract, workflow.manifest.address)
  ) throw new Error("Notification deployment context is invalid.");
}

async function fetchLogs(
  client: NotificationChainReader,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
  budget: { remaining: number }
): Promise<readonly unknown[]> {
  if (budget.remaining < 1) throw new Error("Notification log read budget was exhausted.");
  budget.remaining -= 1;
  let logs: readonly unknown[];
  try {
    logs = await client.getLogs({ address, events: notificationAbi, fromBlock, toBlock, strict: false });
  } catch {
    return splitOrFail(client, address, fromBlock, toBlock, budget);
  }
  if (logs.length <= MAX_LOGS_PER_RANGE) return logs;
  return splitOrFail(client, address, fromBlock, toBlock, budget);
}

async function splitOrFail(
  client: NotificationChainReader,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
  budget: { remaining: number }
): Promise<readonly unknown[]> {
  if (fromBlock === toBlock) throw new Error("A finalized block exceeds the notification log limit.");
  const midpoint = fromBlock + (toBlock - fromBlock) / 2n;
  const left = await fetchLogs(client, address, fromBlock, midpoint, budget);
  const right = await fetchLogs(client, address, midpoint + 1n, toBlock, budget);
  return [...left, ...right];
}

function parseRawLog(value: unknown): RawLog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Notification log metadata is incomplete.");
  const address = Reflect.get(value, "address");
  const blockNumber = Reflect.get(value, "blockNumber");
  const blockHash = Reflect.get(value, "blockHash");
  const transactionHash = Reflect.get(value, "transactionHash");
  const transactionIndex = Reflect.get(value, "transactionIndex");
  const logIndex = Reflect.get(value, "logIndex");
  const removed = Reflect.get(value, "removed");
  const data = Reflect.get(value, "data");
  const topics = Reflect.get(value, "topics");
  if (
    typeof address !== "string" || !isAddress(address)
    || typeof blockNumber !== "bigint" || blockNumber < 0n
    || !isHash(blockHash) || !isHash(transactionHash)
    || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0
    || !Number.isSafeInteger(logIndex) || logIndex < 0
    || removed !== false
    || typeof data !== "string" || !isHex(data, { strict: true })
    || !Array.isArray(topics) || topics.length === 0 || topics.some(topic => !isHash(topic))
  ) throw new Error("Notification log metadata is incomplete.");
  const [firstTopic, ...remainingTopics] = topics;
  if (!firstTopic) throw new Error("Notification log metadata is incomplete.");
  return {
    address,
    blockNumber,
    blockHash,
    transactionHash,
    transactionIndex,
    logIndex,
    removed,
    data,
    topics: [firstTopic, ...remainingTopics]
  };
}

function decodeNotificationLog(log: RawLog): { eventName: "RaffleCreated" | "Opened"; id: bigint } {
  try {
    const decoded = decodeEventLog({ abi: notificationAbi, data: log.data, topics: [...log.topics], strict: true });
    if (decoded.eventName === "RaffleCreated") return { eventName: decoded.eventName, id: decoded.args.id };
    if (decoded.eventName === "Opened") return { eventName: decoded.eventName, id: decoded.args.id };
    throw new Error();
  } catch {
    throw new Error("Notification log does not match the reviewed contract ABI.");
  }
}

async function readBlock(
  client: NotificationChainReader,
  args: { blockTag: "finalized" } | { blockNumber: bigint }
): Promise<BlockRef> {
  const block = "blockTag" in args
    ? await client.getBlock({ blockTag: args.blockTag })
    : await client.getBlock({ blockNumber: args.blockNumber });
  if (block.number === null || block.hash === null || block.timestamp < 0n) throw new Error("Notification block metadata is incomplete.");
  if ("blockNumber" in args && block.number !== args.blockNumber) throw new Error("Notification block number is invalid.");
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}

function publicEvent(eventName: "RaffleCreated" | "Opened", id: bigint, log: RawLog, timestamp: bigint): NotificationEvent {
  const milliseconds = Number(timestamp) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Notification event time is invalid.");
  const common = {
    raffleId: id.toString(),
    blockNumber: log.blockNumber.toString(),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    occurredAt: new Date(milliseconds).toISOString()
  };
  return eventName === "RaffleCreated"
    ? { ...common, kind: "draft-created", eventName, label: "Draft awaiting review", href: `/review/${id}` }
    : { ...common, kind: "sales-opened", eventName, label: "Raffle live", href: `/piece/${id}` };
}

function isHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
