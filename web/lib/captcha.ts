import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export type Challenge = {
  id: string;
  prompt: string;
  expiresAt: number;
  mac: string;
};

export function issueChallenge(secret: string, now = Date.now()): Challenge & { answer: number } {
  const a = 2 + (now % 7);
  const b = 3 + (now % 5);
  const answer = a + b;
  const id = randomBytes(16).toString("hex");
  const expiresAt = now + 10 * 60 * 1000;
  const mac = signChallenge(secret, id, String(answer), expiresAt);
  return { id, prompt: `What is ${a} + ${b}?`, expiresAt, mac, answer };
}

export function signChallenge(secret: string, id: string, answer: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`${id}:${answer}:${expiresAt}`).digest("hex");
}

export function verifyChallenge(
  secret: string,
  input: { id: string; answer: string; expiresAt: number; mac: string },
  now = Date.now()
): boolean {
  if (!secret || now > input.expiresAt) return false;
  const expected = signChallenge(secret, input.id, input.answer.trim(), input.expiresAt);
  const a = Buffer.from(expected);
  const b = Buffer.from(input.mac);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
