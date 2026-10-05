import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agreementMessage, recordAgreement, type AgreementRequest } from "../lib/agreement-record";
import { deliverPurchaseReceipt, receiptAuthorizationMessage, resendSender, type MailPayload, type ReceiptRequest } from "../lib/receipt-delivery";
import { purchaseEvent, verifiedPurchase, type PurchaseReader } from "../lib/purchase-proof";
import type { RequestContext } from "../lib/request-auth";

const now = 1_800_000_000_000;
const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const contract = "0x1111111111111111111111111111111111111111" as Address;
const transactionHash = `0x${"22".repeat(32)}` as Hex;
const blockHash = `0x${"33".repeat(32)}` as Hex;
const context: RequestContext = { origin: "https://labx.example", chainId: 11155111, contract };
const from = "LABx <receipt@labx.example>";
const transport = "44".repeat(32);

class Store {
  map = new Map<string, string>();
  async get(key: string) { return this.map.get(key) ?? null; }
  async set(key: string, value: string) { this.map.set(key, value); }
  async setIfAbsent(entries: Record<string, string>) {
    if (Object.keys(entries).some(key => this.map.has(key))) return false;
    for (const [key, value] of Object.entries(entries)) this.map.set(key, value);
    return true;
  }
}

function reader(): PurchaseReader {
  return {
    getChainId: vi.fn(async () => 11155111),
    getTransactionReceipt: vi.fn(async () => ({ status: "success", transactionHash, blockHash, blockNumber: 100n, logs: [{
      address: contract, logIndex: 3,
      topics: encodeEventTopics({ abi: [purchaseEvent], eventName: "PackPurchased", args: { id: 1n, buyer: account.address } }) as Hex[],
      data: encodeAbiParameters(parseAbiParameters("uint8, uint32, uint32, uint256, uint256, bool"), [0, 2, 2, 50_000_001n, 10_000_000n, false])
    }] })),
    getBlock: vi.fn(async args => ({ number: "blockTag" in args ? 101n : args.blockNumber, hash: blockHash }))
  };
}

async function receipt(overrides: Partial<ReceiptRequest> = {}, ctx = context, at = now): Promise<ReceiptRequest> {
  const input: ReceiptRequest = { address: account.address, to: "buyer@example.com", transactionHash, logIndex: 3, deadline: String(Math.floor(at / 1000) + 60), signature: "0x", ...overrides };
  input.signature = await account.signMessage({ message: receiptAuthorizationMessage(input, ctx) });
  return input;
}

