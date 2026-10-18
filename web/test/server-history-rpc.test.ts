import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http, keccak256, toHex, type Address } from "viem";
import { historyClient, type serverWorkflow } from "../lib/chain/server";
import { adaptNotificationWorkflow, createNotificationReadBudget, NotificationRangeTooDenseError, NotificationRpcTimeoutError, readFinalizedEvents, type NotificationWorkflow } from "../lib/notifications/events";
import type { DeploymentManifest } from "../lib/chain/types";
import { fixtureTrust } from "./fixtures/deployment";

const LABX: Address = "0x8b0332D0ca48908e174F42eA1b3123e63f3F4327";
const DEPLOYMENT = 11_865_781n;
const HEAD = 11_942_999n;
const PRUNED_BELOW = 11_917_000n;
const DENSE_FROM = 11_917_500n;
const SLOW_FROM = 11_880_000n;
const calls: string[] = [];

/** A node that answers like publicnode's US servers: old log ranges are pruned, one recent range is too dense, and one old range answers slowly. */
function node(name: string, answer: (from: bigint) => { error: string; delayMs?: number } | []) {
  return createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const { id, params } = JSON.parse(raw) as { id: number; params: [{ fromBlock: string }] };
      calls.push(name);
      const result = answer(BigInt(params[0].fromBlock));
      const body = JSON.stringify("error" in result ? { jsonrpc: "2.0", id, error: { code: -32000, message: result.error } } : { jsonrpc: "2.0", id, result });
      setTimeout(() => { response.setHeader("content-type", "application/json"); response.end(body); }, "delayMs" in result ? result.delayMs : 0);
    });
  });
}
const pruned = node("pruned", from => from === SLOW_FROM ? { error: "pruned history unavailable", delayMs: 300 }
  : from < PRUNED_BELOW ? { error: "pruned history unavailable" } : from === DENSE_FROM ? { error: "query returned more than 10000 results" } : []);
const archive = node("archive", () => []);
const down = node("down", () => ({ error: "backend unavailable" }));
let urls: Record<"pruned" | "archive" | "down", string>;

beforeAll(async () => {
  const servers = { pruned, archive, down };
  for (const server of Object.values(servers)) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  urls = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, `http://127.0.0.1:${(server.address() as AddressInfo).port}`])) as typeof urls;
});
afterAll(async () => { for (const server of [pruned, archive, down] as Server[]) await new Promise(resolve => server.close(resolve)); });

const manifest = { ...fixtureTrust, chainId: 11155111, address: LABX, runtimeCodeHash: keccak256("0x00"), version: 3, deploymentBlock: DEPLOYMENT, usdc: LABX } as DeploymentManifest;
const blockAt = (number: bigint) => ({ number, hash: keccak256(toHex(number)), timestamp: 1_800_000_000n + number, gasLimit: 30_000_000n });

/** The production adapter over real viem clients for logs, with blocks from a fixed chain. */
function workflow(history: string | null): NotificationWorkflow {
  return adaptNotificationWorkflow({
    context: { chainId: 11155111, contract: LABX, origin: "https://labx.art" }, manifest, block: blockAt(HEAD),
    client: Object.assign(createPublicClient({ transport: http(urls.pruned, { retryCount: 0 }) }), {
      getChainId: async () => 11155111,
      getBlock: async (args: { blockTag: "finalized" } | { blockNumber: bigint }) => blockAt("blockTag" in args ? HEAD : args.blockNumber)
    }),
    history: history ? historyClient(history) : null
  } as unknown as Awaited<ReturnType<typeof serverWorkflow>>);
}
const read = (fromBlock: bigint, history: string | null, budget = createNotificationReadBudget()) =>
  readFinalizedEvents({ fromBlock, toBlock: fromBlock + 24_999n, workflow: async () => workflow(history), budget });

describe("notification log reads", () => {
  it("cannot read old logs from the pruned RPC alone, which is what broke the production feed", async () => {
    await expect(read(11_870_000n, null)).rejects.toThrow(/pruned history unavailable/);
  });

  it("asks the full-history RPC once for pruned logs and keeps recent reads on the configured RPC", async () => {
    calls.length = 0;
    expect((await read(11_870_000n, urls.archive)).events).toEqual([]);
    expect(calls).toEqual(["pruned", "archive"]);
    calls.length = 0;
    expect((await read(11_918_000n, urls.archive)).events).toEqual([]);
    expect(calls).toEqual(["pruned"]);
  });

  it("keeps a range-size error from the configured RPC, so the range is split instead of sent elsewhere", async () => {
    calls.length = 0;
    await expect(read(DENSE_FROM, urls.down)).rejects.toBeInstanceOf(NotificationRangeTooDenseError);
    expect(calls).toEqual(["pruned"]);
  });

  it("makes one attempt at the full-history RPC, with no retry", async () => {
    calls.length = 0;
    await expect(read(11_870_000n, urls.down)).rejects.toThrow(/backend unavailable/);
    expect(calls).toEqual(["pruned", "down"]);
  });

  it("starts no full-history read once the read deadline has passed", async () => {
    calls.length = 0;
    await expect(read(SLOW_FROM, urls.archive, createNotificationReadBudget(64, 150))).rejects.toBeInstanceOf(NotificationRpcTimeoutError);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(calls).toEqual(["pruned"]);
  });

  it("counts the full-history read against the read budget", async () => {
    const recent = createNotificationReadBudget(64, 8_000), old = createNotificationReadBudget(64, 8_000);
    await read(11_918_000n, urls.archive, recent);
    await read(11_870_000n, urls.archive, old);
    expect(recent.remaining - old.remaining).toBe(1);
  });
});
