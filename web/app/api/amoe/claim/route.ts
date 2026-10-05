import { isAddress, isHex, type Hex } from "viem";
import { AmoeRequestError, configuredAmoeContext, issueAmoeClaim } from "@/lib/amoe";
import { readPoints } from "@/lib/points";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.address !== "string" || !isAddress(body.address)) {
      return fail(new Error("A wallet is required."));
    }
    if (body.terms !== true || body.rules !== true || body.age !== true) return fail(new Error("All three agreements are required."));
    if (typeof body.pieceId !== "string" || typeof body.id !== "string" || typeof body.answer !== "string" ||
        typeof body.mac !== "string" || typeof body.expiresAt !== "number" ||
        (body.raffleId !== undefined && typeof body.raffleId !== "string")) {
      return fail(new Error("The captcha challenge or piece is incomplete."));
    }
    if (typeof body.authorization?.deadline !== "string" || typeof body.authorization?.signature !== "string" ||
        !isHex(body.authorization.signature, { strict: true })) return fail(new Error("Wallet authorization is required."), 401);
    const store = activeStore();
    const points = await readPoints(store, body.address);
    const issued = await issueAmoeClaim(store, {
      address: body.address,
      pieceId: body.pieceId,
      raffleId: body.raffleId,
      captchaId: body.id,
      answer: body.answer,
      expiresAt: body.expiresAt,
      captchaMac: body.mac,
      captchaSecret: process.env.CAPTCHA_SECRET || process.env.BOT_CHECKIN_TOKEN,
      points: points.balance,
      signerKey: process.env.AMOE_SIGNER_PRIVATE_KEY,
      context: configuredAmoeContext(),
      authorization: { deadline: body.authorization.deadline, signature: body.authorization.signature as Hex }
    });
    return json({ ok: true, ...issued });
  } catch (error) {
    if (!(error instanceof AmoeRequestError)) {
      return fail(new Error("Complimentary entry request could not be completed. Please retry."), 503);
    }
    const message = error.message;
    const status = /already recorded|already used|reconciliation/i.test(message) ? 409
      : /Check in/i.test(message) ? 403 : /configuration|signer/i.test(message) ? 503
      : /authorization|Captcha/i.test(message) ? 401 : 400;
    return fail(error, status);
  }
}
