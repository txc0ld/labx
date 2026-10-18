import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { keccak256, toBytes, verifyMessage, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { workflowMessage } from "../lib/chain/messages";
import type { WorkflowContext } from "../lib/chain/api-types";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { MemoryStore } from "../lib/store";
import { createReserve } from "../lib/reserve";
import type { Store } from "../lib/points";

const context: WorkflowContext = { origin: "https://labx.example", chainId: 11155111, contract: "0x1111111111111111111111111111111111111111", termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
const nft: Address = "0x2222222222222222222222222222222222222222";
const seller = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const PRIVATE_NOTE = "Private draw note 7f3a";
/** Raw infrastructure error text, which must never reach the response or the log. */
const RAW_ERROR = "connect ECONNREFUSED 10.0.0.7:5432 password=hunter2";

const routes = {
  "reserve/reveal": { operation: "commitment recovery", load: () => import("../app/api/reserve/reveal/route") },
  reserve: { operation: "commitment", load: () => import("../app/api/reserve/route") },
  "reserve/preparation": { operation: "preparation recovery", load: () => import("../app/api/reserve/preparation/route") },
  records: { operation: "private records", load: () => import("../app/api/records/route") }
} as const;
type RouteName = keyof typeof routes;

const brokenStore: Store = {
  get: async () => { throw new Error(RAW_ERROR); },
  set: async () => { throw new Error(RAW_ERROR); },
  setIfAbsent: async () => { throw new Error(RAW_ERROR); }
};

let log: MockInstance;
beforeEach(() => { log = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("@/lib/chain/server"); vi.doUnmock("@/lib/store"); vi.resetModules(); });

async function post(route: RouteName, input: unknown, options: { signer?: PrivateKeyAccount; deadline?: string; deployment?: "fails"; store?: Store; owner?: () => Promise<Address> } = {}) {
  const { signer = seller, deadline = String(Math.floor(Date.now() / 1000) + 120), store = new MemoryStore(), owner = async () => seller.address } = options;
  vi.doMock("@/lib/chain/server", async original => ({
    ...await original<typeof import("../lib/chain/server")>(),
    serverWorkflow: async () => {
      if (options.deployment === "fails") throw new Error(RAW_ERROR);
      return { context, block: { number: 1n }, client: { verifyMessage, readContract: owner } };
    }
  }));
  vi.doMock("@/lib/store", () => ({ activeStore: () => store }));
  const { POST } = await routes[route].load();
  const signature = await signer.signMessage({ message: workflowMessage(routes[route].operation, context, seller.address, input, deadline) });
  const body = JSON.stringify({ address: seller.address, input, deadline, signature });
  const response = await POST(new Request(`https://labx.example/api/${route}`, { method: "POST", body, headers: { "content-length": String(body.length) } }));
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as { ok: boolean; error?: string; salt?: Hex }, signature, logs: log.mock.calls };
}

/** A draw setup saved for `owner`, as the seller's Create step stores it. */
async function savedSetup(owner: Address) {
  const store = new MemoryStore();
  const { commit } = await createReserve(store, { seller: owner, nft, tokenId: "1", publicSummary: "Escrowed NFT prize.", privateCommitment: PRIVATE_NOTE, chainId: 11155111n, labx: context.contract });
  return { store, commit };
}

const inputs: Record<RouteName, unknown> = {
  "reserve/reveal": { commit: keccak256(toBytes("draw setup")) },
  reserve: { nft, tokenId: "1", publicSummary: "Escrowed NFT prize.", privateCommitment: PRIVATE_NOTE },
  "reserve/preparation": { requestIdentity: keccak256(toBytes("preparation")), nft, tokenId: "1" },
  records: { raffleIds: ["1"], purchases: [] }
};

describe("POST /api/reserve/reveal (Confirm the draw)", () => {
  it("returns the saved draw setup to the seller", async () => {
    const { store, commit } = await savedSetup(seller.address);
    const result = await post("reserve/reveal", { commit }, { store });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.logs).toEqual([]);
  });

  it("answers 503 and asks the seller to try again when the deployment check fails", async () => {
    const { store, commit } = await savedSetup(seller.address);
    const result = await post("reserve/reveal", { commit }, { store, deployment: "fails" });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ ok: false, error: "The draw setup couldn't be loaded right now. Try again in a minute." });
    expect(result.logs).toEqual([["workflow-request reserve/reveal 503 deployment-unavailable"]]);
  });

  it("answers 503 when the private store can't be read", async () => {
    const result = await post("reserve/reveal", inputs["reserve/reveal"], { store: brokenStore });
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("The draw setup couldn't be loaded right now. Try again in a minute.");
    expect(result.logs).toEqual([["workflow-request reserve/reveal 503 records-unavailable"]]);
    expect(result.text).not.toContain("ECONNREFUSED");
  });

  it.each([
    ["a signature from another wallet", { signer: other }],
    ["an expired signature", { deadline: String(Math.floor(Date.now() / 1000) - 1) }]
  ])("answers 401 for %s", async (_, options) => {
    const { store, commit } = await savedSetup(seller.address);
    const result = await post("reserve/reveal", { commit }, { store, ...options });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ ok: false, error: "The signature wasn't accepted. Use the seller wallet and try again." });
    expect(result.logs).toEqual([["workflow-request reserve/reveal 401 refused"]]);
  });

  it("answers 401 when the draw setup belongs to another seller", async () => {
    const { store, commit } = await savedSetup(other.address);
    const result = await post("reserve/reveal", { commit }, { store });
    expect(result.status).toBe(401);
    expect(result.text).not.toContain(PRIVATE_NOTE);
    expect(result.logs).toEqual([["workflow-request reserve/reveal 401 refused"]]);
  });

  it("answers 400 for a malformed request", async () => {
    const result = await post("reserve/reveal", { commit: "not a hash" });
    expect(result.status).toBe(400);
    expect(result.logs).toEqual([["workflow-request reserve/reveal 400 invalid-request"]]);
  });
});

