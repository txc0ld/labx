import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Hex } from "viem";
import { configuredAmoeContext, issueAmoeClaim, type AmoeInput } from "../lib/amoe";
import { amoeAuthorizationMessage, captchaDigest, type AmoeContext } from "../lib/amoe-authorization";
import { issueChallenge } from "../lib/captcha";
import { MemoryStore } from "../lib/store";

const now = 1_700_000_000_000;
const wallet = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const signerKey = generatePrivateKey();
const context: AmoeContext = { domain: "https://labx.example", mode: "signed", chainId: "11155111",
  verifyingContract: "0x1111111111111111111111111111111111111111", termsHash: `0x${"a".repeat(64)}` };

async function authorize(input: AmoeInput, account = wallet): Promise<AmoeInput> {
  const deadline = String(Math.trunc((input.now ?? now) / 1000) + 600);
  const signature = await account.signMessage({ message: amoeAuthorizationMessage({ context: input.context!,
    address: input.address, pieceId: input.pieceId, raffleId: input.raffleId,
    captchaDigest: captchaDigest(input.captchaId, input.answer, input.expiresAt), deadline }) });
  return { ...input, authorization: { signature, deadline } };
}

async function request(overrides: Partial<AmoeInput> = {}, account = wallet): Promise<AmoeInput> {
  const challenge = issueChallenge("fixture-secret", overrides.now ?? now);
  return authorize({ address: account.address, pieceId: "junction-array", raffleId: "4", captchaId: challenge.id,
    answer: String(challenge.answer), expiresAt: challenge.expiresAt, captchaMac: challenge.mac,
    captchaSecret: "fixture-secret", points: 10, signerKey, context, now, ...overrides }, account);
}

describe("AMOE wallet ownership and request binding", () => {
  it("does not consume a victim's entry without their authorization", async () => {
    const store = new MemoryStore();
    const input = await request();
    await expect(issueAmoeClaim(store, { ...input, authorization: undefined })).rejects.toThrow(/authorization/i);
    await expect(issueAmoeClaim(store, await authorize(input, stranger))).rejects.toThrow(/authorization/i);
    expect((await issueAmoeClaim(store, input)).mode).toBe("signed");
  });

  it.each([
    { pieceId: "other-piece" }, { raffleId: "5" }, { address: stranger.address },
    { captchaId: "other-captcha" }, { answer: "999" }, { expiresAt: now + 120_000 },
    { context: { ...context, domain: "https://other.example" } },
    { context: { ...context, chainId: "31337" } },
    { context: { ...context, verifyingContract: "0x3333333333333333333333333333333333333333" as const } },
    { context: { ...context, termsHash: `0x${"b".repeat(64)}` as Hex } },
    { context: { ...context, mode: "bench" as const } }
  ])("rejects a tampered binding %#", async (mutation) => {
    const input = await request();
    await expect(issueAmoeClaim(new MemoryStore(), { ...input, ...mutation })).rejects.toThrow(/authorization/i);
  });

  it("requires a fresh authorization, authentic captcha and points", async () => {
    const input = await request();
    await expect(issueAmoeClaim(new MemoryStore(), { ...input, now: now + 601_000 })).rejects.toThrow(/authorization/i);
    await expect(issueAmoeClaim(new MemoryStore(), { ...input, captchaMac: "bad" })).rejects.toThrow(/Captcha/);
    await expect(issueAmoeClaim(new MemoryStore(), { ...input, points: 9 })).rejects.toThrow(/Check in/);
  });
});

