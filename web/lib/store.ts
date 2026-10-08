import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { neon, NeonDbError, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Store } from "./points";

const STORE_TIMEOUT_MS = 5_000;
const NEON_TABLE = "labx_store";
const NEON_PRIMARY_KEY = "labx_store_pkey";

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
  const provider = process.env.LABX_STORE;
  if (!provider) {
    if (process.env.VERCEL) throw new Error("Persistent storage provider must be configured on Vercel.");
    return fileStore();
  }
  if (provider === "neon") {
    return neonStore(configuredNeonDatabaseUrl());
  }
  if (provider === "upstash") {
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("Upstash storage is not configured.");
    }
    return upstashStore(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN);
  }
  if (provider === "memory" || provider === "file") {
    if (process.env.VERCEL) throw new Error("Persistent storage provider must be configured on Vercel.");
    return provider === "memory" ? memoryStore() : fileStore();
  }
  if (process.env.VERCEL) throw new Error("Persistent storage provider must be configured on Vercel.");
  throw new Error("Storage provider selection is invalid.");
}

function configuredNeonDatabaseUrl(): string {
  const standard = process.env.DATABASE_URL;
  const alias = process.env.NEON_DATABASE;
  if (standard && alias && standard !== alias) throw new Error("Neon storage configuration is ambiguous.");
  const selected = standard || alias;
  if (!selected) throw new Error("Neon storage is not configured.");
  return selected;
}

export function neonStore(databaseUrl: string): Store {
  const sql = neonClient(databaseUrl);
  return {
    async get(key) {
      try {
        const rows: unknown = await neonRequest(
          sql,
          "SELECT value FROM public.labx_store WHERE key = $1",
          [key]
        );
        if (!Array.isArray(rows) || rows.length > 1) throw new Error("Invalid storage result.");
        if (rows.length === 0) return null;
        const row = rows[0];
        if (!isSingleTextField(row, "value")) throw new Error("Invalid storage result.");
        return row.value;
      } catch {
        throw new Error("Store request failed.");
      }
    },
    async set(key, value) {
      try {
        const rows: unknown = await neonRequest(
          sql,
          `INSERT INTO public.labx_store (key, value)
VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
RETURNING key`,
          [key, value]
        );
        requireExactAcknowledgement(rows, [key]);
      } catch {
        throw new Error("Store request failed.");
      }
    },
    async setIfAbsent(entries) {
      const pairs = checkedEntries(entries);
      const values = Object.fromEntries(pairs);
      try {
        const rows: unknown = await neonRequest(
          sql,
          `INSERT INTO public.labx_store (key, value)
SELECT entry.key, entry.value
FROM jsonb_each_text($1::jsonb) AS entry(key, value)
ORDER BY entry.key
RETURNING key`,
          [JSON.stringify(values)]
        );
        requireExactAcknowledgement(rows, pairs.map(([key]) => key));
        return true;
      } catch (error) {
        if (isExpectedPrimaryKeyConflict(error)) return false;
        throw new Error("Store request failed.");
      }
    }
  };
}

function neonClient(databaseUrl: string): NeonQueryFunction<false, false> {
  try {
    return neon(checkedDatabaseUrl(databaseUrl));
  } catch {
    throw new Error("Neon storage is not configured.");
  }
}

function checkedDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      || !parsed.username
      || !parsed.hostname
      || parsed.pathname.length < 2
      || parsed.searchParams.get("sslmode") === "disable"
    ) throw new Error("Invalid database configuration.");
    return databaseUrl;
  } catch {
    throw new Error("Neon storage is not configured.");
  }
}

async function neonRequest(
  sql: NeonQueryFunction<false, false>,
  statement: string,
  params: unknown[]
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STORE_TIMEOUT_MS);
  try {
    return await sql.query(statement, params, { fetchOptions: { signal: controller.signal } });
  } finally {
    clearTimeout(timeout);
  }
}

function isSingleTextField(row: unknown, field: string): row is Record<string, string> {
  return Boolean(
    row
    && typeof row === "object"
    && !Array.isArray(row)
    && Object.keys(row).length === 1
    && Object.hasOwn(row, field)
    && typeof Reflect.get(row, field) === "string"
  );
}

function requireExactAcknowledgement(rows: unknown, expectedKeys: string[]): void {
  if (!Array.isArray(rows) || rows.length !== expectedKeys.length) throw new Error("Invalid storage acknowledgement.");
  const returnedKeys: string[] = [];
  for (const row of rows) {
    if (!isSingleTextField(row, "key")) throw new Error("Invalid storage acknowledgement.");
    returnedKeys.push(row.key);
  }
  const returned = new Set(returnedKeys);
  if (returned.size !== expectedKeys.length || expectedKeys.some((key) => !returned.has(key))) {
    throw new Error("Invalid storage acknowledgement.");
  }
}

function isExpectedPrimaryKeyConflict(error: unknown): boolean {
  return error instanceof NeonDbError
    && error.code === "23505"
    && error.schema === "public"
    && error.table === NEON_TABLE
    && error.constraint === NEON_PRIMARY_KEY;
}

export function upstashStore(url: string, token: string): Store {
  return {
    async get(key) {
      const result = await redisRequest(`${url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      if (result !== null && typeof result !== "string") throw new Error("Store returned an invalid read result.");
      return result;
    },
    async set(key, value) {
      const result = await redisRequest(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["SET", key, value])
      });
      if (result !== "OK") throw new Error("Store did not acknowledge the write.");
    },
    async setIfAbsent(entries) {
      // Redis MSETNX commits all keys or none; a pipeline of SET NX cannot do this.
      const result = await redisRequest(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["MSETNX", ...checkedEntries(entries).flat()])
      });
      if (result !== 0 && result !== 1) throw new Error("Store returned an invalid atomic write result.");
      return result === 1;
    }
  };
}

async function redisRequest(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STORE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await redisResult(response);
  } finally {
    clearTimeout(timeout);
  }
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
