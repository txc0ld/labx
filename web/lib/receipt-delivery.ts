import { isAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { receiptBody, type Receipt } from "./email";
import { authorizationMessage, authorizedRequest, type RequestContext } from "./request-auth";
import { verifiedPurchase, type PurchaseReader } from "./purchase-proof";
import type { Store } from "./points";

export type ReceiptRequest = { address: Address; to: string; transactionHash: Hex; logIndex: number; deadline: string; signature: Hex };
export type MailPayload = { from: string; to: string; subject: string; html: string; text: string };
type Delivery = { version: 2; identity: string; address: string; to: string; createdAt: number; transportIdentity: string; payload: MailPayload };
export type MailSender = (payload: MailPayload, idempotencyKey: string) => Promise<boolean>;
const RETRY_WINDOW = 23 * 60 * 60 * 1000; // Inside the provider's documented 24-hour idempotency retention.

export function receiptAuthorizationMessage(input: ReceiptRequest, context: RequestContext): string {
  return authorizationMessage("purchase receipt", context, {
    address: input.address.toLowerCase(), to: input.to, transactionHash: input.transactionHash.toLowerCase(),
    logIndex: input.logIndex, deadline: input.deadline
  });
}

export async function deliverPurchaseReceipt(store: Store, input: ReceiptRequest, context: RequestContext, reader: PurchaseReader, sender: MailSender, from: string, transportIdentity: string, now = Date.now()) {
  if (!input || typeof input.address !== "string" || !isAddress(input.address) || typeof input.to !== "string" || input.to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) throw new Error("A valid wallet and receipt email are required.");
  if (typeof input.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash) || !Number.isSafeInteger(input.logIndex) || input.logIndex < 0) throw new Error("A purchase transaction and log index are required.");
  if (!await authorizedRequest(input.address, input.deadline, input.signature, receiptAuthorizationMessage(input, context), now)) throw new Error("Receipt authorization was refused.");
  if (!from || /[\r\n]/.test(from) || !/^[0-9a-f]{64}$/.test(transportIdentity)) throw new Error("Receipt delivery is not configured.");
  const identity = `${context.chainId}:${context.contract.toLowerCase()}:${input.transactionHash.toLowerCase()}:${input.logIndex}`;
  const key = `receipt:v2:${keccak256(toBytes(identity))}`;
  let raw = await store.get(key);
  if (!raw) {
    const purchase = await verifiedPurchase(input, context, reader);
    const receipt: Receipt = { to: input.to, piece: purchase.piece, pack: purchase.pack, entries: purchase.entries, priceUsdc: purchase.priceUsdc, feeUsdc: purchase.feeUsdc };
    const candidate: Delivery = { version: 2, identity, address: input.address.toLowerCase(), to: input.to, createdAt: now, transportIdentity, payload: { from, to: input.to, ...receiptBody(receipt) } };
    await store.setIfAbsent({ [key]: JSON.stringify(candidate) });
    raw = await store.get(key);
  }
  if (!raw) throw new Error("Receipt reservation was not persisted.");
  let delivery: Delivery;
  try { delivery = JSON.parse(raw) as Delivery; } catch { throw new Error("Receipt record is invalid."); }
  if (delivery.version !== 2 || delivery.identity !== identity || delivery.address !== input.address.toLowerCase() || delivery.to !== input.to || delivery.payload?.to !== input.to || !Number.isFinite(delivery.createdAt) || typeof delivery.payload.from !== "string" || typeof delivery.payload.subject !== "string" || typeof delivery.payload.html !== "string" || typeof delivery.payload.text !== "string") throw new Error("Receipt is already bound to another request or its record is invalid.");
  const sent = await store.get(`${key}:sent`);
  if (sent === "delivered") return { delivered: true, repeated: true };
  if (sent !== null) throw new Error("Receipt delivery record is invalid.");
  if (delivery.transportIdentity !== transportIdentity) throw new Error("Receipt delivery needs reconciliation after provider credentials changed.");
  if (now < delivery.createdAt || now - delivery.createdAt >= RETRY_WINDOW) throw new Error("Receipt delivery needs reconciliation; the safe retry window has ended.");
  // Identical persisted payload and event key make overlapping requests/uncertain retries idempotent.
  const delivered = await sender(delivery.payload, key);
  if (!delivered) return { delivered: false, reason: "Receipt delivery was not acknowledged; retry the same purchase and email." };
  await store.setIfAbsent({ [`${key}:sent`]: "delivered" });
  return { delivered: true, repeated: false };
}

export function resendSender(apiKey: string): MailSender {
  return async (payload, idempotencyKey) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return false;
    let result: unknown;
    try { result = await response.json(); } catch { return false; }
    return !!result && typeof result === "object" && "id" in result && typeof result.id === "string" && !!result.id;
  };
}
