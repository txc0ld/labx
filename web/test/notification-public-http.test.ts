import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeEventTopics, type Hex } from "viem";
import { raffleAbi } from "@/lib/chain/abi";
import { APPROVED_DEPLOYMENTS } from "@/lib/chain/deployment";
import { createNotificationConnectionTestHandler, createNotificationCronHandler, createNotificationsHandler } from "@/lib/notifications/http";
import { readRecentNotifications } from "@/lib/notifications/public-feed";
import type { NotificationChainReader, NotificationEvent, NotificationWorkflow } from "@/lib/notifications/events";
import type { NotificationProcessorSource } from "@/lib/notifications/processor";
import type { Store } from "@/lib/points";
import { MemoryStore } from "@/lib/store";

const manifest = APPROVED_DEPLOYMENTS[0]!;
const blockHash = `0x${"44".repeat(32)}` as Hex;
const originalEnv = { ...process.env };

function notificationEvent(id: number): NotificationEvent {
  return {
    kind: "draft-created",
    eventName: "RaffleCreated",
    label: "Draft awaiting review",
    raffleId: String(id),
    blockNumber: "101",
    blockHash,
    transactionHash: `0x${id.toString(16).padStart(64, "0")}` as Hex,
    transactionIndex: id,
    logIndex: id,
    occurredAt: "2026-10-09T01:00:00.000Z",
    href: `/review/${id}`
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
});

function publicWorkflow(finalized: bigint, logIndexes: number[]): () => Promise<NotificationWorkflow> {
  const logs = logIndexes.map(index => ({
    address: manifest.address,
    blockNumber: finalized,
    blockHash,
    transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex,
    transactionIndex: index,
    logIndex: index,
    removed: false,
    topics: encodeEventTopics({ abi: raffleAbi, eventName: "Opened", args: { id: BigInt(index + 1) } }),
    data: "0x" as Hex
  }));
  const reader: NotificationChainReader = {
    async getChainId() { return manifest.chainId; },
    async getLogs(args) { return finalized >= args.fromBlock && finalized <= args.toBlock ? logs : []; },
    async getBlock(args) {
      const number = "blockTag" in args ? finalized : args.blockNumber;
      return { number, hash: number === finalized ? blockHash : `0x${number.toString(16).padStart(64, "0")}` as Hex, timestamp: 1_760_000_000n, gasLimit: 30_000_000n };
    }
  };
  return async () => ({
    context: { chainId: manifest.chainId, contract: manifest.address, origin: "https://labx.example" },
    manifest,
    client: reader,
    block: { number: finalized + 1n, hash: `0x${"55".repeat(32)}`, timestamp: 1_760_000_100n }
  });
}

