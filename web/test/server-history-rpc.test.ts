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

/** A node that answers like publicnode's US servers: recent calls work, old log ranges are pruned. */
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
const PRUNED_BELOW = 11_917_000n;
const pruned = node("pruned", from => from < PRUNED_BELOW ? new Error("pruned history unavailable") : []);
const archive = node("archive", () => [log]);
let prunedUrl = "", archiveUrl = "";

beforeAll(async () => {
  for (const server of [pruned, archive]) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  prunedUrl = `http://127.0.0.1:${(pruned.address() as AddressInfo).port}`;
  archiveUrl = `http://127.0.0.1:${(archive.address() as AddressInfo).port}`;
});
afterAll(async () => { for (const server of [pruned, archive] as Server[]) await new Promise(resolve => server.close(resolve)); });

describe("server history reads", () => {
  const old = { address: LABX, fromBlock: 11_870_000n, toBlock: 11_894_999n } as const;

  it("a client on the pruned RPC alone cannot read old logs, which is what broke the production feed", async () => {
    await expect(createPublicClient({ transport: http(prunedUrl, { retryCount: 0 }) }).getLogs(old)).rejects.toThrow(/pruned history unavailable/);
  });

  it("falls back to the full-history RPC for old logs and stays on the configured RPC for recent ones", async () => {
    calls.length = 0;
    const client = historyClient(prunedUrl, archiveUrl);
    expect(await client.getLogs(old)).toHaveLength(1);
    expect(calls).toEqual(["pruned:eth_getLogs", "archive:eth_getLogs"]);
    calls.length = 0;
    expect(await client.getLogs({ address: LABX, fromBlock: 11_918_000n, toBlock: 11_942_999n })).toEqual([]);
    expect(calls).toEqual(["pruned:eth_getLogs"]);
  });

  it("sends the notification reader's log reads to the history client", async () => {
    const refuse = async () => { throw new Error("pruned history unavailable"); };
    const server = { client: { getLogs: refuse }, history: { getLogs: async () => [log] } } as unknown as Awaited<ReturnType<typeof serverWorkflow>>;
    const logs = await adaptNotificationWorkflow(server).client.getLogs({ address: LABX, events: [] as never, fromBlock: 1n, toBlock: 2n, strict: false });
    expect(logs).toEqual([log]);
  });
});
