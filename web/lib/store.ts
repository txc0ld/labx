import { mkdir, readFile, writeFile } from "node:fs/promises";
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
}

const globalStore = globalThis as unknown as { __labx?: MemoryStore };

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
      const all = await readAll(file);
      all[key] = value;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(all));
    }
  };
}

async function readAll(file: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function activeStore(): Store {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return upstashStore(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN);
  }
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
      const body = (await response.json()) as { result?: string | null };
      return body.result ?? null;
    },
    async set(key, value) {
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["SET", key, value])
      });
    }
  };
}