describe("AMOE atomic issuance and recovery", () => {
  it("rejects zero terms before consuming issuance and rejects that server configuration", async () => {
    const store = new MemoryStore();
    const input = await request({ context: { ...context, termsHash: `0x${"0".repeat(64)}` } });
    await expect(issueAmoeClaim(store, input)).rejects.toThrow(/nonzero terms/);
    expect((await issueAmoeClaim(store, await authorize({ ...input, context }))).mode).toBe("signed");
    vi.stubEnv("AMOE_SIGNER_PRIVATE_KEY", signerKey);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", context.chainId);
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", context.verifyingContract);
    vi.stubEnv("TERMS_HASH", `0x${"0".repeat(64)}`);
    try { expect(() => configuredAmoeContext()).toThrow(/configuration/); }
    finally { vi.unstubAllEnvs(); }
  });

  it.each([
    null, {}, { mode: "bench" }, { entries: 99 }, { address: stranger.address },
    { pieceId: "another-piece" }, { raffleId: "5" }, { verifyingContract: stranger.address },
    { termsHash: `0x${"b".repeat(64)}` }, { captchaDigest: "malformed" },
    { captchaDigest: `0x${"b".repeat(64)}` }, { signature: `0x${"0".repeat(130)}` },
    { deadline: "not-an-integer" }, { deadline: "9".repeat(80) },
    { deadline: String(Math.trunc(now / 1000) + 3601) }
  ])("fails closed without replacing corrupted persisted results %#", async (mutation) => {
    class InspectableStore extends MemoryStore {
      claimKey = "";
      override async setIfAbsent(entries: Record<string, string>) {
        this.claimKey = Object.keys(entries).find((key) => key.startsWith("amoe:v2:"))!;
        return super.setIfAbsent(entries);
      }
    }
    const store = new InspectableStore();
    await issueAmoeClaim(store, await request());
    const record = JSON.parse((await store.get(store.claimKey))!);
    record.result = mutation === null ? null : Object.keys(mutation).length ? { ...record.result, ...mutation } : {};
    const corrupted = JSON.stringify(record);
    await store.set(store.claimKey, corrupted);
    await expect(issueAmoeClaim(store, await request())).rejects.toThrow(/reconciliation/);
    expect(await store.get(store.claimKey)).toBe(corrupted);
  });

  it("returns one stable signed result for concurrent requests and fresh-challenge retries", async () => {
    const store = new MemoryStore();
    const inputs = await Promise.all(Array.from({ length: 12 }, () => request()));
    const results = await Promise.all(inputs.map((input) => issueAmoeClaim(store, input)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await issueAmoeClaim(store, await request({ now: now + 700_000 }))).toEqual(results[0]);
    const issued = results[0];
    if (issued.mode !== "signed") throw new Error("Expected signed result");
    const recovered = await recoverTypedDataAddress({
      domain: { name: "LABx", version: "1", chainId: 11155111n, verifyingContract: context.verifyingContract },
      types: { AmoeClaim: [{ name: "raffleId", type: "uint256" }, { name: "account", type: "address" },
        { name: "captchaDigest", type: "bytes32" }, { name: "deadline", type: "uint256" }, { name: "termsHash", type: "bytes32" }] },
      primaryType: "AmoeClaim", message: { raffleId: 4n, account: wallet.address, captchaDigest: issued.captchaDigest,
        deadline: BigInt(issued.deadline), termsHash: context.termsHash }, signature: issued.signature
    });
    expect(recovered.toLowerCase()).toBe(privateKeyToAccount(signerKey).address.toLowerCase());
  });

  it("lets only one wallet consume a shared captcha without consuming the losing claim", async () => {
    const store = new MemoryStore();
    const a = await request();
    const b = await authorize({ ...a, address: stranger.address }, stranger);
    const outcomes = await Promise.allSettled([issueAmoeClaim(store, a), issueAmoeClaim(store, b)]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
    const loser = outcomes[0].status === "rejected" ? wallet : stranger;
    expect((await issueAmoeClaim(store, await request({}, loser))).address).toBe(loser.address.toLowerCase());
  });

  it("does not consume anything when signing configuration fails", async () => {
    const store = new MemoryStore();
    const input = await request();
    await expect(issueAmoeClaim(store, { ...input, signerKey: "0xinvalid" })).rejects.toThrow();
    expect((await issueAmoeClaim(store, input)).mode).toBe("signed");
  });

  it("does not consume the captcha if typed-data signing rejects the raffle id", async () => {
    const store = new MemoryStore();
    const oversized = await request({ raffleId: "9".repeat(78) });
    await expect(issueAmoeClaim(store, oversized)).rejects.toThrow();
    const corrected = await authorize({ ...oversized, raffleId: "4" });
    expect((await issueAmoeClaim(store, corrected)).mode).toBe("signed");
  });

  it("recovers the persisted result after the write response is lost", async () => {
    class LostResponseStore extends MemoryStore {
      lose = true;
      override async setIfAbsent(entries: Record<string, string>) {
        const saved = await super.setIfAbsent(entries);
        if (this.lose) { this.lose = false; throw new Error("connection lost after commit"); }
        return saved;
      }
    }
    const store = new LostResponseStore();
    const input = await request();
    await expect(issueAmoeClaim(store, input)).rejects.toThrow(/connection lost/);
    const recovered = await issueAmoeClaim(store, input);
    expect(recovered.mode).toBe("signed");
    expect(await issueAmoeClaim(store, await request())).toEqual(recovered);
  });

  it("does not burn the challenge on a failed write", async () => {
    class FailedWriteStore extends MemoryStore {
      fail = true;
      override async setIfAbsent(entries: Record<string, string>) {
        if (this.fail) { this.fail = false; throw new Error("store unavailable"); }
        return super.setIfAbsent(entries);
      }
    }
    const store = new FailedWriteStore();
    const input = await request();
    await expect(issueAmoeClaim(store, input)).rejects.toThrow(/unavailable/);
    expect((await issueAmoeClaim(store, input)).mode).toBe("signed");
  });

  it("fails closed for expiry, changed signer/terms and aliases of the same raffle", async () => {
    const store = new MemoryStore();
    await issueAmoeClaim(store, await request());
    for (const input of [await request({ now: now + 3_601_000 }), await request({ signerKey: generatePrivateKey() }),
      await request({ context: { ...context, termsHash: `0x${"b".repeat(64)}` } }), await request({ pieceId: "alias" })]) {
      await expect(issueAmoeClaim(store, input)).rejects.toThrow(/reconciliation/i);
    }
  });

  it("does not bypass a legacy consumed claim", async () => {
    const store = new MemoryStore();
    await store.set(`amoe:junction-array:${wallet.address.toLowerCase()}`, '{"at":"old"}');
    await expect(issueAmoeClaim(store, await request())).rejects.toThrow(/legacy/i);
  });
});
