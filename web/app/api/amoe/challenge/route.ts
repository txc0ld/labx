import { issueChallenge } from "@/lib/captcha";
import { fail, json } from "@/lib/http";

export async function POST() {
  const secret = process.env.CAPTCHA_SECRET || process.env.BOT_CHECKIN_TOKEN;
  if (!secret) return fail(new Error("CAPTCHA_SECRET is not set."), 503);
  const challenge = issueChallenge(secret);
  return json({
    ok: true,
    id: challenge.id,
    prompt: challenge.prompt,
    expiresAt: challenge.expiresAt,
    mac: challenge.mac
  });
}
