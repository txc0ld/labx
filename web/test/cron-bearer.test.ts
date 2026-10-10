import { describe, expect, it, vi } from "vitest";

const compared = vi.hoisted(() => [] as [number, number][]);
vi.mock("node:crypto", async original => {
  const crypto = await original<typeof import("node:crypto")>();
  return {
    ...crypto,
    timingSafeEqual: (left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
      compared.push([left.byteLength, right.byteLength]);
      return crypto.timingSafeEqual(left, right);
    }
  };
});
const { validBearer, MIN_CRON_SECRET_LENGTH } = await import("../lib/notifications/http");

describe("cron bearer check", () => {
  const secret = "draw-cron-secret-0123456789";

  it("accepts only the exact secret", () => {
    expect(validBearer(`Bearer ${secret}`, secret)).toBe(true);
    for (const header of [null, "", secret, `Basic ${secret}`, `bearer ${secret}`, `Bearer ${secret} `, `Bearer ${secret.slice(0, -1)}`, `Bearer ${secret}x`, `Bearer ${secret.slice(0, -1)}X`, "Bearer "]) {
      expect(validBearer(header, secret)).toBe(false);
    }
  });

  it("compares fixed-length digests for every supplied length, so the secret length does not leak", () => {
    compared.length = 0;
    const supplied = ["", "a", secret.slice(0, 10), secret.slice(0, -1), secret, `${secret}x`, "z".repeat(4096)];
    for (const value of supplied) validBearer(`Bearer ${value}`, secret);
    expect(compared).toEqual(supplied.map(() => [32, 32]));
  });

  it(`refuses every bearer when the configured secret is shorter than ${MIN_CRON_SECRET_LENGTH} characters`, () => {
    expect(MIN_CRON_SECRET_LENGTH).toBe(16);
    const short = "0123456789abcde";
    expect(validBearer(`Bearer ${short}`, short)).toBe(false);
    expect(validBearer(`Bearer ${short}f`, `${short}f`)).toBe(true);
  });
});
