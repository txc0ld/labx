import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { serverClient } from "../lib/chain/server";
import { workflowMessage } from "../lib/chain/messages";
import type { WorkflowContext } from "../lib/chain/api-types";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { MemoryStore } from "../lib/store";

const context: WorkflowContext = { origin: "https://labx.example", chainId: 11155111, contract: "0x1111111111111111111111111111111111111111", termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
const nft: Address = "0x2222222222222222222222222222222222222222";
const contractWallet: Address = "0x5555555555555555555555555555555555555555";
const seller = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
/** An ERC-1271 or ERC-6492 signature only the wallet contract can judge. */
const CONTRACT_SIGNATURE: Hex = "0x1234";
/** The ERC-8010 suffix alone: it passes the envelope check, but no wallet can ever have made it. */
const ERC8010_MAGIC_ONLY: Hex = "0x8010801080108010801080108010801080108010801080108010801080108010";

type NodeReply = { status?: number; json?: object; text?: string };
/** How the JSON-RPC node answers eth_call: the wallet contract's verdict, a revert, an RPC error, or no usable answer. */
const replies = {
  valid: { json: { result: "0x01" } },
  invalid: { json: { result: "0x00" } },
  "empty data": { json: { result: "0x" } },
  revert: { json: { error: { code: 3, message: "execution reverted", data: "0x" } } },
  "Besu revert": { json: { error: { code: -32000, message: "Execution reverted", data: "0x" } } },
  "VM execution revert": { json: { error: { code: -32015, message: "VM execution error.", data: "Reverted 0x" } } },
  down: { status: 502, text: "Bad gateway" },
  "rate-limited": { status: 429, json: { error: { code: -32005, message: "rate limit exceeded" } } },
  "a null result": { json: { result: null } },
  "no result": { json: {} },
  "a malformed result": { json: { result: "0x02" } },
  "a gateway error naming a revert": { status: 502, json: { error: "upstream execution reverted endpoint unavailable" } }
} satisfies Record<string, NodeReply>;
type NodeAnswer = keyof typeof replies;
let node: Server, nodeUrl = "", answer: NodeAnswer = "invalid";
const calls: string[] = [];

beforeAll(async () => {
  node = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const { id, method } = JSON.parse(raw) as { id: number; method: string };
      calls.push(method);
      const reply: NodeReply = method === "eth_call" ? replies[answer] : { json: { error: { code: -32601, message: "unsupported" } } };
      response.statusCode = reply.status ?? 200;
      if (reply.text !== undefined) return response.end(reply.text);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply.json }));
    });
  });
  await new Promise<void>(resolve => node.listen(0, "127.0.0.1", resolve));
  nodeUrl = `http://127.0.0.1:${(node.address() as AddressInfo).port}/rpc-secret-path`;
});
afterAll(async () => { await new Promise(resolve => node.close(resolve)); });

let log: MockInstance;
beforeEach(() => { calls.length = 0; log = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("@/lib/chain/server"); vi.doUnmock("@/lib/store"); vi.resetModules(); });

const routes = {
  records: { operation: "private records", input: { raffleIds: [], purchases: [] }, load: () => import("../app/api/records/route") },
  "reserve/reveal": { operation: "commitment recovery", input: { commit: keccak256(toBytes("draw setup")) }, load: () => import("../app/api/reserve/reveal/route") },
  reserve: { operation: "commitment", input: { nft, tokenId: "1", publicSummary: "Escrowed NFT prize.", privateCommitment: "Private note" }, load: () => import("../app/api/reserve/route") },
  "reserve/preparation": { operation: "preparation recovery", input: { requestIdentity: keccak256(toBytes("preparation")), nft, tokenId: "1" }, load: () => import("../app/api/reserve/preparation/route") }
} as const;
type RouteName = keyof typeof routes;

/** Posts a signed request through the route, with the production server client talking to the test node. */
async function post(route: RouteName, from: Address, signature: Hex | ((message: string) => Promise<Hex>)) {
  vi.doMock("@/lib/chain/server", async original => ({
    ...await original<typeof import("../lib/chain/server")>(),
    serverWorkflow: async () => ({ context, block: { number: 1n }, client: serverClient(nodeUrl) })
  }));
  vi.doMock("@/lib/store", () => ({ activeStore: () => new MemoryStore() }));
  const { POST } = await routes[route].load();
  const { input, operation } = routes[route];
  const deadline = String(Math.floor(Date.now() / 1000) + 120);
  const signed = typeof signature === "function" ? await signature(workflowMessage(operation, context, from, input, deadline)) : signature;
  const response = await POST(new Request(`https://labx.example/api/${route}`, { method: "POST", body: JSON.stringify({ address: from, input, deadline, signature: signed }) }));
  expect(JSON.stringify(log.mock.calls)).not.toContain("rpc-secret-path");
  return { status: response.status, calls: [...calls], logs: [...log.mock.calls] };
}

describe("signature verification with the production server client", () => {
  it("accepts a wallet's own signature without asking the node", async () => {
    const result = await post("records", seller.address, message => seller.signMessage({ message }));
    expect(result).toMatchObject({ status: 200, calls: [] });
  });

  it("refuses another wallet's signature once the node says it is not the claimed wallet's", async () => {
    answer = "invalid";
    const result = await post("records", seller.address, message => other.signMessage({ message }));
    expect(result).toMatchObject({ status: 401, calls: ["eth_call"], logs: [["workflow-request records 401 refused"]] });
  });

  it.each([
    ["accepts", "valid", 200],
    ["refuses", "invalid", 401],
    ["refuses", "empty data", 401],
    ["refuses", "revert", 401],
    ["refuses", "Besu revert", 401],
    ["refuses", "VM execution revert", 401]
  ] as const)("%s a contract wallet signature when the node answers %s", async (_, nodeAnswer, status) => {
    answer = nodeAnswer;
    const result = await post("records", contractWallet, CONTRACT_SIGNATURE);
    expect(result.status).toBe(status);
    expect(result.calls).toContain("eth_call");
  });

  it.each(["down", "rate-limited", "a null result", "no result", "a malformed result", "a gateway error naming a revert"] as const)("answers 503, not refused, when the node gives %s for a contract wallet signature", async nodeAnswer => {
    answer = nodeAnswer;
    const result = await post("records", contractWallet, CONTRACT_SIGNATURE);
    expect(result).toMatchObject({ status: 503, logs: [["workflow-request records 503 records-unavailable"]] });
    expect(result.calls.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(routes) as RouteName[])("%s refuses a signature that can never be valid, without asking the node to retry", async route => {
    answer = "down";
    const result = await post(route, seller.address, ERC8010_MAGIC_ONLY);
    expect(result).toMatchObject({ status: 401, logs: [[`workflow-request ${route} 401 refused`]] });
  });

  it.each(Object.keys(routes) as RouteName[])("%s answers 503 when the node can't check a contract wallet signature", async route => {
    answer = "down";
    const result = await post(route, contractWallet, CONTRACT_SIGNATURE);
    expect(result).toMatchObject({ status: 503, logs: [[`workflow-request ${route} 503 records-unavailable`]] });
  });
});
