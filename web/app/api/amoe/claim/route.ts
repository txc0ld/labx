import { isAddress, type Address } from "viem";
import { verifyChallenge } from "@/lib/captcha";
import { readPoints } from "@/lib/points";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      address?: string;
      pieceId?: string;
      terms?: boolean;
      rules?: boolean;
      age?: boolean;
      id?: string;
      answer?: string;
      expiresAt?: number;
      mac?: string;
    };
    if (!body.address || !isAddress(body.address)) return fail(new Error("A wallet is required."));
    if (!body.terms || !body.rules || !body.age) return fail(new Error("All three agreements are required."));
    const secret = process.env.CAPTCHA_SECRET || process.env.BOT_CHECKIN_TOKEN;
    if (!secret || !body.id || !body.answer || !body.expiresAt || !body.mac) {
      return fail(new Error("The captcha challenge is incomplete."));
    }
    const passed = verifyChallenge(secret, {
      id: body.id,
      answer: body.answer,
      expiresAt: body.expiresAt,
      mac: body.mac
    });
    if (!passed) return fail(new Error("Captcha answer was refused."), 401);
    const store = activeStore();
    const points = await readPoints(store, body.address as Address);
    if (points.balance < 10) {
      return fail(new Error("Check in with the lab bot before requesting a complimentary entry."), 403);
    }
    const key = `amoe:${body.pieceId || "none"}:${body.address.toLowerCase()}`;
    if (await store.get(key)) return fail(new Error("A complimentary entry is already recorded for this piece."), 409);
    await store.set(key, JSON.stringify({ at: new Date().toISOString() }));
    return json({
      ok: true,
      mode: process.env.AMOE_SIGNER_PRIVATE_KEY ? "signer-ready" : "bench",
      pieceId: body.pieceId,
      address: body.address,
      entries: 1
    });
  } catch (error) {
    return fail(error);
  }
}
