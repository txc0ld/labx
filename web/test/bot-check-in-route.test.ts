import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/bot/check-in/route";
import { MemoryStore } from "../lib/store";

const address = "0x1111111111111111111111111111111111111111";

function request(body: BodyInit, token = "bot-secret") {
  return new Request("http://localhost/api/bot/check-in", {
    method: "POST",
    headers: { "x-labx-bot-token": token },
    body
  });
}

describe("bounded legacy bot check-in requests", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("LABX_STORE", "memory");
    vi.stubEnv("BOT_CHECKIN_TOKEN", "bot-secret");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects a 65,537-byte stream before any store write", async () => {
    const set = vi.spyOn(MemoryStore.prototype, "set");
    const oversized = new Uint8Array(65_537).fill("x".charCodeAt(0));
    const incoming = request(oversized);
    expect(incoming.headers.get("content-length")).toBeNull();

    const response = await POST(incoming);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/too large/i) });
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    { address: [address], signature: "0x12" },
    { address, signature: ["0x12"] },
    { address: { value: address }, signature: "0x12" }
  ])("rejects malformed wallet field types before persistence", async body => {
    const set = vi.spyOn(MemoryStore.prototype, "set");
    const response = await POST(request(JSON.stringify(body)));
    expect(response.status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    "{",
    "[]",
    new Uint8Array([0xc3, 0x28])
  ])("rejects malformed JSON, non-object JSON and invalid UTF-8 before persistence", async body => {
    const set = vi.spyOn(MemoryStore.prototype, "set");
    const response = await POST(request(body));
    expect(response.status).toBe(401);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong-token", "0x12"],
    ["bot-secret", "0x12"]
  ])("preserves token and signature authorization before persistence", async (token, signature) => {
    const set = vi.spyOn(MemoryStore.prototype, "set");
    const response = await POST(request(JSON.stringify({ address, signature }), token));
    expect(response.status).toBe(401);
    expect(set).not.toHaveBeenCalled();
  });
});
