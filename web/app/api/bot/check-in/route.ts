import { isAddress, isHex } from "viem";
import { checkIn, CheckInRefusal } from "@/lib/points";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";
import { workflowRequestBody } from "@/lib/chain/request-body";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await workflowRequestBody(request);
  } catch (error) {
    return fail(error, 401);
  }
  if (typeof body.address !== "string" || !isAddress(body.address) || typeof body.signature !== "string" || !isHex(body.signature, { strict: true })) {
    return fail(new Error("Wallet and signature are required."));
  }
  try {
    const result = await checkIn(activeStore(), {
      address: body.address,
      signature: body.signature,
      botToken: request.headers.get("x-labx-bot-token"),
      expectedToken: process.env.BOT_CHECKIN_TOKEN
    });
    return json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof CheckInRefusal) return fail(error, 401);
    // A storage failure is not a refusal, and its text can name internal hosts, so the response and the log line are fixed.
    console.error("bot-check-in unavailable");
    return fail(new Error("Check-in could not be completed."), 503);
  }
}
