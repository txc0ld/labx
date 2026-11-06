import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublicClient, http, keccak256, numberToHex, toBytes, toHex, type Address, type Hex } from "viem";
import { browserReadTransport, isPrunedHistoryError } from "../lib/chain/history-rpc";
import { NETWORKS } from "../lib/chain/networks";
import { historyClient, type serverWorkflow } from "../lib/chain/server";
import type { DeploymentManifest } from "../lib/chain/types";
import { adaptNotificationWorkflow, readFinalizedEvents } from "../lib/notifications/events";
import { fixtureTrust } from "./fixtures/deployment";

const LABX: Address = "0x1000000000000000000000000000000000000001";
const DEPLOYMENT = 21_000_000n;
const HEAD = 21_200_000n;
/** publicnode's mainnet servers answer eth_getLogs from below this block with an HTTP 403 archive refusal. */
const ARCHIVE_BELOW = HEAD - 40_000n;
const OLD = DEPLOYMENT + 500n;
/** The refusal measured from a Vercel function on 19 October 2026. */
const ARCHIVE_REFUSAL = "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode";

type Refusal = "jsonrpc-403" | "text-403" | "forbidden-403" | "sepolia-pruned" | "range";
let refusal: Refusal = "jsonrpc-403";
const calls: string[] = [];
const blockHash = (number: bigint) => keccak256(toBytes(`mainnet-block-${number}`));
const log = { address: LABX, topics: [keccak256(toBytes("Opened(uint256)"))], data: "0x", blockNumber: numberToHex(OLD), blockHash: blockHash(OLD), transactionHash: keccak256(toBytes("tx")), transactionIndex: "0x0", logIndex: "0x0", removed: false };

/** Writes one JSON-RPC answer: a result, or a refusal in the shape publicnode or another node gives it. */
function answer(response: import("node:http").ServerResponse, id: number, result: unknown, refused: Refusal | null) {
  const json = (status: number, body: object) => { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
  switch (refused) {
    case null: return json(200, { jsonrpc: "2.0", id, result });
    case "jsonrpc-403": return json(403, { jsonrpc: "2.0", id, error: { code: -32000, message: ARCHIVE_REFUSAL } });
    case "text-403": response.statusCode = 403; response.setHeader("content-type", "text/plain"); return response.end(ARCHIVE_REFUSAL);
    case "forbidden-403": response.statusCode = 403; response.setHeader("content-type", "text/plain"); return response.end("Forbidden");
    case "sepolia-pruned": return json(200, { jsonrpc: "2.0", id, error: { code: -32000, message: "pruned history unavailable" } });
    case "range": return json(200, { jsonrpc: "2.0", id, error: { code: -32000, message: "query returned more than 10000 results" } });
  }
}
function node(name: string, handle: (method: string, params: readonly unknown[]) => { result?: unknown; refused?: Refusal }) {
  return createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: readonly unknown[] };
      calls.push(`${name}:${method}`);
      const { result, refused } = handle(method, params);
      answer(response, id, result, refused ?? null);
    });
  });
}
const publicnode = node("publicnode", (method, params) => {
  if (method === "eth_chainId") return { result: "0x1" };
  if (method === "eth_getBlockByNumber") return { result: { number: params[0], hash: blockHash(BigInt(params[0] as Hex)), timestamp: "0x1" } };
  if (method === "eth_getLogs") return BigInt((params[0] as { fromBlock: Hex }).fromBlock) < ARCHIVE_BELOW ? { refused: refusal } : { result: [] };
  throw new Error(`unexpected ${method}`);
});
/** Logs the full-history RPC answers with: one old log by default, none for the notification reader. */
let archiveLogs: readonly object[] = [log];
const archive = node("archive", method => method === "eth_getLogs" ? { result: archiveLogs } : { refused: "forbidden-403" });
let urls: Record<"publicnode" | "archive", string>;

