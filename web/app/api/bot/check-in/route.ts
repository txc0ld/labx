import { isAddress, type Address, type Hex } from "viem";
import { checkIn } from "@/lib/points";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { address?: string; signature?: string };
    if (!body.address || !isAddress(body.address) || !body.signature) {
      return fail(new Error("Wallet and signature are required."));
    }
    const result = await checkIn(activeStore(), {
      address: body.address as Address,
      signature: body.signature as Hex,
      botToken: request.headers.get("x-labx-bot-token"),
      expectedToken: process.env.BOT_CHECKIN_TOKEN
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return fail(error, 401);
  }
}
