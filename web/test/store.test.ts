import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReserve } from "../lib/reserve";
import { activeStore, fileStore, MemoryStore, upstashStore } from "../lib/store";
import type { Store } from "../lib/points";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("atomic multi-key persistence", () => {
  it.each(["memory", "file", "redis"])("commits all keys or none under contention with %s", async (adapter) => {
    let directory: string | undefined;
    let cwd: ReturnType<typeof vi.spyOn> | undefined;
    let store: Store;
    if (adapter === "file") {
      directory = await mkdtemp(path.join(tmpdir(), "labx-store-test-"));
      cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
      vi.stubEnv("VERCEL", "");
      store = fileStore();
    } else if (adapter === "redis") {
      const records = new Map<string, string>();
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const command = JSON.parse(String(init.body)) as string[];
          expect(command[0]).toBe("MSETNX");
          expect(command).toHaveLength(5);
          if (records.has(command[1]) || records.has(command[3])) return Response.json({ result: 0 });
          records.set(command[1], command[2]);
          records.set(command[3], command[4]);
          return Response.json({ result: 1 });
        }
        return Response.json({ result: records.get(decodeURIComponent(url.split("/get/")[1])) ?? null });
      });
      store = upstashStore("https://redis.example", "fixture-token");
    } else store = new MemoryStore();
    try {
      const outcomes = await Promise.all([
        store.setIfAbsent({ "claim:a": "result-a", "captcha:shared": "owner-a" }),
        store.setIfAbsent({ "claim:b": "result-b", "captcha:shared": "owner-b" })
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const winner = outcomes[0] ? "a" : "b";
      const loser = outcomes[0] ? "b" : "a";
      expect(await store.get(`claim:${winner}`)).toBe(`result-${winner}`);
      expect(await store.get("captcha:shared")).toBe(`owner-${winner}`);
      expect(await store.get(`claim:${loser}`)).toBeNull();
      expect(await store.setIfAbsent({ [`claim:${loser}`]: `result-${loser}`, "captcha:fresh": "fresh" })).toBe(true);
      expect(await store.get(`claim:${loser}`)).toBe(`result-${loser}`);
    } finally {
      cwd?.mockRestore();
      if (directory) {
        await unlink(path.join(directory, "data", "store.json"));
        await rmdir(path.join(directory, "data"));
        await rmdir(directory);
      }
    }
  });

  it.each([null, "OK", {}, 2])("refuses malformed atomic write acknowledgement %s", async (result) => {
    vi.stubGlobal("fetch", async () => Response.json({ result }));
    await expect(upstashStore("https://redis.example", "fixture-token").setIfAbsent({ claim: "result" })).rejects.toThrow(/atomic/i);
  });
});

describe("hosted persistence configuration", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", undefined);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", undefined);
    vi.stubEnv("LABX_STORE", undefined);
  });

  it.each([
    [undefined, undefined, undefined],
    ["https://redis.example", undefined, undefined],
    [undefined, "test-token", undefined],
    [undefined, undefined, "memory"],
    ["https://redis.example", undefined, "memory"],
    [undefined, "test-token", "memory"]
  ])("refuses ephemeral hosted storage (%s, %s, %s)", (url, token, mode) => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", url);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", token);
    vi.stubEnv("LABX_STORE", mode);
    expect(() => activeStore()).toThrow(/persistent.*Redis/i);
  });

  it("uses configured Redis even when hosted memory mode is requested", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubEnv("LABX_STORE", "memory");
    vi.stubGlobal("fetch", async () => Response.json({ result: "persisted commitment" }));
    expect(await activeStore().get("reserve:hosted-fixture")).toBe("persisted commitment");
  });

  it("keeps explicitly selected memory storage available locally", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("LABX_STORE", "memory");
    await activeStore().set("reserve:local-demo-fixture", "local demo commitment");
    expect(await activeStore().get("reserve:local-demo-fixture")).toBe("local demo commitment");
  });
});

