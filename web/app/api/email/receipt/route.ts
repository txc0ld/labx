import { receiptBody, sendReceipt, type Receipt } from "@/lib/email";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<Receipt>;
    if (!body.to || !body.to.includes("@") || !body.piece || !body.pack) {
      return fail(new Error("Email, piece, and pack are required."));
    }
    const receipt: Receipt = {
      to: body.to,
      piece: body.piece,
      pack: body.pack,
      entries: Number(body.entries) || 0,
      priceUsdc: Number(body.priceUsdc) || 0,
      feeUsdc: Number(body.feeUsdc) || 5
    };
    const preview = receiptBody(receipt);
    if (/\btickets?\b/i.test(preview.text)) return fail(new Error("Receipt copy was refused."));
    const result = await sendReceipt(receipt);
    return json({ ok: true, ...result, subject: preview.subject });
  } catch (error) {
    return fail(error);
  }
}
