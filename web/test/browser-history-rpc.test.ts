import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, numberToHex, toBytes, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { browserReadTransport } from "../lib/chain/history-rpc";
import { createReader } from "../lib/chain/reader";
import { createSellerReader } from "../lib/chain/seller-reader";
import type { BlockRef, DeploymentManifest } from "../lib/chain/types";
import { fixtureTrust } from "./fixtures/deployment";

const LABX = "0x1111111111111111111111111111111111111111";
const USDC = "0x2222222222222222222222222222222222222222";
const BUYER = "0x4444444444444444444444444444444444444444";
const CODE = "0x600160005260206000f3";
const DEPLOYMENT = 11_865_781n;
const HEAD = 11_942_999n;
/** publicnode's US servers answer eth_getLogs from below this block with "pruned history unavailable". */
const PRUNED_BELOW = HEAD - 25_000n;
const DENSE_FROM = HEAD - 9_000n;
const OLD = DEPLOYMENT + 14_482n;
const RECENT = [HEAD - 1_500n, HEAD - 10n];
const REVEAL = PRUNED_BELOW - 3_000n;

const hashes = new Map<Hex, bigint>();
function blockHash(number: bigint) {
  const value = keccak256(toBytes(`block-${number}`));
  hashes.set(value, number);
  return value;
}
const blockTime = (number: bigint) => 1_800_000_000n + number * 12n;
const blockAt = (number: bigint): BlockRef => ({ number, hash: blockHash(number), timestamp: blockTime(number) });
const rpcBlock = (number: bigint) => ({ number: numberToHex(number), hash: blockHash(number), timestamp: numberToHex(blockTime(number)) });

function eventLog(block: bigint, topics: Hex[], data: Hex) {
  return { address: LABX, topics, data, blockNumber: numberToHex(block), blockHash: blockHash(block), transactionHash: keccak256(toBytes(`tx-${block}`)), transactionIndex: "0x0", logIndex: "0x0", removed: false };
}
const purchase = (block: bigint) => eventLog(block, encodeEventTopics({ abi: raffleAbi, eventName: "PackPurchased", args: { id: 7n, buyer: BUYER } }) as Hex[],
  encodeAbiParameters([{ type: "uint8" }, { type: "uint32" }, { type: "uint32" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }], [1, 2, 6, 50_000_000n, 2_500_000n, false]));
const reveal = (block: bigint) => eventLog(block, encodeEventTopics({ abi: raffleAbi, eventName: "Revealed", args: { id: 7n } }) as Hex[],
  encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keccak256(toBytes("public")), keccak256(toBytes("private"))]));
const LOGS = [purchase(OLD), ...RECENT.map(purchase), reveal(REVEAL)];

type Filter = { fromBlock: Hex; toBlock: Hex; topics?: readonly (Hex | readonly Hex[] | null)[] };
function logsIn(filter: Filter) {
  const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
  return LOGS.filter(log => BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to
    && (filter.topics ?? []).every((topic, index) => topic === null || (Array.isArray(topic) ? topic.includes(log.topics[index]) : topic === log.topics[index])));
}

const calls: { node: string; method: string; params: readonly unknown[] }[] = [];
/** A JSON-RPC node over HTTP. A thrown error is answered as a JSON-RPC error with its message, code -32000 unless it has one, as publicnode answers pruned logs. */
function node(name: string, answer: (method: string, params: readonly unknown[]) => unknown) {
  return createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: readonly unknown[] };
      calls.push({ node: name, method, params });
      let body: object;
      try { body = { jsonrpc: "2.0", id, result: answer(method, params) }; }
      catch (error) { body = { jsonrpc: "2.0", id, error: { code: (error as { code?: number }).code ?? -32000, message: (error as Error).message } }; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    });
  });
}
const configured = node("configured", (method, params) => {
  switch (method) {
    case "eth_chainId": return numberToHex(11155111);
    case "eth_getBlockByNumber": return rpcBlock(params[0] === "latest" ? HEAD : BigInt(params[0] as Hex));
    case "eth_getBlockByHash": return rpcBlock(hashes.get(params[0] as Hex)!);
    case "eth_getCode": return CODE;
    case "eth_call": {
      const { functionName } = decodeFunctionData({ abi: raffleAbi, data: (params[0] as { data: Hex }).data });
      if (functionName === "contractVersion") return encodeFunctionResult({ abi: raffleAbi, functionName, result: 3n });
      if (functionName === "usdc") return encodeFunctionResult({ abi: raffleAbi, functionName, result: USDC });
      throw new Error(`unexpected call ${functionName}`);
    }
    case "eth_getLogs": {
      const filter = params[0] as Filter;
      if (BigInt(filter.fromBlock) < PRUNED_BELOW) throw new Error("pruned history unavailable");
      if (BigInt(filter.fromBlock) === DENSE_FROM) throw new Error("query returned more than 10000 results");
      return logsIn(filter);
    }
    default: throw new Error(`unexpected method ${method}`);
  }
});
/** How the full-history RPC changes the logs it answers with; unchanged by default. */
let archiveAnswer = (logs: ReturnType<typeof logsIn>): readonly object[] => logs;
const archive = node("archive", (method, params) => {
  if (method !== "eth_getLogs") throw new Error(`the full-history RPC was asked for ${method}`);
  return archiveAnswer(logsIn(params[0] as Filter));
});
/** Answers with an internal error, which viem retries unless told not to. */
const down = node("down", () => { throw Object.assign(new Error("backend unavailable"), { code: -32603 }); });
let urls: Record<"configured" | "archive" | "down", string>;