beforeAll(async () => {
  for (const server of [publicnode, archive]) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  urls = { publicnode: url(publicnode), archive: url(archive) };
});
afterAll(async () => { for (const server of [publicnode, archive]) await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { calls.length = 0; refusal = "jsonrpc-403"; archiveLogs = [log]; });

const logReads = () => calls.filter(call => call.endsWith(":eth_getLogs")).map(call => call.split(":")[0]);
const oldRange: [{ address: Address; fromBlock: Hex; toBlock: Hex }] = [{ address: LABX, fromBlock: numberToHex(OLD), toBlock: numberToHex(OLD + 1_999n) }];

describe("how viem reports publicnode's mainnet archive refusal", () => {
  it.each(["jsonrpc-403", "text-403"] as const)("keeps the refusal text in the error for a %s answer, so the mainnet check sees it", async shape => {
    refusal = shape;
    const error = await createPublicClient({ transport: http(urls.publicnode, { retryCount: 0 }) }).request({ method: "eth_getLogs", params: oldRange }).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toContain("Archive requests require a personal token");
    expect(isPrunedHistoryError(error, NETWORKS[1].history)).toBe(true);
    expect(isPrunedHistoryError(error, NETWORKS[11155111].history)).toBe(false);
    expect(isPrunedHistoryError(error, null)).toBe(false);
  });
});

describe("browser log reads on mainnet", () => {
  const history = () => ({ ...NETWORKS[1].history!, rpc: urls.archive });
  const read = (fallback: { rpc: string; refusal: RegExp } | null) =>
    createPublicClient({ transport: browserReadTransport(urls.publicnode, fallback) }).request({ method: "eth_getLogs", params: oldRange });

  it.each(["jsonrpc-403", "text-403"] as const)("reads logs publicnode refuses with a %s archive refusal from the full-history RPC once, checked against publicnode's blocks", async shape => {
    refusal = shape;
    await expect(read(history())).resolves.toEqual([log]);
    expect(logReads().filter(node => node === "archive")).toEqual(["archive"]);
    expect(calls.filter(call => call.startsWith("archive:"))).toEqual(["archive:eth_getLogs"]);
    expect(calls).toContain("publicnode:eth_getBlockByNumber");
  });

  it.each<{ name: string; shape: Refusal; error: RegExp }>([
    { name: "a bare HTTP 403", shape: "forbidden-403", error: /HTTP request failed/ },
    { name: "Sepolia's pruned-history text", shape: "sepolia-pruned", error: /pruned history unavailable/ },
    { name: "a range-size error", shape: "range", error: /more than 10000 results/ }
  ])("keeps $name on the configured RPC", async ({ shape, error }) => {
    refusal = shape;
    await expect(read(history())).rejects.toThrow(error);
    expect(logReads()).not.toContain("archive");
  });

  it("does not send Sepolia's reads elsewhere on mainnet's refusal", async () => {
    await expect(read({ ...NETWORKS[11155111].history!, rpc: urls.archive })).rejects.toThrow(/Archive requests require a personal token/);
    expect(logReads()).not.toContain("archive");
  });

  it.each([
    { name: "wrong chain block", change: { blockHash: keccak256(toBytes("sepolia block")) } },
    { name: "wrong contract", change: { address: "0x2000000000000000000000000000000000000002" } },
    { name: "removed log", change: { removed: true } },
    { name: "out of range", change: { blockNumber: numberToHex(OLD - 1n) } }
  ])("rejects mainnet fallback $name", async ({ change }) => {
    archiveLogs = [{ ...log, ...change }];
    await expect(read(history())).rejects.toThrow(/did not match this network/);
  });

  it("keeps a recent range on the configured RPC", async () => {
    await expect(createPublicClient({ transport: browserReadTransport(urls.publicnode, history()) })
      .request({ method: "eth_getLogs", params: [{ address: LABX, fromBlock: numberToHex(HEAD - 10n), toBlock: numberToHex(HEAD) }] })).resolves.toEqual([]);
    expect(logReads()).toEqual(["publicnode"]);
  });
});

describe("notification log reads on mainnet", () => {
  const manifest = { ...fixtureTrust, chainId: 1, address: LABX, runtimeCodeHash: keccak256("0x00"), version: 3, deploymentBlock: DEPLOYMENT, usdc: LABX } as DeploymentManifest;
  const blockAt = (number: bigint) => ({ number, hash: keccak256(toHex(number)), timestamp: 1_800_000_000n + number, gasLimit: 30_000_000n });
  const workflow = () => adaptNotificationWorkflow({
    context: { chainId: 1, contract: LABX, origin: "https://labx.art" }, manifest, block: blockAt(HEAD),
    client: Object.assign(createPublicClient({ transport: http(urls.publicnode, { retryCount: 0 }) }), {
      getChainId: async () => 1,
      getBlock: async (args: { blockTag: "finalized" } | { blockNumber: bigint }) => blockAt("blockTag" in args ? HEAD : args.blockNumber)
    }),
    history: historyClient(urls.archive)
  } as unknown as Awaited<ReturnType<typeof serverWorkflow>>);
  const readOld = () => readFinalizedEvents({ fromBlock: OLD, toBlock: OLD + 24_999n, workflow: async () => workflow() });

  it.each(["jsonrpc-403", "text-403"] as const)("asks the full-history RPC once after a %s archive refusal", async shape => {
    refusal = shape;
    archiveLogs = [];
    expect((await readOld()).events).toEqual([]);
    expect(logReads()).toEqual(["publicnode", "archive"]);
  });

  it.each(["forbidden-403", "sepolia-pruned"] as const)("does not use the full-history RPC after %s", async shape => {
    refusal = shape;
    await expect(readOld()).rejects.toThrow();
    expect(logReads()).toEqual(["publicnode"]);
  });
});
