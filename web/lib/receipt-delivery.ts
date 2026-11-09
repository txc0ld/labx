import { isAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { receiptBody, type Receipt } from "./email";
import { authorizationMessage, authorizedRequest, type RequestContext, type SignatureVerifier } from "./request-auth";
import { verifiedPurchase, type PurchaseReader } from "./purchase-proof";
import type { Store } from "./points";
import { sameAddress } from "./chain/validation";

export type ReceiptRequest = { address: Address; to: string; transactionHash: Hex; logIndex: number; deadline: string; signature: Hex };
export type MailPayload = { from: string; to: string; subject: string; html: string; text: string };
type Delivery = { version: 2; identity: string; address: string; to: string; createdAt: number; transportIdentity: string; payload: MailPayload };
export type MailSender = (payload: MailPayload, idempotencyKey: string) => Promise<boolean>;
const RETRY_WINDOW = 23 * 60 * 60 * 1000; // Inside the provider's documented 24-hour idempotency retention.
/** A reservation dated at most this far ahead was written by an overlapping request that started later, or by a server whose clock runs ahead. It is the hour the retry window leaves before that retention ends. */
const CLOCK_SKEW = 60 * 60 * 1000;
/** The first address and two corrections. */
const MAX_RECIPIENTS = 3;

export function receiptAuthorizationMessage(input: ReceiptRequest, context: RequestContext): string {
  return authorizationMessage("purchase receipt", context, {
    address: input.address.toLowerCase(), to: input.to, transactionHash: input.transactionHash.toLowerCase(),
    logIndex: input.logIndex, deadline: input.deadline
  });
}

export async function deliverPurchaseReceipt(store: Store, input: ReceiptRequest, context: RequestContext, reader: PurchaseReader, sender: MailSender, from: string, transportIdentity: string, now = Date.now(), verifier?: SignatureVerifier) {
  if (!input || typeof input.address !== "string" || !isAddress(input.address) || typeof input.to !== "string" || input.to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) throw new Error("A valid wallet and receipt email are required.");
  if (typeof input.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash) || !Number.isSafeInteger(input.logIndex) || input.logIndex < 0) throw new Error("A purchase transaction and log index are required.");
  if (!await authorizedRequest(input.address, input.deadline, input.signature, receiptAuthorizationMessage(input, context), now, verifier)) throw new Error("Receipt authorization was refused.");
  if (!from || /[\r\n]/.test(from) || !/^[0-9a-f]{64}$/.test(transportIdentity)) throw new Error("Receipt delivery is not configured.");
  const { identity, key } = receiptIdentity(context, input);
  // Each address has its own first-wins reservation and provider key, so a buyer can correct a mistyped address and
  // no address is sent the same receipt twice.
  let candidate: Delivery | null = null, slot = "", delivery: Delivery | null = null;
  for (let index = 0; index < MAX_RECIPIENTS && !delivery; index++) {
    slot = recipientKey(key, index);
    let raw = await store.get(slot);
    if (!raw) {
      if (!candidate) {
        const purchase = await verifiedPurchase(input, context, reader);
        const receipt: Receipt = { to: input.to, piece: purchase.piece, pack: purchase.pack, entries: purchase.entries, priceUsdc: purchase.priceUsdc, feeUsdc: purchase.feeUsdc };
        candidate = { version: 2, identity, address: input.address.toLowerCase(), to: input.to, createdAt: now, transportIdentity, payload: { from, to: input.to, ...receiptBody(receipt) } };
      }
      await store.setIfAbsent({ [slot]: JSON.stringify(candidate) });
      raw = await store.get(slot);
    }
    if (!raw) throw new Error("Receipt reservation was not persisted.");
    let stored: Delivery;
    try { stored = JSON.parse(raw) as Delivery; } catch { throw new Error("Receipt record is invalid."); }
    if (stored.version !== 2 || stored.identity !== identity || stored.address !== input.address.toLowerCase() || typeof stored.to !== "string" || stored.payload?.to !== stored.to || !Number.isFinite(stored.createdAt) || typeof stored.payload.from !== "string" || typeof stored.payload.subject !== "string" || typeof stored.payload.html !== "string" || typeof stored.payload.text !== "string") throw new Error("Receipt is already bound to another request or its record is invalid.");
    if (sameRecipient(stored.to, input.to)) delivery = stored;
  }
  if (!delivery) throw new Error("Receipt already went to three addresses.");
  const sent = await store.get(`${slot}:sent`);
  if (sent === "delivered") return { delivered: true, repeated: true };
  if (sent !== null) throw new Error("Receipt delivery record is invalid.");
  if (delivery.transportIdentity !== transportIdentity) throw new Error("Receipt delivery needs reconciliation after provider credentials changed.");
  if (delivery.createdAt - now > CLOCK_SKEW || now - delivery.createdAt >= RETRY_WINDOW) throw new Error("Receipt delivery needs reconciliation; the safe retry window has ended.");
  // Identical persisted payload and event key make overlapping requests/uncertain retries idempotent.
  const delivered = await sender(delivery.payload, slot);
  if (!delivered) return { delivered: false, reason: "Receipt delivery was not acknowledged; retry the same purchase and email." };
  await store.setIfAbsent({ [`${slot}:sent`]: "delivered" });
  return { delivered: true, repeated: false };
}

/** Pending can still be sent by a request for that address; unconfirmed cannot. */
export type ReceiptSend = { to: string; status: "pending" | "unconfirmed" | "delivered" };
/** Each address a purchase's receipt was reserved for, oldest first. Full means a new address would be refused. */
export type ReceiptStatus = { sent: ReceiptSend[]; full: boolean };

/** Email addresses that differ only in letter case name the same recipient. */
export function sameRecipient(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

export async function receiptStatus(store: Store, context: RequestContext, purchase: { transactionHash: Hex; logIndex: number }, address: Address, transportIdentity: string | null, now: number): Promise<ReceiptStatus> {
  const { identity, key } = receiptIdentity(context, purchase);
  const sent: ReceiptSend[] = [];
  for (let index = 0; index < MAX_RECIPIENTS; index++) {
    const slot = recipientKey(key, index);
    const raw = await store.get(slot);
    if (!raw) break;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || !("address" in record) || typeof record.address !== "string" || !sameAddress(record.address, address) || !("identity" in record) || record.identity !== identity || !("to" in record) || typeof record.to !== "string") break;
    const retryable = "transportIdentity" in record && record.transportIdentity === transportIdentity && "createdAt" in record && typeof record.createdAt === "number" && record.createdAt - now <= CLOCK_SKEW && now - record.createdAt < RETRY_WINDOW;
    sent.push({ to: record.to, status: await store.get(`${slot}:sent`) === "delivered" ? "delivered" : retryable ? "pending" : "unconfirmed" });
  }
  return { sent, full: sent.length === MAX_RECIPIENTS };
}

function receiptIdentity(context: RequestContext, purchase: { transactionHash: Hex; logIndex: number }) {
  const identity = `${context.chainId}:${context.contract.toLowerCase()}:${purchase.transactionHash.toLowerCase()}:${purchase.logIndex}`;
  return { identity, key: `receipt:v2:${keccak256(toBytes(identity))}` };
}

/** The first address keeps the original reservation key, so receipts reserved before corrections were allowed still match. */
function recipientKey(key: string, index: number) {
  return index ? `${key}:${index}` : key;
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