describe("Redis persistence", () => {
  it("distinguishes a missing record from a failed read", async () => {
    const store = upstashStore("https://redis.example", "test-token");
    vi.stubGlobal("fetch", async () => Response.json({ result: "saved commitment" }));
    expect(await store.get("reserve:existing")).toBe("saved commitment");
    vi.stubGlobal("fetch", async () => Response.json({ result: null }));
    expect(await store.get("reserve:missing")).toBeNull();
    vi.stubGlobal("fetch", async () => Response.json({ error: "Unauthorized" }, { status: 401 }));
    await expect(store.get("reserve:existing")).rejects.toThrow(/store/i);
    vi.stubGlobal("fetch", async () => Response.json({ result: "OK" }));
    await expect(store.set("reserve:new", "saved commitment")).resolves.toBeUndefined();
  });
  it.each([
    [503, { error: "unavailable" }],
    [200, { error: "ERR write refused" }],
    [200, {}]
  ])("does not publish a commitment when Redis refuses its write (%s)", async (status, body) => {
    vi.stubGlobal("fetch", async () => Response.json(body, { status }));
    await expect(createReserve(upstashStore("https://redis.example", "test-token"), {
      seller: "0x2222222222222222222222222222222222222222",
      nft: "0x3333333333333333333333333333333333333333",
      tokenId: "1",
      publicSummary: "An escrowed piece",
      privateCommitment: "Private reveal data",
      chainId: 11155111n,
      labx: "0x1111111111111111111111111111111111111111"
    })).rejects.toThrow(/store/i);
  });

  it("bounds delayed headers and delayed bodies without aborting a later operation", async () => {
    vi.useFakeTimers();
    try {
      let headerSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        headerSignal = init?.signal ?? undefined;
        headerSignal?.addEventListener("abort", () => reject(headerSignal?.reason));
        setTimeout(() => resolve(Response.json({ result: "late" })), 6_000);
      }));
      const delayedHeaders = upstashStore("https://redis.example", "test-token").get("reserve:slow-headers")
        .then(() => "resolved", () => "failed");
      const headerDeadline = new Promise<string>(resolve => setTimeout(() => resolve("missed deadline"), 5_001));
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await Promise.race([delayedHeaders, headerDeadline])).toBe("failed");
      expect(headerSignal?.aborted).toBe(true);

      let bodySignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
        bodySignal = init?.signal ?? undefined;
        const body = new ReadableStream({
          start(controller) {
            const completion = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('{"result":"late"}'));
              controller.close();
            }, 6_000);
            bodySignal?.addEventListener("abort", () => {
              clearTimeout(completion);
              controller.error(bodySignal?.reason);
            });
          }
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      });
      const delayedBody = upstashStore("https://redis.example", "test-token").get("reserve:slow-body")
        .then(() => "resolved", () => "failed");
      const bodyDeadline = new Promise<string>(resolve => setTimeout(() => resolve("missed deadline"), 5_001));
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await Promise.race([delayedBody, bodyDeadline])).toBe("failed");
      expect(bodySignal?.aborted).toBe(true);

      let laterSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
        laterSignal = init?.signal ?? undefined;
        return Response.json({ result: "OK" });
      });
      await expect(upstashStore("https://redis.example", "test-token").set("reserve:later", "saved")).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(laterSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers the original immutable commitment after an ambiguous atomic-write timeout", async () => {
    vi.useFakeTimers();
    try {
      const records = new Map<string, string>();
      let firstAtomicWrite = true;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (init?.method !== "POST") {
          return Response.json({ result: records.get(decodeURIComponent(url.split("/get/")[1])) ?? null });
        }
        const command = JSON.parse(String(init.body)) as string[];
        if (command[0] !== "MSETNX") throw new Error("Unexpected Redis command");
        const exists = records.has(command[1]) || records.has(command[3]);
        if (!exists) {
          records.set(command[1], command[2]);
          records.set(command[3], command[4]);
        }
        if (!firstAtomicWrite) return Response.json({ result: exists ? 0 : 1 });
        firstAtomicWrite = false;
        const signal = init.signal;
        const body = new ReadableStream({
          start(controller) {
            const completion = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('{"result":1}'));
              controller.close();
            }, 6_000);
            signal?.addEventListener("abort", () => {
              clearTimeout(completion);
              controller.error(signal.reason);
            });
          }
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      });
      const store = upstashStore("https://redis.example", "test-token");
      const input = {
        seller: "0x2222222222222222222222222222222222222222" as const,
        nft: "0x3333333333333333333333333333333333333333" as const,
        tokenId: "1",
        publicSummary: "An escrowed piece",
        privateCommitment: "Private reveal data",
        chainId: 11155111n,
        labx: "0x1111111111111111111111111111111111111111" as const,
        requestIdentity: `0x${"ab".repeat(32)}` as const
      };
      const first = createReserve(store, input).then(() => "resolved", () => "failed");
      const deadline = new Promise<string>(resolve => setTimeout(() => resolve("missed deadline"), 5_001));
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await Promise.race([first, deadline])).toBe("failed");

      const recovered = await createReserve(store, input);
      expect(recovered.commit).toBe(records.get(`reserve-request:v3:${input.requestIdentity}`));
      expect(records.get(`reserve:${recovered.commit}`)).toContain('"privateHash"');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("local file persistence", () => {
  it.each(['{"reserve:old":', "null", "[]", '{"reserve:old":42}'])("refuses to overwrite a damaged store: %s", async (damaged) => {
    const directory = await mkdtemp(path.join(tmpdir(), "labx-store-test-"));
    const file = path.join(directory, "data", "store.json");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    vi.stubEnv("VERCEL", "");
    try {
      await mkdir(path.dirname(file));
      await writeFile(file, damaged);
      await expect(fileStore().set("reserve:new", "new commitment")).rejects.toThrow(/store/i);
      expect(await readFile(file, "utf8")).toBe(damaged);
      await writeFile(file, '{"reserve:old":"restored commitment"}');
      await fileStore().set("reserve:new", "new commitment");
      expect(await fileStore().get("reserve:old")).toBe("restored commitment");
      expect(await fileStore().get("reserve:new")).toBe("new commitment");
    } finally {
      cwd.mockRestore();
      vi.unstubAllEnvs();
      await unlink(file);
      await rmdir(path.dirname(file));
      await rmdir(directory);
    }
  });

  it("retains concurrent writes from separate store instances", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "labx-store-test-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    vi.stubEnv("VERCEL", "");
    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => fileStore().set(`reserve:${index}`, `commitment-${index}`)));
      const values = await Promise.all(Array.from({ length: 20 }, (_, index) => fileStore().get(`reserve:${index}`)));
      expect(values).toEqual(Array.from({ length: 20 }, (_, index) => `commitment-${index}`));
      expect(JSON.parse(await readFile(path.join(directory, "data", "store.json"), "utf8"))["reserve:0"]).toBe("commitment-0");
    } finally {
      cwd.mockRestore();
      vi.unstubAllEnvs();
      await unlink(path.join(directory, "data", "store.json"));
      await rmdir(path.join(directory, "data"));
      await rmdir(directory);
    }
  });
});
