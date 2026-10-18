import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http, type Address } from "viem";
import { historyClient, type serverWorkflow } from "../lib/chain/server";
import { adaptNotificationWorkflow } from "../lib/notifications/events";

const LABX: Address = "0x8b0332D0ca48908e174F42eA1b3123e63f3F4327";
const log = {
  address: LABX.toLowerCase(), topics: ["0x8dac5c786a7ae418b4db530dde492708a052df0746a893d3409ec69fee274179"], data: "0x",
  blockNumber: "0xb54747", blockHash: `0x${"11".repeat(32)}`, transactionHash: `0x${"22".repeat(32)}`, transactionIndex: "0x0", logIndex: "0x0", removed: false
};
const calls: string[] = [];
const PRUNED_BELOW = 11_917_000n;
const DENSE_FROM = 11_930_000n;

/** A node that answers like publicnode's US servers: old log ranges are pruned, and one recent range is too dense. */
function node(name: string, logs: (from: bigint) => unknown) {
  return createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: [{ fromBlock: string }] };
      calls.push(`${name}:${method}`);
      response.setHeader("content-type", "application/json");
      if (method !== "eth_getLogs") return response.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0xb63c00" }));
      const answer = logs(BigInt(params[0].fromBlock));
      response.end(JSON.stringify(answer instanceof Error ? { jsonrpc: "2.0", id, error: { code: -32000, message: answer.message } } : { jsonrpc: "2.0", id, result: answer }));
    });
  });
}
const pruned = node("pruned", from => from < PRUNED_BELOW ? new Error("pruned history unavailable") : from === DENSE_FROM ? new Error("query returned more than 10000 results") : []);
const archive = node("archive", () => [log]);
const down = node("down", () => new Error("backend unavailable"));
let urls: Record<"pruned" | "archive" | "down", string>;

beforeAll(async () => {
  const servers = { pruned, archive, down };
  for (const server of Object.values(servers)) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  urls = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, `http://127.0.0.1:${(server.address() as AddressInfo).port}`])) as typeof urls;
});
afterAll(async () => { for (const server of [pruned, archive, down] as Server[]) await new Promise(resolve => server.close(resolve)); });

/** The notification reader's view of a server workflow whose configured RPC is `primary` and whose full-history RPC is `history`. */
function reader(primary: string, history: string | null) {
  const server = { client: createPublicClient({ transport: http(primary, { retryCount: 1 }) }), history: history ? historyClient(history) : null } as unknown as Awaited<ReturnType<typeof serverWorkflow>>;
  return adaptNotificationWorkflow(server).client;
}
const range = (fromBlock: bigint) => ({ address: LABX, events: undefined as never, fromBlock, toBlock: fromBlock + 24_999n, strict: false as const });

describe("notification log reads", () => {
  it("cannot read old logs from the pruned RPC alone, which is what broke the production feed", async () => {
    await expect(reader(urls.pruned, null).getLogs(range(11_870_000n))).rejects.toThrow(/pruned history unavailable/);
  });

  it("asks the full-history RPC once for pruned logs and keeps recent reads on the configured RPC", async () => {
    calls.length = 0;
    expect((await reader(urls.pruned, urls.archive).getLogs(range(11_870_000n))).map(item => (item as { blockNumber: bigint }).blockNumber)).toEqual([BigInt(log.blockNumber)]);
    expect(calls).toEqual(["pruned:eth_getLogs", "archive:eth_getLogs"]);
    calls.length = 0;
    expect(await reader(urls.pruned, urls.archive).getLogs(range(11_918_000n))).toEqual([]);
    expect(calls).toEqual(["pruned:eth_getLogs"]);
  });

  it("keeps a range-size error from the configured RPC, so the reader can still split the range", async () => {
    calls.length = 0;
    await expect(reader(urls.pruned, urls.down).getLogs(range(DENSE_FROM))).rejects.toThrow(/more than 10000 results/);
    expect(calls).toEqual(["pruned:eth_getLogs"]);
  });

  it("makes one attempt at the full-history RPC, with no retry", async () => {
    calls.length = 0;
    await expect(reader(urls.pruned, urls.down).getLogs(range(11_870_000n))).rejects.toThrow(/backend unavailable/);
    expect(calls).toEqual(["pruned:eth_getLogs", "down:eth_getLogs"]);
  });
});
