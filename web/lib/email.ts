import { verifyMessage, type Address, type Hex } from "viem";

export type Receipt = {
  to: string;
  piece: string;
  pack: string;
  entries: number;
  priceUsdc: number;
  feeUsdc: number;
};

export function receiptBody(input: Receipt): { subject: string; html: string; text: string } {
  const subject = `LABx membership pack — ${input.piece}`;
  const text = [
    `Membership pack: ${input.pack}`,
    `Piece: ${input.piece}`,
    `Bonus entries: ${input.entries}`,
    `Pack price: ${input.priceUsdc} USDC`,
    `Lab fee: ${input.feeUsdc} USDC, paid to the treasury`,
    "Bonus entries expire 12 months after they are recorded.",
    "This note is a membership receipt."
  ].join("\n");
  const html = `<p>Your <strong>${escapeHtml(input.pack)}</strong> membership pack for <strong>${escapeHtml(input.piece)}</strong> is recorded.</p>
<p>${input.entries} bonus entries. Pack price ${input.priceUsdc} USDC. Lab fee ${input.feeUsdc} USDC to the treasury.</p>
<p>Bonus entries expire 12 months after they are recorded.</p>`;
  return { subject, html, text };
}

const RECEIPT_WINDOW = 10n * 60n;
const receiptHits = new Map<string, number[]>();

export function receiptMessage(address: Address, to: string, piece: string, pack: string, deadline: bigint): string {
  return `LABx receipt\n${address}\n${to}\n${piece}\n${pack}\n${deadline}`;
}

export async function verifyReceipt(args: {
  address: Address;
  to: string;
  piece: string;
  pack: string;
  deadline: bigint;
  signature: Hex;
  now?: bigint;
}): Promise<boolean> {
  const now = args.now ?? BigInt(Math.trunc(Date.now() / 1000));
  if (args.deadline < now || args.deadline > now + RECEIPT_WINDOW) return false;
  return verifyMessage({
    address: args.address,
    message: receiptMessage(args.address, args.to, args.piece, args.pack, args.deadline),
    signature: args.signature
  });
}

export function allowReceipt(address: string, now = Date.now(), windowMs = 60_000, max = 5): boolean {
  const key = address.toLowerCase();
  const prev = (receiptHits.get(key) || []).filter((stamp) => now - stamp < windowMs);
  if (prev.length >= max) {
    receiptHits.set(key, prev);
    return false;
  }
  prev.push(now);
  receiptHits.set(key, prev);
  return true;
}

export function resetReceiptRateLimit(): void {
  receiptHits.clear();
}

export async function sendReceipt(input: Receipt, env = process.env): Promise<{ delivered: boolean; reason?: string }> {
  const key = env.RESEND_API_KEY;
  const from = env.RESEND_FROM;
  if (!key || !from) return { delivered: false, reason: "RESEND_API_KEY or RESEND_FROM is not set" };
  const body = receiptBody(input);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from, to: input.to, subject: body.subject, html: body.html, text: body.text })
  });
  if (!response.ok) return { delivered: false, reason: `Resend responded ${response.status}` };
  return { delivered: true };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
