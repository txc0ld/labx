import { afterEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { createReserve } from "../lib/reserve";
import { neonStore } from "../lib/store";

vi.mock("@neondatabase/serverless", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@neondatabase/serverless")>();
  return { ...actual, neon: vi.fn(actual.neon) };
});

const databaseUrl = "postgresql://fixture:private@db.example/labx?sslmode=require";
const invalidAtomicEntries: Record<string, string>[] = [
  {},
  Object.defineProperty({}, "key", { enumerable: true, value: 42 }),
  { "": "value" }
];

function result(names: string[], rows: (string | null)[][]): Response {
  return Response.json({
    fields: names.map((name) => ({ name, dataTypeID: 25 })),
    rows,
    command: "SELECT",
    rowCount: rows.length
  });
}

function requestData(init?: RequestInit): { query: string; params: unknown[] } {
  const body: unknown = JSON.parse(String(init?.body));
  if (!body || typeof body !== "object") throw new Error("Invalid fixture request body.");
  const query: unknown = Reflect.get(body, "query");
  const params: unknown = Reflect.get(body, "params");
  if (typeof query !== "string" || !Array.isArray(params)) throw new Error("Invalid fixture query.");
  return { query, params };
}

function databaseError(fields: Record<string, string>, message = "fixture-private-value"): Response {
  return Response.json({ message, ...fields }, { status: 400 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Neon HTTP storage", () => {
  it("sanitizes driver constructor failures", () => {
    vi.mocked(neon).mockImplementationOnce(() => {
      throw new Error(`Driver rejected ${databaseUrl}`);
    });
    let message = "constructor did not throw";
    try {
      neonStore(databaseUrl);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Neon storage is not configured.");
    expect(message).not.toContain("private");
  });

  it("round-trips exact text through bound get, set and atomic batch queries", async () => {
    const records = new Map<string, string>();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const { query, params } = requestData(init);
      if (query.startsWith("SELECT value")) {
        const value = records.get(String(params[0]));
        return result(["value"], value === undefined ? [] : [[value]]);
      }
      if (query.startsWith("INSERT INTO public.labx_store (key, value)\nVALUES")) {
        records.set(String(params[0]), String(params[1]));
        return result(["key"], [[String(params[0])]]);
      }
      const entries: unknown = JSON.parse(String(params[0]));
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Invalid entries fixture.");
      const pairs = Object.entries(entries);
      if (pairs.some(([key]) => records.has(key))) {
        return databaseError({ code: "23505", schema: "public", table: "labx_store", constraint: "labx_store_pkey" });
      }
      for (const [key, value] of pairs) records.set(key, String(value));
      return result(["key"], pairs.map(([key]) => [key]));
    });
    vi.stubGlobal("fetch", fetcher);
    const store = neonStore(databaseUrl);
    const key = "quote:'; select * from secrets; -- \u{1f680}";
    const value = "JSON-looking: {\"ok\":true}\nUnicode: caf\u00e9 \u96ea";

    expect(await store.get(key)).toBeNull();
    await store.set(key, value);
    expect(await store.get(key)).toBe(value);
    expect(await store.setIfAbsent({ "record:b": "'quoted'", "record:a": "{json}" })).toBe(true);
    expect(await store.get("record:a")).toBe("{json}");
    const submitted = fetcher.mock.calls.map(([, init]) => requestData(init));
    expect(submitted.every(({ query }) => !query.includes(key) && !query.includes(value))).toBe(true);
    expect(submitted.some(({ query }) => query.includes("jsonb_each_text($1::jsonb)") && !query.includes("ON CONFLICT"))).toBe(true);
  });

  it.each(invalidAtomicEntries)("rejects invalid atomic entries before issuing a request: %j", async (entries) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(neonStore(databaseUrl).setIfAbsent(entries)).rejects.toThrow(/nonempty string entries/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns false only for the expected primary-key violation", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const store = neonStore(databaseUrl);
    fetcher.mockResolvedValueOnce(databaseError({ code: "23505", schema: "public", table: "labx_store", constraint: "labx_store_pkey" }));
    await expect(store.setIfAbsent({ claim: "winner" })).resolves.toBe(false);

    for (const fields of [
      { code: "23505", schema: "public", table: "other_table", constraint: "labx_store_pkey" },
      { code: "23505", schema: "public", table: "labx_store", constraint: "other_constraint" },
      { code: "23514", schema: "public", table: "labx_store", constraint: "labx_store_value_check" }
    ]) {
      fetcher.mockResolvedValueOnce(databaseError(fields));
      const failure = store.setIfAbsent({ claim: "private-record-value" });
      await expect(failure).rejects.toThrow(/^Store request failed\.$/);
      await expect(failure).rejects.not.toThrow(/fixture-private-value|private-record-value|postgresql:/i);
    }
  });

  it("rejects malformed reads and write acknowledgements", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const store = neonStore(databaseUrl);
    for (const response of [
      result(["value"], [["one"], ["two"]]),
      result(["other"], [["value"]])
    ]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(store.get("key")).rejects.toThrow(/Store/);
    }
    for (const response of [
      result(["key"], []),
      result(["key"], [["different"]]),
      result(["key"], [["key"], ["key"]])
    ]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(store.set("key", "private value")).rejects.toThrow(/Store/);
    }
    fetcher.mockResolvedValueOnce(result(["key"], [["a"]]));
    await expect(store.setIfAbsent({ a: "1", b: "2" })).rejects.toThrow(/Store/);
  });

  it.each([
    ["authentication", () => Promise.resolve(databaseError({ code: "28P01" }))],
    ["missing relation", () => Promise.resolve(databaseError({ code: "42P01" }))],
    ["network", () => Promise.reject(new Error("fixture-private-network-detail"))]
  ])("sanitizes %s failures", async (_name, response) => {
    vi.stubGlobal("fetch", response);
    const failure = neonStore(databaseUrl).get("private-record-key");
    await expect(failure).rejects.toThrow(/^Store request failed\.$/);
    await expect(failure).rejects.not.toThrow(/fixture|private-record|postgresql:/i);
  });

  it("bounds delayed headers and delayed bodies, then succeeds with a fresh signal", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const store = neonStore(databaseUrl);
    let firstSignal: AbortSignal | undefined;
    fetcher.mockImplementationOnce(async (_input, init) => new Promise<Response>((resolve, reject) => {
      firstSignal = init?.signal ?? undefined;
      firstSignal?.addEventListener("abort", () => reject(firstSignal?.reason));
      setTimeout(() => resolve(result(["value"], [["late"]])), 6_000);
    }));
    const lateHeaders = store.get("slow-headers").then(() => "resolved", () => "failed");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await lateHeaders).toBe("failed");
    expect(firstSignal?.aborted).toBe(true);

    let secondSignal: AbortSignal | undefined;
    fetcher.mockImplementationOnce(async (_input, init) => {
      secondSignal = init?.signal ?? undefined;
      const body = new ReadableStream({
        start(controller) {
          const completion = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({
              fields: [{ name: "value", dataTypeID: 25 }], rows: [["late"]], command: "SELECT", rowCount: 1
            })));
            controller.close();
          }, 6_000);
          secondSignal?.addEventListener("abort", () => {
            clearTimeout(completion);
            controller.error(secondSignal?.reason);
          });
        }
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    });
    const lateBody = store.get("slow-body").then(() => "resolved", () => "failed");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await lateBody).toBe("failed");
    expect(secondSignal?.aborted).toBe(true);

    let healthySignal: AbortSignal | undefined;
    fetcher.mockImplementationOnce(async (_input, init) => {
      healthySignal = init?.signal ?? undefined;
      return result(["value"], [["healthy"]]);
    });
    await expect(store.get("healthy")).resolves.toBe("healthy");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(healthySignal?.aborted).toBe(false);
  });

  it("recovers the authoritative commitment after a committed batch loses its response", async () => {
    vi.useFakeTimers();
    const records = new Map<string, string>();
    let loseFirstBatchResponse = true;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { query, params } = requestData(init);
      if (query.startsWith("SELECT value")) {
        const value = records.get(String(params[0]));
        return result(["value"], value === undefined ? [] : [[value]]);
      }
      const entries: unknown = JSON.parse(String(params[0]));
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Invalid fixture entries.");
      const pairs = Object.entries(entries);
      if (pairs.some(([key]) => records.has(key))) {
        return databaseError({ code: "23505", schema: "public", table: "labx_store", constraint: "labx_store_pkey" });
      }
      for (const [key, value] of pairs) records.set(key, String(value));
      if (!loseFirstBatchResponse) return result(["key"], pairs.map(([key]) => [key]));
      loseFirstBatchResponse = false;
      const signal = init?.signal;
      const body = new ReadableStream({
        start(controller) {
          const completion = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ fields: [{ name: "key", dataTypeID: 25 }], rows: pairs.map(([key]) => [key]), command: "INSERT", rowCount: pairs.length })));
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
    const first = createReserve(neonStore(databaseUrl), input).then(() => "resolved", () => "failed");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await first).toBe("failed");
    const recovered = await createReserve(neonStore(databaseUrl), input);
    expect(recovered.commit).toBe(records.get(`reserve-request:v3:${input.requestIdentity}`));
    expect(records.get(`reserve:${recovered.commit}`)).toContain('"privateHash"');
    expect([...records.keys()].filter((key) => key.startsWith("reserve:0x"))).toHaveLength(1);
    expect(records.size).toBe(2);
  });
});
