import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPublicClient, encodeErrorResult, erc721Abi, http, parseAbi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { serverClient } from "../lib/chain/server";
import { workflowMessage } from "../lib/chain/messages";
import type { CommitmentInput, WorkflowContext } from "../lib/chain/api-types";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { MemoryStore } from "../lib/store";

const nft: Address = "0x2222222222222222222222222222222222222222";
const offchainLookup = parseAbi(["error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)"]);
let rpc: Server, sink: Server, rpcUrl = "", sinkHits = 0;

/** A JSON-RPC node whose every eth_call reverts asking for an off-chain lookup at the sink, as an attacker's NFT contract can. */
beforeAll(async () => {
  sink = createServer((_, response) => { sinkHits++; response.end("{}"); });
  await new Promise<void>(resolve => sink.listen(0, "127.0.0.1", resolve));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/{sender}/{data}`;
  rpc = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const { id, method } = JSON.parse(raw) as { id: number; method: string };
      response.setHeader("content-type", "application/json");
      if (method !== "eth_call") return response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } }));
      const data = encodeErrorResult({ abi: offchainLookup, errorName: "OffchainLookup", args: [nft, [sinkUrl], "0x1234", "0x12345678", "0x"] });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data } }));
    });
  });
  await new Promise<void>(resolve => rpc.listen(0, "127.0.0.1", resolve));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise(resolve => rpc.close(resolve));
  await new Promise(resolve => sink.close(resolve));
});
afterEach(() => { sinkHits = 0; vi.doUnmock("@/lib/chain/server"); vi.doUnmock("@/lib/store"); vi.resetModules(); });

const ownerOf = { address: nft, abi: erc721Abi, functionName: "ownerOf", args: [1n] } as const;

describe("server chain reads and off-chain lookups", () => {
  it("a default viem client follows the lookup, which is what the server must not do", async () => {
    await createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) }).readContract(ownerOf).catch(() => {});
    expect(sinkHits).toBeGreaterThan(0);
  });

  it("the server client refuses the lookup without fetching its URL", async () => {
    await expect(serverClient(rpcUrl).readContract(ownerOf)).rejects.toThrow();
    expect(sinkHits).toBe(0);
  });
});

describe("POST /api/reserve", () => {
  const context: WorkflowContext = { origin: "https://labx.example", chainId: 11155111, contract: "0x1111111111111111111111111111111111111111", termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
  const input: CommitmentInput = { nft, tokenId: "1", publicSummary: "Escrowed NFT prize.", privateCommitment: "Private fixture description" };
  const seller = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());

  async function post(signer = seller) {
    const readContract = vi.fn(async () => seller.address);
    vi.doMock("@/lib/chain/server", async original => ({
      ...await original<typeof import("../lib/chain/server")>(),
      serverWorkflow: async () => ({ context, block: { number: 1n }, client: { readContract, verifyMessage: (await import("viem")).verifyMessage } })
    }));
    vi.doMock("@/lib/store", () => ({ activeStore: () => new MemoryStore() }));
    const { POST } = await import("../app/api/reserve/route");
    const deadline = String(Math.floor(Date.now() / 1000) + 120);
    const signature = await signer.signMessage({ message: workflowMessage("commitment", context, seller.address, input, deadline) });
    const body = JSON.stringify({ address: seller.address, input, deadline, signature });
    const response = await POST(new Request("https://labx.example/api/reserve", { method: "POST", body, headers: { "content-length": String(body.length) } }));
    return { status: response.status, readContract };
  }

  it("checks the seller's signature before reading the NFT contract the request names", async () => {
    const forged = await post(other);
    expect(forged.status).toBe(401);
    expect(forged.readContract).not.toHaveBeenCalled();
    vi.resetModules();
    const signed = await post();
    expect(signed.status).toBe(200);
    expect(signed.readContract).toHaveBeenCalledOnce();
  });
});
