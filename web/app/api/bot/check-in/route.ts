import { isAddress, isHex } from "viem";
import { checkIn } from "@/lib/points";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";
import { workflowRequestBody } from "@/lib/chain/request-body";

export async function POST(request: Request) {
  try {
    const body = await workflowRequestBody(request);
    if (typeof body.address !== "string" || !isAddress(body.address) || typeof body.signature !== "string" || !isHex(body.signature, { strict: true })) {
      return fail(new Error("Wallet and signature are required."));
    }
    const result = await checkIn(activeStore(), {
      address: body.address,
      signature: body.signature,
      botToken: request.headers.get("x-labx-bot-token"),
      expectedToken: process.env.BOT_CHECKIN_TOKEN
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return fail(error, 401);
  }
}
