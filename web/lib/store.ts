import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Store } from "./points";

export class MemoryStore implements Store {
  private map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async setIfAbsent(entries: Record<string, string>) {
    const pairs = checkedEntries(entries);
    if (pairs.some(([key]) => this.map.has(key))) return false;
    for (const [key, value] of pairs) this.map.set(key, value);
    return true;
  }
}

const globalStore = globalThis as unknown as {
  __labx?: MemoryStore;
  __labxFileWrites?: Map<string, Promise<unknown>>;
};

function serializeFileWrite<T>(file: string, write: () => Promise<T>): Promise<T> {
  const writes = globalStore.__labxFileWrites ??= new Map();
  const pending = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(write);
  writes.set(file, pending);
  return pending.finally(() => {
    if (writes.get(file) === pending) writes.delete(file);
  });
}

export function memoryStore(): MemoryStore {
  if (!globalStore.__labx) globalStore.__labx = new MemoryStore();
  return globalStore.__labx;
}

export function fileStore(): Store {
  const file = process.env.VERCEL ? "/tmp/labx-store.json" : path.join(process.cwd(), "data", "store.json");
  return {
    async get(key) {
      const all = await readAll(file);
      return all[key] ?? null;
    },
    async set(key, value) {
      await serializeFileWrite(file, async () => {
        const all = await readAll(file);
        all[key] = value;
        await writeAll(file, all);
      });
    },
    async setIfAbsent(entries) {
      const pairs = checkedEntries(entries);
      return serializeFileWrite(file, async () => {
        const all = await readAll(file);
        if (pairs.some(([key]) => Object.hasOwn(all, key))) return false;
        await writeAll(file, { ...all, ...entries });
        return true;
      });
    }
  };
}

function checkedEntries(entries: Record<string, string>): [string, string][] {
  const pairs = Object.entries(entries);
  if (!pairs.length || pairs.some(([key, value]) => !key || typeof value !== "string")) {
    throw new Error("Store requires nonempty string entries.");
  }
  return pairs;
}

async function writeAll(file: string, all: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(all));
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function readAll(file: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Store could not be read.");
  }
  let all: unknown;
  try {
    all = JSON.parse(raw);
  } catch {
    throw new Error("Store contains invalid data.");
  }
  if (!all || typeof all !== "object" || Array.isArray(all) || Object.values(all).some((value) => typeof value !== "string")) {
    throw new Error("Store contains invalid data.");
  }
  return all as Record<string, string>;
}

export function activeStore(): Store {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return upstashStore(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN);
  }
  // Hosted requests must never acknowledge data kept only in one ephemeral instance.
  if (process.env.VERCEL) throw new Error("Persistent Redis storage must be configured on Vercel.");
  if (process.env.LABX_STORE === "memory") return memoryStore();
  return fileStore();
}

export function upstashStore(url: string, token: string): Store {
  return {
    async get(key) {
      const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      const result = await redisResult(response);
      if (result !== null && typeof result !== "string") throw new Error("Store returned an invalid read result.");
      return result;
    },
    async set(key, value) {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["SET", key, value])
      });
      if (await redisResult(response) !== "OK") throw new Error("Store did not acknowledge the write.");
    },
    async setIfAbsent(entries) {
      // Redis MSETNX commits all keys or none; a pipeline of SET NX cannot do this.
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["MSETNX", ...checkedEntries(entries).flat()])
      });
      const result = await redisResult(response);
      if (result !== 0 && result !== 1) throw new Error("Store returned an invalid atomic write result.");
      return result === 1;
    }
  };
}

async function redisResult(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("Store request failed.");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Store returned an invalid response.");
  }
  if (!body || typeof body !== "object" || "error" in body || !("result" in body)) {
    throw new Error("Store returned an invalid response.");
  }
  return body.result;
}
