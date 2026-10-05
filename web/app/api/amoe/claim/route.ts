import { isAddress, isHex, type Address, type Hex } from "viem";
import { issueAmoeClaim } from "@/lib/amoe";
import { verifyChallenge } from "@/lib/captcha";
import { readPoints } from "@/lib/points";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      address?: string;
      pieceId?: string;
      raffleId?: string;
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
    const terms = process.env.TERMS_HASH;
    const labx = process.env.NEXT_PUBLIC_RAFFLE_ADDRESS;
    const chainRaw = process.env.NEXT_PUBLIC_CHAIN_ID;
    const issued = await issueAmoeClaim(store, {
      address: body.address,
      pieceId: body.pieceId || "none",
      raffleId: body.raffleId,
      captchaId: body.id,
      answer: body.answer,
      expiresAt: body.expiresAt,
      points: points.balance,
      signerKey: process.env.AMOE_SIGNER_PRIVATE_KEY,
      chainId: chainRaw ? BigInt(chainRaw) : undefined,
      verifyingContract: labx && isAddress(labx) ? labx : null,
      termsHash: terms && isHex(terms, { strict: true }) && terms.length === 66 ? (terms as Hex) : null
    });
    return json({ ok: true, ...issued });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = /already recorded|already used/i.test(message) ? 409 : /Check in/i.test(message) ? 403 : 400;
    return fail(error, status);
  }
}