beforeAll(async () => {
  const servers = { configured, archive, down };
  for (const server of Object.values(servers)) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  urls = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, `http://127.0.0.1:${(server.address() as AddressInfo).port}`])) as typeof urls;
});
afterAll(async () => { for (const server of [configured, archive, down] as Server[]) await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { calls.length = 0; archiveAnswer = logs => logs; });

const manifest: DeploymentManifest = { ...fixtureTrust, chainId: 11155111, address: LABX, runtimeCodeHash: keccak256(CODE), version: 3, deploymentBlock: DEPLOYMENT, usdc: USDC };
/** The browser's public client, as browser.ts builds it, over the stub nodes. */
const client = (history: "archive" | "down" | null) => createPublicClient({ transport: browserReadTransport(urls.configured, history && urls[history]) });
const reader = (history: "archive" | "down" | null) => createReader(client(history), manifest);
const sellerActivity = (history: "archive" | "down" | null) => createSellerReader(client(history), manifest, {
  checkedBlock: async () => blockAt(HEAD), readRaffle: vi.fn(), listRaffles: vi.fn()
});
const logReads = () => calls.filter(call => call.method === "eth_getLogs").map(call => call.node);
const headerReads = (number: bigint) => calls.filter(call => call.method === "eth_getBlockByNumber" && call.params[0] === numberToHex(number)).map(call => call.node);

describe("browser log reads past publicnode's pruned history", () => {
  it("reads an old Profile history page through the full-history RPC once, with block checks on the configured RPC", async () => {
    const page = await reader("archive").history({ account: BUYER, toBlock: OLD + 1_000n });

    expect(page.items.map(item => item.blockNumber)).toEqual([OLD]);
    expect(logReads()).toEqual(["configured", "archive"]);
    expect(calls.filter(call => call.node === "archive").map(call => call.method)).toEqual(["eth_getLogs"]);
    expect(headerReads(OLD)).toEqual(["configured"]);
  });

  it("checks each block of the full-history logs once against the configured RPC", async () => {
    archiveAnswer = logs => logs.flatMap(log => [log, { ...log, logIndex: "0x1" }]);

    const page = await reader("archive").history({ account: BUYER, toBlock: OLD + 1_000n });

    expect(page.items.map(item => item.blockNumber)).toEqual([OLD, OLD]);
    expect(headerReads(OLD)).toEqual(["configured"]);
  });

  it.each<{ name: string; change: (log: object) => object }>([
    { name: "a block hash the configured RPC does not have", change: (log: object) => ({ ...log, blockHash: keccak256(toBytes("other-fork")) }) },
    { name: "another contract's address", change: (log: object) => ({ ...log, address: USDC }) },
    { name: "a block outside the requested range", change: (log: object) => ({ ...log, blockNumber: numberToHex(OLD + 5_000n), blockHash: blockHash(OLD + 5_000n) }) },
    { name: "a removed log", change: (log: object) => ({ ...log, removed: true }) }
  ])("rejects an old Profile history page when the full-history RPC answers with $name", async ({ change }) => {
    archiveAnswer = logs => logs.map(change);

    await expect(reader("archive").history({ account: BUYER, toBlock: OLD + 1_000n })).rejects.toThrow("Older activity from the full-history RPC did not match this network.");

    expect(logReads()).toEqual(["configured", "archive"]);
  });

  it("rejects an old Sales and payouts page whose full-history log is on another fork", async () => {
    archiveAnswer = logs => logs.map(log => ({ ...log, blockHash: keccak256(toBytes("other-fork")) }));

    await expect(sellerActivity("archive").listRaffleActivity({ id: 7n, cursor: OLD + 1_000n })).rejects.toThrow("Older activity from the full-history RPC did not match this network.");
  });

  it("keeps a recent page on the configured RPC", async () => {
    const page = await reader("archive").history({ account: BUYER });

    expect(page.items.map(item => item.blockNumber)).toEqual([...RECENT].reverse());
    expect(logReads()).toEqual(["configured"]);
  });

  it("finds a reveal time whose logs the configured RPC has pruned", async () => {
    await expect(reader("archive").readRevealTime({ id: 7n, block: blockAt(PRUNED_BELOW + 1_000n) })).resolves.toBe(blockTime(REVEAL));

    expect(logReads()).toEqual(["configured", "archive", "configured", "archive", "configured", "archive"]);
    expect(calls.filter(call => call.node === "archive").every(call => call.method === "eth_getLogs")).toBe(true);
  });

  it("reads an old Sales and payouts page through the full-history RPC", async () => {
    const page = await sellerActivity("archive").listRaffleActivity({ id: 7n, cursor: OLD + 1_000n });

    expect(page.items.map(item => item.blockNumber)).toEqual([OLD]);
    expect(logReads()).toEqual(["configured", "archive"]);
  });

  it("keeps a range-size error from the configured RPC", async () => {
    await expect(reader("archive").history({ account: BUYER, toBlock: DENSE_FROM + 1_999n })).rejects.toThrow(/more than 10000 results/);

    expect(logReads()).toEqual(["configured"]);
  });

  it("makes one attempt at the full-history RPC, with no retry", async () => {
    await expect(reader("down").history({ account: BUYER, toBlock: OLD + 1_000n })).rejects.toThrow(/backend unavailable/);

    expect(logReads()).toEqual(["configured", "down"]);
  });

  it("reports the pruned error unchanged when there is no full-history RPC", async () => {
    await expect(reader(null).history({ account: BUYER, toBlock: OLD + 1_000n })).rejects.toThrow(/pruned history unavailable/);

    expect(logReads()).toEqual(["configured"]);
  });
});

describe("checking a dense page of old logs", () => {
  const LIMIT = 4;
  /**
   * Reads a page of two logs in each of `blocks` old blocks from a configured RPC that has pruned every log, serves block headers
   * in 10 ms and refuses, without a retryable code, any header read beyond LIMIT at once or for the `broken` block.
   */
  async function denseRead(blocks: number, broken: bigint | null = null) {
    let active = 0, maximum = 0, headers = 0;
    const dense = createServer((request, response) => {
      let raw = "";
      request.on("data", chunk => { raw += chunk; });
      request.on("end", () => {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: [Hex] };
        response.setHeader("content-type", "application/json");
        if (method === "eth_getLogs") return void response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "pruned history unavailable" } }));
        headers++; active++; maximum = Math.max(maximum, active);
        const refused = active > LIMIT || BigInt(params[0]) === broken;
        setTimeout(() => {
          active--;
          response.end(JSON.stringify(refused ? { jsonrpc: "2.0", id, error: { code: -32000, message: "too many concurrent requests" } } : { jsonrpc: "2.0", id, result: rpcBlock(BigInt(params[0])) }));
        }, 10);
      });
    });
    await new Promise<void>(resolve => dense.listen(0, "127.0.0.1", resolve));
    archiveAnswer = () => Array.from({ length: blocks }, (_, index) => purchase(OLD + BigInt(index))).flatMap(log => [log, { ...log, logIndex: "0x1" }]);
    try {
      const page = createPublicClient({ transport: browserReadTransport(`http://127.0.0.1:${(dense.address() as AddressInfo).port}`, urls.archive) })
        .request({ method: "eth_getLogs", params: [{ address: LABX, fromBlock: numberToHex(OLD), toBlock: numberToHex(OLD + 1_999n) }] });
      const logs = await page.catch((error: Error) => error);
      // Header reads still running after the page settles would show up here.
      await new Promise(resolve => setTimeout(resolve, 50));
      return { logs, maximum, headers };
    } finally { dense.closeAllConnections(); await new Promise(resolve => dense.close(resolve)); }
  }

  it("checks a valid page across 64 blocks without more header reads at once than the configured RPC allows", async () => {
    const read = await denseRead(64);

    expect(read.logs).toHaveLength(128);
    expect(read.maximum).toBeLessThanOrEqual(LIMIT);
    expect(read.headers).toBe(64);
  });

  it("stops reading headers once one fails", async () => {
    const read = await denseRead(64, OLD + 63n);

    expect(read.logs).toBeInstanceOf(Error);
    expect(read.headers).toBeLessThanOrEqual(2 * LIMIT);
  });
});

describe("Sales and payouts", () => {
  it("reads the newest page first, so the first page needs no old history", async () => {
    const page = await sellerActivity(null).listRaffleActivity({ id: 7n });

    expect(page.items.map(item => item.blockNumber)).toEqual([...RECENT].reverse());
    expect(page.nextCursor).toBe(HEAD - 2_000n);
    expect(logReads()).toEqual(["configured"]);
  });

  it("pages back to the deployment block, newest first", async () => {
    const activity = sellerActivity("archive");
    const blocks: bigint[] = [];
    let cursor: bigint | undefined;
    do {
      const page = await activity.listRaffleActivity({ id: 7n, cursor });
      blocks.push(...page.items.map(item => item.blockNumber));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(blocks).toEqual([...RECENT].reverse().concat(OLD));
    expect(logReads().filter(name => name === "configured")).toHaveLength(Number((HEAD - DEPLOYMENT) / 2_000n) + 1);
  });
});
