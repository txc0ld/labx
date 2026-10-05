import { isAddress, type Address, type Hex } from "viem";
import { allowReceipt, receiptBody, sendReceipt, verifyReceipt, type Receipt } from "@/lib/email";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<Receipt> & {
      address?: string;
      signature?: string;
      deadline?: string | number;
    };
    if (!body.to || !body.to.includes("@") || !body.piece || !body.pack) {
      return fail(new Error("Email, piece, and pack are required."));
    }
    if (!body.address || !isAddress(body.address) || !body.signature || body.deadline === undefined) {
      return fail(new Error("A wallet signature is required."), 401);
    }
    const receipt: Receipt = {
      to: body.to,
      piece: body.piece,
      pack: body.pack,
      entries: Number(body.entries) || 0,
      priceUsdc: Number(body.priceUsdc) || 0,
      feeUsdc: Number(body.feeUsdc) || 5
    };
    const accepted = await verifyReceipt({
      address: body.address,
      to: receipt.to,
      piece: receipt.piece,
      pack: receipt.pack,
      deadline: BigInt(body.deadline),
      signature: body.signature as Hex
    });
    if (!accepted) return fail(new Error("Receipt signature was refused."), 401);
    if (!allowReceipt(body.address)) return fail(new Error("Too many receipt requests."), 429);
    const preview = receiptBody(receipt);
    if (/\btickets?\b/i.test(preview.text)) return fail(new Error("Receipt copy was refused."));
    const result = await sendReceipt(receipt);
    return json({ ok: true, ...result, subject: preview.subject });
  } catch (error) {
    return fail(error);
  }
}
