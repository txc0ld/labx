import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, verifyMessage, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { POST as checkInRoute } from "../app/api/bot/check-in/route";
import { GET as pointsRoute } from "../app/api/points/route";
import { workflowMessage } from "../lib/chain/messages";
import { verifyWorkflowAuthorization } from "../lib/chain/server";
import type { WorkflowContext } from "../lib/chain/api-types";
import { checkIn, checkInMessage, utcDay } from "../lib/points";
import { privateRecords } from "../lib/private-records";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { purchaseEvent, type PurchaseReader } from "../lib/purchase-proof";
import { deliverPurchaseReceipt, receiptAuthorizationMessage, type MailPayload, type ReceiptRequest } from "../lib/receipt-delivery";
import { MemoryStore } from "../lib/store";

const now = 1_800_000_000_000;
const buyer = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());
const contract = "0x1111111111111111111111111111111111111111" as Address;
const transactionHash = `0x${"22".repeat(32)}` as Hex;
const blockHash = `0x${"33".repeat(32)}` as Hex;
const context: WorkflowContext = { origin: "https://labx.example", chainId: 11155111, contract, termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
const from = "LABx <receipt@labx.example>";
const transport = "44".repeat(32);

/** A finalized purchase by `buyer` at log index 3. */
function reader(): PurchaseReader {
  return {
    getChainId: vi.fn(async () => 11155111),
    getTransactionReceipt: vi.fn(async () => ({ status: "success", transactionHash, blockHash, blockNumber: 100n, logs: [{
      address: contract, logIndex: 3,
      topics: encodeEventTopics({ abi: [purchaseEvent], eventName: "PackPurchased", args: { id: 1n, buyer: buyer.address } }) as Hex[],
      data: encodeAbiParameters(parseAbiParameters("uint8, uint32, uint32, uint256, uint256, bool"), [0, 2, 2, 50_000_001n, 10_000_000n, false])
    }] })),
    getBlock: vi.fn(async args => ({ number: "blockTag" in args ? 101n : args.blockNumber, hash: blockHash }))
  };
}

async function receipt(signer = buyer, to = "buyer@example.com", seconds = 60): Promise<ReceiptRequest> {
  const input: ReceiptRequest = { address: signer.address, to, transactionHash, logIndex: 3, deadline: String(Math.floor(now / 1000) + seconds), signature: "0x" };
  input.signature = await signer.signMessage({ message: receiptAuthorizationMessage(input, context) });
  return input;
}

async function records(signer = buyer, seconds = 60) {
  const input = { raffleIds: [], purchases: [{ transactionHash, logIndex: 3 }] };
  const deadline = String(Math.floor(now / 1000) + seconds);
  return { address: signer.address, input, deadline, signature: await signer.signMessage({ message: workflowMessage("private records", context, signer.address, input, deadline) }) };
}

describe("a purchase receipt belongs to the wallet that bought", () => {
  it("refuses another wallet's validly signed request before the buyer has asked, leaving nothing stored or sent", async () => {
    const store = new MemoryStore(), set = vi.spyOn(store, "setIfAbsent");
    const send = vi.fn(async (_body: MailPayload, _key: string) => true);
    await expect(deliverPurchaseReceipt(store, await receipt(outsider, "thief@example.com"), context, reader(), send, from, transport, now)).rejects.toThrow("A finalized LABx purchase could not be verified.");
    expect(set).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses another wallet's request for a purchase the buyer already has a receipt for", async () => {
    const store = new MemoryStore();
    const send = vi.fn(async (_body: MailPayload, _key: string) => true);
    await deliverPurchaseReceipt(store, await receipt(), context, reader(), send, from, transport, now);
    await expect(deliverPurchaseReceipt(store, await receipt(outsider, "thief@example.com"), context, reader(), send, from, transport, now)).rejects.toThrow("Receipt is already bound to another request or its record is invalid.");
    await expect(deliverPurchaseReceipt(store, await receipt(outsider, "buyer@example.com"), context, reader(), send, from, transport, now)).rejects.toThrow("Receipt is already bound to another request or its record is invalid.");
    expect(send.mock.calls.map(call => call[0].to)).toEqual(["buyer@example.com"]);
  });

  it("shows the receipt email to the buyer and not to another wallet naming the same purchase", async () => {
    const store = new MemoryStore();
    await deliverPurchaseReceipt(store, await receipt(), context, reader(), async () => true, from, transport, now);
    expect((await privateRecords(store, await records(buyer), context, verifyMessage, transport, now)).receipts).toEqual([
      { transactionHash, logIndex: 3, sent: [{ to: "buyer@example.com", status: "delivered" }], full: false }
    ]);
    const seen = await privateRecords(store, await records(outsider), context, verifyMessage, transport, now);
    expect(seen.receipts).toEqual([{ transactionHash, logIndex: 3, sent: [], full: false }]);
    expect(JSON.stringify(seen)).not.toContain("buyer@example.com");
  });
});

describe("a signed request is short-lived", () => {
  it("refuses a receipt signed for more than ten minutes ahead", async () => {
    const send = vi.fn(async (_body: MailPayload, _key: string) => true);
    await expect(deliverPurchaseReceipt(new MemoryStore(), await receipt(buyer, "buyer@example.com", 601), context, reader(), send, from, transport, now)).rejects.toThrow("Receipt authorization was refused.");
    await expect(deliverPurchaseReceipt(new MemoryStore(), await receipt(buyer, "buyer@example.com", 600), context, reader(), send, from, transport, now)).resolves.toEqual({ delivered: true, repeated: false });
  });

  it("refuses a workflow request signed for more than ten minutes ahead", async () => {
    const late = await records(buyer, 601), onTime = await records(buyer, 600);
    await expect(verifyWorkflowAuthorization({ operation: "private records", context, account: buyer.address, input: late.input, deadline: late.deadline, signature: late.signature, verify: verifyMessage, now })).rejects.toThrow("Wallet authorization expired. Please retry.");
    await expect(verifyWorkflowAuthorization({ operation: "private records", context, account: buyer.address, input: onTime.input, deadline: onTime.deadline, signature: onTime.signature, verify: verifyMessage, now })).resolves.toContain("LABx private records v3");
  });
});

describe("bot check-in", () => {
  const day = utcDay(now);
  const sign = (signer = buyer, address: Address = signer.address, on = day) => signer.signMessage({ message: checkInMessage(address, on) });

  it("awards points only with the server token and the wallet's own signature for today", async () => {
    const store = new MemoryStore(), set = vi.spyOn(store, "set");
    const signature = await sign();
    const attempt = (overrides: Partial<Parameters<typeof checkIn>[1]>) => checkIn(store, { address: buyer.address, signature, botToken: "bot-secret-of-useful-length", expectedToken: "bot-secret-of-useful-length", now, ...overrides });
    await expect(attempt({ botToken: "wrong-secret-of-useful-len" })).rejects.toThrow("Bot gate refused the check-in.");
    await expect(attempt({ botToken: null })).rejects.toThrow("Bot gate refused the check-in.");
    await expect(attempt({ botToken: "", expectedToken: "" })).rejects.toThrow("Bot gate refused the check-in.");
    await expect(attempt({ botToken: "undefined", expectedToken: undefined })).rejects.toThrow("Bot gate refused the check-in.");
    await expect(attempt({ signature: await sign(buyer, buyer.address, utcDay(now - 86_400_000)) })).rejects.toThrow("Check-in signature does not match this wallet.");
    await expect(attempt({ signature: await sign(outsider, buyer.address) })).rejects.toThrow("Check-in signature does not match this wallet.");
    await expect(attempt({ address: outsider.address })).rejects.toThrow("Check-in signature does not match this wallet.");
    expect(set).not.toHaveBeenCalled();
    await expect(attempt({})).resolves.toEqual({ balance: 10, lastDay: day, awarded: 10 });
  });

  describe("route", () => {
    beforeEach(() => {
      vi.stubEnv("VERCEL", undefined);
      vi.stubEnv("LABX_STORE", "memory");
      vi.stubEnv("BOT_CHECKIN_TOKEN", "bot-secret");
      vi.spyOn(Date, "now").mockReturnValue(now);
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

    const post = (body: unknown, token = "bot-secret") => checkInRoute(new Request("http://localhost/api/bot/check-in", { method: "POST", headers: { "x-labx-bot-token": token }, body: JSON.stringify(body) }));
    const internal = "connect ECONNREFUSED db-internal.example:5432 user=labx_owner";

    it.each(["get", "set"] as const)("reports a storage %s failure as unavailable, without the internal error text", async method => {
      vi.spyOn(MemoryStore.prototype, method).mockRejectedValue(new Error(internal));
      const response = await post({ address: buyer.address, signature: await sign() });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: "Check-in could not be completed." });
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toBe('[["bot-check-in unavailable"]]');
    });

    it("gives a caller without the token nothing about a misconfigured store", async () => {
      vi.stubEnv("LABX_STORE", "not-a-store");
      const response = await post({ address: buyer.address, signature: await sign() }, "guess");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: "Check-in could not be completed." });
    });

    it("refuses a wrong token with a valid signature and writes nothing", async () => {
      const set = vi.spyOn(MemoryStore.prototype, "set");
      const response = await post({ address: buyer.address, signature: await sign() }, "wrong-secret");
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, error: "Bot gate refused the check-in." });
      expect(set).not.toHaveBeenCalled();
    });

    it("answers a malformed signature with the fixed refusal, not the verifier's error text", async () => {
      const response = await post({ address: buyer.address, signature: "0x12" });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, error: "Check-in signature does not match this wallet." });
    });
  });
});

describe("points are public", () => {
  beforeEach(() => { vi.stubEnv("VERCEL", undefined); vi.stubEnv("LABX_STORE", "memory"); });
  afterEach(() => vi.unstubAllEnvs());

  it("returns any wallet's balance without a signature and refuses a value that is not an address", async () => {
    const response = await pointsRoute(new Request(`http://localhost/api/points?address=${outsider.address}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, address: outsider.address, balance: 0, lastDay: "", persistent: false });
    expect((await pointsRoute(new Request("http://localhost/api/points?address=0x12"))).status).toBe(400);
  });
});