describe("public notification feed", () => {
  it("paginates all events in one block without skipping the same-block tail", async () => {
    const workflow = publicWorkflow(manifest.deploymentBlock + 1n, [0, 1, 2]);
    const first = await readRecentNotifications({ workflow, limit: 2, now: 1_760_000_000_000 });
    const second = await readRecentNotifications({ workflow, limit: 2, cursor: first.nextCursor!, now: 1_760_000_000_000 });
    expect(first.items.map(item => item.raffleId)).toEqual(["3", "2"]);
    expect(second.items.map(item => item.raffleId)).toEqual(["1"]);
  });

  it("offers an older range cursor when the bounded recent scan is empty", async () => {
    const workflow = publicWorkflow(manifest.deploymentBlock + 2_500n, []);
    const page = await readRecentNotifications({ workflow, limit: 2, now: 1_760_000_000_000 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toMatch(/^before\./);
  });

  it("paginates every event in a dense finalized block", async () => {
    const workflow = publicWorkflow(manifest.deploymentBlock + 1n, Array.from({ length: 101 }, (_, index) => index));
    const first = await readRecentNotifications({ workflow, limit: 50, now: 1_760_000_000_000 });
    const second = await readRecentNotifications({ workflow, limit: 50, cursor: first.nextCursor!, now: 1_760_000_000_000 });
    const third = await readRecentNotifications({ workflow, limit: 50, cursor: second.nextCursor!, now: 1_760_000_000_000 });
    expect([first.items.length, second.items.length, third.items.length]).toEqual([50, 50, 1]);
    expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.transactionHash)).size).toBe(101);
  });

  it("rejects invalid public pagination before invoking the reader", async () => {
    const read = vi.fn();
    const response = await createNotificationsHandler({ read })(new Request("https://labx.example/api/notifications?cursor=bad"));
    expect(response.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("notification cron boundary", () => {
  it("fails closed before storage, RPC, or provider setup when cron auth is missing", async () => {
    delete process.env.CRON_SECRET;
    const dependencies = { store: vi.fn(), source: vi.fn(), sender: vi.fn() };
    const response = await createNotificationCronHandler(dependencies)(new Request("https://labx.example/api/cron/notifications"));
    expect(response.status).toBe(503);
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.source).not.toHaveBeenCalled();
    expect(dependencies.sender).not.toHaveBeenCalled();
  });

  it("returns a bounded unavailable response when initial source attestation fails", async () => {
    process.env.CRON_SECRET = "1234567890abcdef";
    process.env.RESEND_API_KEY = "resend-test";
    process.env.RESEND_FROM = "LABx <alerts@example.com>";
    process.env.LABX_ADMIN_EMAIL = "team@fantomlabs.io";
    const dependencies = {
      store: vi.fn(),
      source: vi.fn(async () => { throw new Error("rpc credentials rejected"); }),
      sender: vi.fn()
    };
    const response = await createNotificationCronHandler(dependencies)(new Request("https://labx.example/api/cron/notifications", {
      headers: { Authorization: "Bearer 1234567890abcdef" }
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Notification processing did not complete." });
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.sender).not.toHaveBeenCalled();
  });

  it("authorizes the configured bearer and returns a sanitized activation report", async () => {
    process.env.CRON_SECRET = "1234567890abcdef";
    process.env.RESEND_API_KEY = "resend-test";
    process.env.RESEND_FROM = "LABx <alerts@example.com>";
    process.env.LABX_ADMIN_EMAIL = "team@fantomlabs.io";
    const source = {
      deployment: `${manifest.chainId}:${manifest.address.toLowerCase()}`,
      origin: "https://labx.example",
      latest: { number: 100n, hash: `0x${"11".repeat(32)}` as Hex, timestamp: 1n },
      async finalized() { return { number: 100n, hash: `0x${"11".repeat(32)}` as Hex, timestamp: 1n }; },
      async block(number: bigint) { return { number, hash: `0x${"11".repeat(32)}` as Hex, timestamp: 1n }; },
      async events() { throw new Error("not reached"); }
    };
    let sends = 0;
    const response = await createNotificationCronHandler({
      store: () => new MemoryStore(),
      source: async () => source,
      sender: () => async () => { sends += 1; return true; }
    })(new Request("https://labx.example/api/cron/notifications", { headers: { Authorization: "Bearer 1234567890abcdef" } }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "activated", activationBlock: "100" });
    expect(sends).toBe(0);
  });

  it("returns a sanitized degraded report when ingestion is blocked", async () => {
    process.env.CRON_SECRET = "1234567890abcdef";
    process.env.RESEND_API_KEY = "resend-test";
    process.env.RESEND_FROM = "LABx <alerts@example.com>";
    process.env.LABX_ADMIN_EMAIL = "team@fantomlabs.io";
    const store = new MemoryStore();
    const source = {
      deployment: `${manifest.chainId}:${manifest.address.toLowerCase()}`,
      origin: "https://labx.example",
      latest: { number: 100n, hash: `0x${"11".repeat(32)}` as Hex, timestamp: 1n },
      async finalized() { return { number: 101n, hash: blockHash, timestamp: 2n }; },
      async block(number: bigint) { return { number, hash: number === 100n ? `0x${"11".repeat(32)}` as Hex : blockHash, timestamp: 1n, gasLimit: 30_000_000n }; },
      async events() { throw new Error("private provider detail"); }
    };
    const dependencies = { store: () => store, source: async () => source, sender: () => async () => true };
    const request = () => new Request("https://labx.example/api/cron/notifications", { headers: { Authorization: "Bearer 1234567890abcdef" } });
    await createNotificationCronHandler(dependencies)(request());
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await createNotificationCronHandler(dependencies)(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, status: "degraded", ingestion: { status: "blocked", reason: "source-unavailable" } });
    expect(JSON.stringify(body)).not.toContain("private provider detail");
    expect(logged).toHaveBeenCalledWith("notification-cron", expect.objectContaining({ status: "degraded" }));
    logged.mockRestore();
  });

  it("shares one route deadline across source, activation verification, retry sends, and ingestion", async () => {
    process.env.CRON_SECRET = "1234567890abcdef";
    process.env.RESEND_API_KEY = "resend-test";
    process.env.RESEND_FROM = "LABx <alerts@example.com>";
    process.env.LABX_ADMIN_EMAIL = "team@fantomlabs.io";
    const store = new MemoryStore();
    const deployment = `${manifest.chainId}:${manifest.address.toLowerCase()}`;
    const prefix = `raffle-notifications:v1:${deployment}`;
    const events = [notificationEvent(1), notificationEvent(2), notificationEvent(3)];
    await store.setIfAbsent({
      [`${prefix}:activation`]: JSON.stringify({ version: 1, deployment, blockNumber: "100", blockHash: `0x${"11".repeat(32)}` }),
      [`${prefix}:page:101`]: JSON.stringify({ version: 1, deployment, startBlock: "101", actualEnd: "101", nextBlock: "102", events }),
      [`${prefix}:ingestion-proof:102`]: "101"
    });
    await store.set(`${prefix}:ingestion-hint`, "102");
    await store.set(`${prefix}:last-ingested-page`, "101");

    let fakeNow = 0;
    let eventReads = 0;
    const source: NotificationProcessorSource = {
      deployment,
      origin: "https://labx.example",
      latest: { number: 100n, hash: `0x${"11".repeat(32)}` as Hex, timestamp: 1n },
      async finalized() { fakeNow += 6_000; return { number: 102n, hash: blockHash, timestamp: 2n }; },
      async block(number) { fakeNow += 6_000; return { number, hash: number === 100n ? `0x${"11".repeat(32)}` as Hex : blockHash, timestamp: 1n, gasLimit: 30_000_000n }; },
      async events(fromBlock, toBlock) {
        fakeNow += 6_000;
        eventReads += 1;
        return { events: [], range: { fromBlock, toBlock }, finalized: { number: 102n, hash: blockHash, timestamp: 2n }, singleBlock: { number: 102n, hash: blockHash, gasLimit: 30_000_000n } };
      }
    };
    const originalNow = Date.now;
    Date.now = () => fakeNow;
    try {
      const sender = vi.fn(async () => { fakeNow += 10_000; return true; });
      const response = await createNotificationCronHandler({
        store: () => store,
        source: async () => { fakeNow += 12_000; return source; },
        sender: () => sender
      })(new Request("https://labx.example/api/cron/notifications", { headers: { Authorization: "Bearer 1234567890abcdef" } }));
      expect(response.status).toBe(200);
      expect(fakeNow).toBeLessThan(60_000);
      expect(sender).toHaveBeenCalledTimes(2);
      expect(eventReads).toBe(1);
    } finally {
      Date.now = originalNow;
    }
  });

  it("returns ok false after an isolated delivery storage failure while later work succeeds", async () => {
    process.env.CRON_SECRET = "1234567890abcdef";
    process.env.RESEND_API_KEY = "resend-test";
    process.env.RESEND_FROM = "LABx <alerts@example.com>";
    process.env.LABX_ADMIN_EMAIL = "team@fantomlabs.io";
    const backing = new MemoryStore();
    let failed = false;
    const store: Store = {
      get: key => backing.get(key),
      set: (key, value) => backing.set(key, value),
      async setIfAbsent(entries) {
        if (!failed && Object.keys(entries).some(key => /^raffle-notification:[^:]+$/.test(key))) {
          failed = true;
          throw new Error("temporary reservation failure");
        }
        return backing.setIfAbsent(entries);
      }
    };
    const deployment = `${manifest.chainId}:${manifest.address.toLowerCase()}`;
    const events = [notificationEvent(1), notificationEvent(2)];
    const source: NotificationProcessorSource = {
      deployment,
      origin: "https://labx.example",
      latest: { number: 100n, hash: `0x${"11".repeat(32)}` as Hex, timestamp: 1n },
      async finalized() { return { number: 101n, hash: blockHash, timestamp: 2n }; },
      async block(number) { return { number, hash: number === 100n ? `0x${"11".repeat(32)}` as Hex : blockHash, timestamp: 1n, gasLimit: 30_000_000n }; },
      async events(fromBlock, toBlock) {
        return { events, range: { fromBlock, toBlock }, finalized: { number: 101n, hash: blockHash, timestamp: 2n }, singleBlock: { number: 101n, hash: blockHash, gasLimit: 30_000_000n } };
      }
    };
    const dependencies = { store: () => store, source: async () => source, sender: () => async () => true };
    const request = () => new Request("https://labx.example/api/cron/notifications", { headers: { Authorization: "Bearer 1234567890abcdef" } });
    await createNotificationCronHandler(dependencies)(request());
    const response = await createNotificationCronHandler(dependencies)(request());
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, status: "degraded", accepted: 1, pending: 1, processingFailures: 1 });
    expect(body.lastIncident).toMatchObject({ kind: "delivery", reason: "processing-failed" });
  });

  it("rejects an unauthorized connection test before all dependencies", async () => {
    process.env.CRON_SECRET = "1234567890abcdef";
    const dependencies = { store: vi.fn(), source: vi.fn(), sender: vi.fn() };
    const response = await createNotificationConnectionTestHandler(dependencies)(new Request("https://labx.example/api/cron/notifications", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.source).not.toHaveBeenCalled();
    expect(dependencies.sender).not.toHaveBeenCalled();
  });

  it("sends the fixed connection test without activation or event-page writes", async () => {
    process.env.CRON_SECRET = "1234567890abcdef";
    process.env.RESEND_API_KEY = "resend-test";
    process.env.RESEND_FROM = "LABx <alerts@example.com>";
    process.env.LABX_ADMIN_EMAIL = "team@fantomlabs.io";
    const backing = new MemoryStore();
    const written: string[] = [];
    const store = {
      get: (key: string) => backing.get(key),
      async set(key: string, value: string) { written.push(key); await backing.set(key, value); },
      async setIfAbsent(entries: Record<string, string>) { written.push(...Object.keys(entries)); return backing.setIfAbsent(entries); }
    };
    const source = {
      deployment: `${manifest.chainId}:${manifest.address.toLowerCase()}`,
      origin: "https://labx.example",
      latest: { number: 100n, hash: `0x${"11".repeat(32)}` as Hex, timestamp: 1n },
      async finalized() { throw new Error("not reached"); },
      async block() { throw new Error("not reached"); },
      async events() { throw new Error("not reached"); }
    };
    const sender = vi.fn(async () => true);
    const response = await createNotificationConnectionTestHandler({
      store: () => store,
      source: async () => source,
      sender: () => sender
    })(new Request("https://labx.example/api/cron/notifications", {
      method: "POST",
      headers: { Authorization: "Bearer 1234567890abcdef" }
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "accepted", providerAccepted: true });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(written.length).toBeGreaterThan(0);
    expect(written.every(key => key.startsWith("raffle-notification-test:"))).toBe(true);
  });

  it("rejects a connection-test body before RPC, storage, or provider setup", async () => {
    process.env.CRON_SECRET = "1234567890abcdef";
    process.env.RESEND_API_KEY = "resend-test";
    process.env.RESEND_FROM = "LABx <alerts@example.com>";
    process.env.LABX_ADMIN_EMAIL = "team@fantomlabs.io";
    const dependencies = { store: vi.fn(), source: vi.fn(), sender: vi.fn() };
    const response = await createNotificationConnectionTestHandler(dependencies)(new Request("https://labx.example/api/cron/notifications", {
      method: "POST",
      headers: { Authorization: "Bearer 1234567890abcdef" },
      body: "{}"
    }));
    expect(response.status).toBe(400);
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.source).not.toHaveBeenCalled();
    expect(dependencies.sender).not.toHaveBeenCalled();
  });
});