describe("sibling signed workflow routes", () => {
  it.each(Object.keys(routes) as RouteName[])("%s answers 503 with a retry message, logging only a fixed label, when the deployment check fails", async route => {
    const result = await post(route, inputs[route], { deployment: "fails" });
    expect(result.status).toBe(503);
    expect(result.body.error).toMatch(/Try again in a minute\.$/);
    expect(result.logs).toEqual([[`workflow-request ${route} 503 deployment-unavailable`]]);
    expect(JSON.stringify(result.logs)).not.toContain(result.signature);
    expect(JSON.stringify(result.logs)).not.toContain(PRIVATE_NOTE);
  });

  it.each(Object.keys(routes) as RouteName[])("%s answers 401 for a signature from another wallet", async route => {
    const result = await post(route, inputs[route], { signer: other });
    expect(result.status).toBe(401);
    expect(result.logs).toEqual([[`workflow-request ${route} 401 refused`]]);
  });

  it.each(Object.keys(routes) as RouteName[])("%s answers 400 for a malformed request", async route => {
    const result = await post(route, {});
    expect(result.status).toBe(400);
    expect(result.logs).toEqual([[`workflow-request ${route} 400 invalid-request`]]);
  });

  it.each(["reserve", "records"] as const)("%s answers 503 when the private store can't be read", async route => {
    const result = await post(route, inputs[route], { store: brokenStore });
    expect(result.status).toBe(503);
    expect(result.text).not.toContain("ECONNREFUSED");
    expect(result.logs).toEqual([[`workflow-request ${route} 503 records-unavailable`]]);
  });

  it("reserve answers 401 when another wallet owns the NFT and 503 when the ownership read fails", async () => {
    expect((await post("reserve", inputs.reserve, { owner: async () => other.address })).status).toBe(401);
    vi.resetModules();
    const failed = await post("reserve", inputs.reserve, { owner: async () => { throw new Error(RAW_ERROR); } });
    expect(failed.status).toBe(503);
  });

  it("reserve/preparation answers 503, so the seller retries, while the saved setup is not yet available", async () => {
    const result = await post("reserve/preparation", inputs["reserve/preparation"]);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("Your raffle setup couldn't be restored right now. Try again in a minute.");
  });
});
