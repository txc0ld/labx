import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { POST as challengePost } from "../app/api/amoe/challenge/route";
import { POST as claimPost } from "../app/api/amoe/claim/route";
import { amoeAuthorizationMessage, captchaDigest, type AmoeContext } from "../lib/amoe-authorization";
import { memoryStore } from "../lib/store";

const now = 1_700_000_000_000;
const signerKey = generatePrivateKey();
const wallet = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());
type Challenge = { id: string; prompt: string; expiresAt: number; mac: string; context: AmoeContext };

beforeEach(() => {
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("UPSTASH_REDIS_REST_URL", undefined);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", undefined);
  vi.stubEnv("LABX_STORE", "memory");
  vi.stubEnv("CAPTCHA_SECRET", "fixture-only-secret");
  vi.stubEnv("BOT_CHECKIN_TOKEN", undefined);
  vi.stubEnv("AMOE_SIGNER_PRIVATE_KEY", signerKey);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://labx.example");
  vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "11155111");
  vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", "0x1111111111111111111111111111111111111111");
  vi.stubEnv("TERMS_HASH", `0x${"a".repeat(64)}`);
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function payload(raffleId: string, account = wallet) {
  const response = await challengePost();
  expect(response.status).toBe(200);
  const challenge = await response.json() as Challenge;
  const numbers = challenge.prompt.match(/\d+/g)!.map(Number);
  const answer = String(numbers[0] + numbers[1]);
  const deadline = String(Math.trunc(Date.now() / 1000) + 600);
  const pieceId = `piece-${raffleId}`;
  const signature = await account.signMessage({ message: amoeAuthorizationMessage({ context: challenge.context,
    address: wallet.address, pieceId, raffleId, captchaDigest: captchaDigest(challenge.id, answer, challenge.expiresAt), deadline }) });
  await memoryStore().set(`points:${wallet.address.toLowerCase()}`, '{"balance":10,"lastDay":"2023-11-14"}');
  return { ...challenge, address: wallet.address, pieceId, raffleId, answer, terms: true, rules: true, age: true,
    authorization: { signature, deadline } };
}

function post(body: unknown) {
  return claimPost(new Request("https://labx.example/api/amoe/claim", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }));
}

describe("AMOE HTTP ownership and recovery", () => {
  it("does not expose backend paths or signer configuration in error responses", async () => {
    const body = await payload("705");
    vi.spyOn(memoryStore(), "setIfAbsent").mockRejectedValueOnce(new Error("fixture-private-backend-path"));
    const failedWrite = await post(body);
    expect(failedWrite.status).toBe(503);
    expect(await failedWrite.json()).toEqual({ ok: false, error: "Complimentary entry request could not be completed. Please retry." });
    vi.stubEnv("AMOE_SIGNER_PRIVATE_KEY", "fixture-private-signer-value");
    const failedSigner = await post(body);
    expect(failedSigner.status).toBe(503);
    expect(await failedSigner.json()).toEqual({ ok: false, error: "AMOE signer is not configured correctly." });
    vi.stubEnv("AMOE_SIGNER_PRIVATE_KEY", signerKey);
    expect((await post(body)).status).toBe(200);
  });

  it("rejects missing or victim-mismatched authorization, then lets the victim issue and retry", async () => {
    const body = await payload("701");
    expect((await post({ ...body, authorization: undefined })).status).toBe(401);
    expect((await post(await payload("701", attacker))).status).toBe(401);
    const response = await post(body);
    expect(response.status).toBe(200);
    const issued = await response.json();
    expect(issued.mode).toBe("signed");
    const retry = await post(body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(issued);
  });

  it("returns the same issued signature to concurrent HTTP requests", async () => {
    const body = await payload("702");
    const responses = await Promise.all(Array.from({ length: 8 }, () => post(body)));
    for (const response of responses) expect(response.status).toBe(200);
    const results = await Promise.all(responses.map((response) => response.json()));
    for (const result of results) expect(result).toEqual(results[0]);
  });

  it("rejects truthy non-boolean consent without consuming the valid request", async () => {
    const body = await payload("703");
    expect((await post({ ...body, terms: "true" })).status).toBe(400);
    expect((await post(body)).status).toBe(200);
  });

  it("uses server configuration instead of caller-supplied domain or terms", async () => {
    const body = await payload("704");
    const fakeContext = { ...body.context, domain: "https://attacker.example" };
    const signature = await wallet.signMessage({ message: amoeAuthorizationMessage({ context: fakeContext,
      address: wallet.address, pieceId: body.pieceId, raffleId: body.raffleId,
      captchaDigest: captchaDigest(body.id, body.answer, body.expiresAt), deadline: body.authorization.deadline }) });
    expect((await post({ ...body, context: fakeContext, authorization: { ...body.authorization, signature } })).status).toBe(401);
    expect((await post(body)).status).toBe(200);
    vi.stubEnv("TERMS_HASH", `0x${"b".repeat(64)}`);
    const changedTerms = await post(await payload("704"));
    expect(changedTerms.status).toBe(409);
    expect((await changedTerms.json()).error).toMatch(/reconciliation/i);
  });
});
