import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReserve } from "../lib/reserve";
import { fileStore, upstashStore } from "../lib/store";

afterEach(() => vi.unstubAllGlobals());

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