describe("verified purchase receipts", () => {
  it("derives exact receipt amounts from a finalized configured-contract event", async () => {
    const send = vi.fn(async (_body: MailPayload, _key: string) => true);
    const input = { ...await receipt(), entries: 999, priceUsdc: 0, piece: "forged", pack: "forged" };
    await expect(deliverPurchaseReceipt(new Store(), input, context, reader(), send, from, transport, now)).resolves.toEqual({ delivered: true, repeated: false });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].text).toContain("Raffle #1");
    expect(send.mock.calls[0][0].text).toContain("50.000001 USDC");
    expect(send.mock.calls[0][0].text).not.toContain("forged");
    expect(send.mock.calls[0][0].text).not.toContain("999");
  });

  it("refuses wrong buyers, contracts, failed/reorged/unfinalized receipts and wrong chains", async () => {
    const input = await receipt();
    const cases: ((read: PurchaseReader) => void)[] = [
      read => { vi.mocked(read.getChainId).mockResolvedValue(1); },
      read => { vi.mocked(read.getBlock).mockResolvedValue({ number: 99n, hash: blockHash }); },
      read => { vi.mocked(read.getBlock).mockResolvedValue({ number: 101n, hash: transactionHash }); },
      read => { const get = read.getTransactionReceipt; read.getTransactionReceipt = async args => ({ ...await get(args), status: "reverted" }); },
      read => { const get = read.getTransactionReceipt; read.getTransactionReceipt = async args => ({ ...await get(args), transactionHash: blockHash }); },
      read => { const get = read.getTransactionReceipt; read.getTransactionReceipt = async args => { const result = await get(args); return { ...result, logs: result.logs.map(log => ({ ...log, address: other.address })) }; }; },
      read => { const get = read.getTransactionReceipt; read.getTransactionReceipt = async args => { const result = await get(args); return { ...result, logs: result.logs.map(log => ({ ...log, topics: encodeEventTopics({ abi: [purchaseEvent], eventName: "PackPurchased", args: { id: 1n, buyer: other.address } }) as Hex[] })) }; }; },
      read => { vi.mocked(read.getTransactionReceipt).mockRejectedValue(new Error("private RPC URL and token must not escape")); }
    ];
    for (const mutate of cases) {
      const read = reader(); mutate(read);
      await expect(verifiedPurchase(input, context, read)).rejects.toThrow("A finalized LABx purchase could not be verified.");
    }
    await expect(verifiedPurchase({ ...input, logIndex: 99 }, context, reader())).rejects.toThrow(/could not be verified/);
  });

  it("binds signer, recipient, transaction, log, domain, chain, contract and freshness", async () => {
    const input = await receipt();
    const send = vi.fn(async () => true);
    for (const changed of [{ address: other.address }, { to: "victim@example.com" }, { transactionHash: blockHash }, { logIndex: 4 }, { deadline: String(Number(input.deadline) + 1) }]) {
      await expect(deliverPurchaseReceipt(new Store(), { ...input, ...changed }, context, reader(), send, from, transport, now)).rejects.toThrow(/authorization/);
    }
    for (const ctx of [{ ...context, origin: "https://other.example" }, { ...context, contract: other.address }, { ...context, chainId: 1 as 11155111 }]) {
      await expect(deliverPurchaseReceipt(new Store(), input, ctx, reader(), send, from, transport, now)).rejects.toThrow(/authorization/);
    }
    await expect(deliverPurchaseReceipt(new Store(), input, context, reader(), send, from, transport, now + 61_000)).rejects.toThrow(/authorization/);
    expect(send).not.toHaveBeenCalled();
  });

  it("reserves each purchase for one recipient across concurrent requests and recovers a lost response", async () => {
    const store = new Store(); const input = await receipt();
    const unique = new Map<string, string>();
    const send = vi.fn(async (body: MailPayload, key: string) => { const payload = JSON.stringify(body); if (unique.has(key)) expect(unique.get(key)).toBe(payload); unique.set(key, payload); return true; });
    await Promise.all(Array.from({ length: 12 }, () => deliverPurchaseReceipt(store, input, context, reader(), send, from, transport, now)));
    expect(unique.size).toBe(1);
    const count = send.mock.calls.length;
    const offline = reader(); vi.mocked(offline.getChainId).mockRejectedValue(new Error("offline"));
    await expect(deliverPurchaseReceipt(store, await receipt({}, context, now + 10_000), context, offline, send, from, transport, now + 10_000)).resolves.toEqual({ delivered: true, repeated: true });
    expect(send.mock.calls.length).toBe(count);
    await expect(deliverPurchaseReceipt(store, await receipt({ to: "changed@example.com" }), context, reader(), send, from, transport, now)).rejects.toThrow(/another request/);
  });

  it("reuses the exact payload/key after send uncertainty but refuses retries beyond provider retention", async () => {
    const store = new Store(); const input = await receipt();
    const send = vi.fn(async (_body: MailPayload, _key: string) => false);
    expect((await deliverPurchaseReceipt(store, input, context, reader(), send, from, transport, now)).delivered).toBe(false);
    await deliverPurchaseReceipt(store, input, context, reader(), send, "Different sender <new@example.com>", transport, now + 1_000);
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    await expect(deliverPurchaseReceipt(store, input, context, reader(), send, from, "55".repeat(32), now + 1_000)).rejects.toThrow(/credentials changed/);
    const later = now + 24 * 60 * 60 * 1000;
    await expect(deliverPurchaseReceipt(store, await receipt({}, context, later), context, reader(), send, from, transport, later)).rejects.toThrow(/reconciliation/);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not send if reservation fails and safely retries an uncertain delivered-marker write", async () => {
    const store = new Store(); const input = await receipt(); const send = vi.fn(async () => true);
    const set = store.setIfAbsent.bind(store);
    store.setIfAbsent = async () => { throw new Error("fixture persistence failure"); };
    await expect(deliverPurchaseReceipt(store, input, context, reader(), send, from, transport, now)).rejects.toThrow(/fixture persistence/);
    expect(send).not.toHaveBeenCalled();
    store.setIfAbsent = async values => { if (Object.keys(values)[0].endsWith(":sent")) throw new Error("lost marker"); return set(values); };
    await expect(deliverPurchaseReceipt(store, input, context, reader(), send, from, transport, now)).rejects.toThrow(/lost marker/);
    store.setIfAbsent = set;
    await deliverPurchaseReceipt(store, input, context, reader(), send, from, transport, now + 1_000);
    expect(send).toHaveBeenCalledTimes(2); // Same provider key/payload, so provider deduplicates.
  });

  it("sends provider idempotency and requires a valid acknowledgement", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "fixture-message" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const send = resendSender("fixture-not-a-real-key");
      const payload = { from, to: "buyer@example.com", subject: "fixture", html: "fixture", text: "fixture" };
      expect(await send(payload, "fixture-key")).toBe(true);
      expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe("fixture-key");
      fetcher.mockResolvedValueOnce(new Response("{}", { status: 200 }));
      expect(await send(payload, "fixture-key")).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("version-bound signed agreements", () => {
  const agreementContext = { ...context, termsHash: `0x${"ab".repeat(32)}` as Hex };
  async function agreement(overrides: Partial<AgreementRequest> = {}): Promise<AgreementRequest> {
    const input: AgreementRequest = { address: account.address, pieceId: "piece-1", terms: true, rules: true, age: true, termsHash: agreementContext.termsHash, deadline: String(now / 1000 + 60), signature: "0x", ...overrides };
    input.signature = await account.signMessage({ message: agreementMessage(input, agreementContext) });
    return input;
  }
  it("records only a normalized signed assertion once for the wallet/piece/version", async () => {
    const store = new Store(); const input = { ...await agreement(), injected: "not stored" };
    await Promise.all(Array.from({ length: 10 }, () => recordAgreement(store, input, agreementContext, now)));
    expect(store.map.size).toBe(1);
    const saved = JSON.parse([...store.map.values()][0]);
    expect(saved.evidence).toContain("not proof of purchase");
    expect(saved).not.toHaveProperty("injected");
    expect(saved.message).toBe(agreementMessage(input, agreementContext));
  });
  it("rejects unsigned/spoofed/expired/version-mismatched and truthy non-boolean assertions", async () => {
    const input = await agreement();
    for (const changed of [{ signature: "0x" }, { address: other.address }, { pieceId: "piece-2" }, { termsHash: blockHash }, { deadline: "0" }, { terms: "true" }, { age: 1 }]) {
      const store = new Store();
      await expect(recordAgreement(store, { ...input, ...changed } as AgreementRequest, agreementContext, now)).rejects.toThrow();
      expect(store.map.size).toBe(0);
    }
    await expect(recordAgreement(new Store(), input, { ...agreementContext, origin: "https://wrong.example" }, now)).rejects.toThrow(/authorization/);
  });
});
