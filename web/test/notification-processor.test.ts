import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes } from "viem";
import { MemoryStore } from "@/lib/store";
import type { Store } from "@/lib/points";
import { processNotifications, type NotificationProcessorSource } from "@/lib/notifications/processor";
import { deliverNotification, type NotificationEvent } from "@/lib/notifications/delivery";

const activationHash = `0x${"11".repeat(32)}` as const;
const finalizedHash = `0x${"22".repeat(32)}` as const;
const event = (id: number, kind: NotificationEvent["kind"] = "draft-created"): NotificationEvent => ({
  kind,
  eventName: kind === "draft-created" ? "RaffleCreated" : "Opened",
  label: kind === "draft-created" ? "Draft awaiting review" : "Raffle live",
  raffleId: String(id), blockNumber: "101", blockHash: finalizedHash,
  transactionHash: `0x${id.toString(16).padStart(64, "0")}`, logIndex: id,
  transactionIndex: id,
  occurredAt: "2026-10-09T01:00:00.000Z", href: kind === "draft-created" ? `/review/${id}` : `/piece/${id}`
});

function source(events: NotificationEvent[] = []): NotificationProcessorSource {
  return {
    deployment: "11155111:0x8b0332d0ca48908e174f42ea1b3123e63f3f4327",
    origin: "https://labx.example",
    latest: { number: 100n, hash: activationHash, timestamp: 1n },
    async finalized() { return { number: 101n, hash: finalizedHash, timestamp: 2n }; },
    async block(number) { return number === 100n ? { number, hash: activationHash, timestamp: 1n, gasLimit: 30_000_000n } : { number, hash: finalizedHash, timestamp: 2n, gasLimit: 30_000_000n }; },
    async events(fromBlock, toBlock) {
      return {
        events,
        range: { fromBlock, toBlock },
        finalized: { number: 101n, hash: finalizedHash, timestamp: 2n },
        ...(fromBlock === toBlock ? { singleBlock: { number: fromBlock, hash: finalizedHash, gasLimit: 30_000_000n } } : {})
      };
    }
  };
}

const config = { from: "LABx <alerts@example.com>", transportIdentity: "a".repeat(64) };
const reservationKey = (item: NotificationEvent, deployment: string) => `raffle-notification:${keccak256(toBytes(`${deployment}:${item.blockHash}:${item.transactionHash}:${item.logIndex}:${item.eventName}`))}`;

describe("notification processor", () => {
  it("only records the activation boundary on the first run", async () => {
    const store = new MemoryStore();
    const sender = vi.fn(async () => true);
    const report = await processNotifications({ store, source: source([event(1)]), sender, ...config, now: 1_000 });
    expect(report.status).toBe("activated");
    expect(report.activationBlock).toBe("100");
    expect(sender).not.toHaveBeenCalled();
  });

  it("persists complete pages before attempting mail and lets a failed event yield to later events", async () => {
    const store = new MemoryStore();
    const input = source([event(1), event(2, "sales-opened")]);
    await processNotifications({ store, source: input, sender: async () => true, ...config, now: 1_000 });
    const sender = vi.fn(async (_payload, key) => !key.includes("unused"));
    sender.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const report = await processNotifications({ store, source: input, sender, ...config, now: 2_000 });
    expect(report.ingestedEvents).toBe(2);
    expect(report.pending).toBe(1);
    expect(report.accepted).toBe(1);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("stops before ingestion and records reconciliation when the activation block changes", async () => {
    const store = new MemoryStore();
    const input = source([event(1)]);
    await processNotifications({ store, source: input, sender: async () => true, ...config, now: 1_000 });
    input.block = async number => ({ number, hash: finalizedHash, timestamp: 1n, gasLimit: 30_000_000n });
    const sender = vi.fn(async () => true);
    const report = await processNotifications({ store, source: input, sender, ...config, now: 2_000 });
    expect(report.status).toBe("reconciliation-required");
    expect(report.reconciliation).toContain("activation boundary");
    expect(sender).not.toHaveBeenCalled();
  });

  it("treats unproved future progress hints as replay hints", async () => {
    const store = new MemoryStore();
    const input = source([event(1), event(2)]);
    await processNotifications({ store, source: input, sender: async () => true, ...config, now: 1_000 });
    const prefix = `raffle-notifications:v1:${input.deployment}`;
    await store.set(`${prefix}:ingestion-hint`, "1000");
    await store.set(`${prefix}:retry-hint`, "1000");
    const sender = vi.fn(async () => true);
    const report = await processNotifications({ store, source: input, sender, ...config, now: 2_000 });
    expect(report.ingestedEvents).toBe(2);
    expect(report.accepted).toBe(2);
  });

  it("continues the page after a thrown provider request", async () => {
    const store = new MemoryStore();
    const input = source([event(1), event(2)]);
    await processNotifications({ store, source: input, sender: async () => true, ...config, now: 1_000 });
    const sender = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(true);
    const report = await processNotifications({ store, source: input, sender, ...config, now: 2_000 });
    expect(report.pending).toBe(1);
    expect(report.accepted).toBe(1);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("replays safely when every mutable progress position is malformed", async () => {
    const store = new MemoryStore();
    const input = source([event(1)]);
    await processNotifications({ store, source: input, sender: async () => true, ...config, now: 1_000 });
    await processNotifications({ store, source: input, sender: async () => false, ...config, now: 2_000 });
    const prefix = `raffle-notifications:v1:${input.deployment}`;
    await store.set(`${prefix}:ingestion-hint`, "not-a-block");
    await store.set(`${prefix}:retry-hint`, "not-a-block");
    await store.set(`${prefix}:last-ingested-page`, "not-a-block");
    await store.set(`${prefix}:page:101:resume`, "not-an-index");
    const sender = vi.fn(async () => true);
    const report = await processNotifications({ store, source: input, sender, ...config, now: 3_000 });
    expect(report.accepted).toBe(1);
    expect(report.retryNextBlock).toBe("102");
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an immutable progress proof is malformed", async () => {
    const store = new MemoryStore();
    const input = source([event(1)]);
    await processNotifications({ store, source: input, sender: async () => true, ...config, now: 1_000 });
    await processNotifications({ store, source: input, sender: async () => false, ...config, now: 2_000 });
    const prefix = `raffle-notifications:v1:${input.deployment}`;
    await store.set(`${prefix}:ingestion-proof:102`, "not-a-block");
    await expect(processNotifications({ store, source: input, sender: async () => true, ...config, now: 3_000 }))
      .rejects.toThrow(/progress proof is invalid/);
  });

  it("retries a durable delivery before reporting a later ingestion failure", async () => {
    const store = new MemoryStore();
    let finalized = 100n;
    const item = event(1);
    const input = source([item]);
    input.finalized = async () => ({ number: finalized, hash: finalized === 101n ? finalizedHash : `0x${"33".repeat(32)}`, timestamp: 2n });
    input.events = async (fromBlock, toBlock) => {
      if (fromBlock === 101n) return {
        events: [item],
        range: { fromBlock, toBlock },
        finalized: { number: 101n, hash: finalizedHash, timestamp: 2n },
        singleBlock: { number: 101n, hash: finalizedHash, gasLimit: 30_000_000n }
      };
      throw new Error("temporary ingestion fault");
    };
    await processNotifications({ store, source: input, sender: async () => false, ...config, now: 1_000 });
    finalized = 101n;
    await processNotifications({ store, source: input, sender: async () => false, ...config, now: 2_000 });
    finalized = 102n;
    const sender = vi.fn(async () => true);
    const report = await processNotifications({ store, source: input, sender, ...config, now: 3_000 });
    expect(report).toMatchObject({ status: "degraded", accepted: 1, ingestion: { status: "blocked", reason: "source-unavailable" } });
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("checks send capacity before creating a fourth reservation", async () => {
    const store = new MemoryStore();
    const events = [event(1), event(2), event(3), event(4)];
    const input = source(events);
    await processNotifications({ store, source: input, sender: async () => true, ...config, now: 1_000 });
    const report = await processNotifications({ store, source: input, sender: async () => true, ...config, now: 2_000 });
    expect(report.sends).toBe(3);
    expect(await store.get(reservationKey(events[3]!, input.deployment))).toBeNull();
  });

  it("isolates a reservation write failure and delivers the later event", async () => {
    const backing = new MemoryStore();
    const events = [event(1), event(2)];
    const input = source(events);
    const failedKey = reservationKey(events[0]!, input.deployment);
    let failed = false;
    const store: Store = {
      get: key => backing.get(key),
      set: (key, value) => backing.set(key, value),
      async setIfAbsent(entries) {
        if (!failed && Object.hasOwn(entries, failedKey)) {
          failed = true;
          throw new Error("temporary reservation storage failure");
        }
        return backing.setIfAbsent(entries);
      }
    };
    await processNotifications({ store, source: input, sender: async () => true, ...config, now: 1_000 });
    const sender = vi.fn(async () => true);
    const report = await processNotifications({ store, source: input, sender, ...config, now: 2_000 });
    expect(failed).toBe(true);
    expect(report).toMatchObject({ status: "degraded", accepted: 1, pending: 1, processingFailures: 1 });
    expect(sender).toHaveBeenCalledTimes(1);
    const prefix = `raffle-notifications:v1:${input.deployment}`;
    expect(await backing.get(`${prefix}:page:101:event-incident:0`)).not.toBeNull();
    expect(await backing.get(`${prefix}:retry-proof:102`)).toBeNull();
    expect(await backing.get(`${reservationKey(events[1]!, input.deployment)}:accepted`)).toBe("accepted");

    const recovered = await processNotifications({ store, source: input, sender: async () => true, ...config, now: 3_000 });
    expect(recovered).toMatchObject({ status: "ok", processingFailures: 0, retryNextBlock: "102" });
  });

  it("stops a slow terminal-prefix scan at its phase deadline without advancing retry progress", async () => {
    const backing = new MemoryStore();
    const input = source([]);
    const events = Array.from({ length: 500 }, (_, index) => event(index + 1));
    const prefix = `raffle-notifications:v1:${input.deployment}`;
    const pageKey = `${prefix}:page:101`;
    await backing.setIfAbsent({
      [`${prefix}:activation`]: JSON.stringify({ version: 1, deployment: input.deployment, blockNumber: "100", blockHash: activationHash }),
      [`${prefix}:activation-verified`]: JSON.stringify({ version: 1, blockNumber: "100", blockHash: activationHash }),
      [pageKey]: JSON.stringify({
        version: 2, kind: "single-block", deployment: input.deployment,
        startBlock: "101", actualEnd: "101", nextBlock: "102",
        blockNumber: "101", blockHash: finalizedHash, gasLimit: "30000000", events
      }),
      [`${prefix}:ingestion-proof:102`]: "101"
    });
    await backing.set(`${prefix}:ingestion-hint`, "102");
    await backing.set(`${prefix}:last-ingested-page`, "101");
    await backing.set(`${pageKey}:resume`, "497");
    for (let index = 0; index < 497; index += 1) await backing.set(`${pageKey}:terminal:${index}`, "terminal");

    let fakeNow = 0;
    const store: Store = {
      async get(key) {
        if (/page:101:terminal:\d+$/.test(key)) fakeNow += 100;
        return backing.get(key);
      },
      set: (key, value) => backing.set(key, value),
      setIfAbsent: entries => backing.setIfAbsent(entries)
    };
    const originalNow = Date.now;
    Date.now = () => fakeNow;
    try {
      const report = await processNotifications({
        store, source: input, sender: async () => true, ...config, now: 2_000, deadline: 31_000
      });
      expect(report).toMatchObject({ retryNextBlock: "101", sends: 3 });
      expect(fakeNow).toBeLessThanOrEqual(12_000);
      expect(await backing.get(`${prefix}:retry-proof:102`)).toBeNull();
      expect(await backing.get(`${pageKey}:terminal-proof:500`)).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  it("preserves ingestion persistence and resumes safely after slow successful retry writes", async () => {
    const backing = new MemoryStore();
    const input = source([]);
    const item = event(1);
    const prefix = `raffle-notifications:v1:${input.deployment}`;
    const key = reservationKey(item, input.deployment);
    await backing.setIfAbsent({
      [`${prefix}:activation`]: JSON.stringify({ version: 1, deployment: input.deployment, blockNumber: "100", blockHash: activationHash }),
      [`${prefix}:page:101`]: JSON.stringify({ version: 1, deployment: input.deployment, startBlock: "101", actualEnd: "101", nextBlock: "102", events: [item] }),
      [`${prefix}:ingestion-proof:102`]: "101"
    });
    await backing.set(`${prefix}:ingestion-hint`, "102");
    await backing.set(`${prefix}:last-ingested-page`, "101");
    let fakeNow = 12_000;
    let slow = true;
    let sent = false;
    const delay = () => { if (sent && slow) fakeNow += 2_000; };
    const store: Store = {
      async get(key) { delay(); return backing.get(key); },
      async set(key, value) { delay(); return backing.set(key, value); },
      async setIfAbsent(entries) { delay(); return backing.setIfAbsent(entries); }
    };
    input.finalized = async () => {
      if (slow) fakeNow += 6_000;
      return { number: 102n, hash: finalizedHash, timestamp: 2n };
    };
    input.block = async number => {
      if (slow) fakeNow += 6_000;
      return { number, hash: activationHash, timestamp: 1n };
    };
    const eventReads = vi.fn(async (fromBlock: bigint, toBlock: bigint) => ({
      events: [], range: { fromBlock, toBlock },
      finalized: { number: 102n, hash: finalizedHash, timestamp: 2n },
      singleBlock: { number: 102n, hash: finalizedHash, gasLimit: 30_000_000n }
    }));
    input.events = eventReads;
    const sender = vi.fn(async () => { fakeNow += 10_000; sent = true; return true; });
    const time = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      const report = await processNotifications({ store, source: input, sender, ...config, deadline: 56_000 });
      expect(report).toMatchObject({ status: "degraded", accepted: 0, pending: 0, retryNextBlock: "101", ingestionNextBlock: "102" });
      expect(eventReads).toHaveBeenCalledTimes(1);
      expect(await backing.get(`${key}:accepted`)).toBe("accepted");
      expect(await backing.get(`${prefix}:page:101:terminal:0`)).toBeNull();
      expect(await backing.get(`${prefix}:retry-proof:102`)).toBeNull();
      expect(await backing.get(`${prefix}:page:102`)).not.toBeNull();
      expect(await backing.get(`${prefix}:ingestion-proof:103`)).toBe("102");
      expect(await backing.get(`${prefix}:ingestion-hint`)).toBe("102");
      const reservation = await backing.get(key);
      slow = false;
      const recovered = await processNotifications({ store, source: input, sender, ...config, deadline: fakeNow + 56_000 });
      expect(recovered).toMatchObject({ status: "ok", accepted: 1, retryNextBlock: "103", ingestionNextBlock: "103" });
      expect(sender).toHaveBeenCalledTimes(1);
      expect(eventReads).toHaveBeenCalledTimes(1);
      expect(await backing.get(key)).toBe(reservation);
    } finally {
      time.mockRestore();
    }
  });

  it("retries an uncertain provider attempt with the immutable original reservation and key", async () => {
    const store = new MemoryStore();
    const input = source([event(1)]);
    await processNotifications({ store, source: input, sender: async () => true, ...config });
    let fakeNow = 0;
    const keys: string[] = [];
    const sender = vi.fn(async (_payload, key: string) => { keys.push(key); fakeNow = 31_001; return true; });
    const time = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    const key = reservationKey(event(1), input.deployment);
    const prefix = `raffle-notifications:v1:${input.deployment}`;
    try {
      const report = await processNotifications({ store, source: input, sender, ...config, deadline: 56_000 });
      expect(report).toMatchObject({ status: "degraded", sends: 1, accepted: 0, retryNextBlock: "101" });
      const reservation = await store.get(key);
      expect(reservation).not.toBeNull();
      expect(await store.get(`${key}:accepted`)).toBeNull();
      expect(await store.get(`${prefix}:page:101:terminal:0`)).toBeNull();
      expect(await store.get(`${prefix}:retry-proof:102`)).toBeNull();
      const recovered = await processNotifications({
        store, source: input, ...config, deadline: fakeNow + 56_000,
        sender: async (_payload, retryKey) => { keys.push(retryKey); return true; }
      });
      expect(recovered).toMatchObject({ status: "ok", accepted: 1, retryNextBlock: "102" });
      expect(keys).toEqual([key, key]);
      expect(await store.get(key)).toBe(reservation);
    } finally {
      time.mockRestore();
    }
  });

  it("times out a real asynchronous store read and starts no calls when it later resolves", async () => {
    const backing = new MemoryStore();
    const input = source();
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const store: Store = {
      async get(key) { calls.push(key); await held; return backing.get(key); },
      async set(key, value) { calls.push(key); return backing.set(key, value); },
      async setIfAbsent(entries) { calls.push(...Object.keys(entries)); return backing.setIfAbsent(entries); }
    };
    const sender = vi.fn(async () => true);
    const finalized = vi.spyOn(input, "finalized");
    await expect(processNotifications({ store, source: input, sender, ...config, deadline: Date.now() + 30 })).rejects.toThrow(/deadline/);
    const completedCalls = [...calls];
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls).toEqual(completedCalls);
    expect(sender).not.toHaveBeenCalled();
    expect(finalized).not.toHaveBeenCalled();
  });

  it("passes the remaining absolute ingestion cutoff into source event reads", async () => {
    const backing = new MemoryStore();
    const input = source();
    await processNotifications({ store: backing, source: input, sender: async () => true, ...config });
    let fakeNow = 0;
    const store: Store = {
      async get(key) {
        if (key.endsWith(":ingestion-hint")) fakeNow += 13_000;
        return backing.get(key);
      },
      set: (key, value) => backing.set(key, value),
      setIfAbsent: entries => backing.setIfAbsent(entries)
    };
    const read = input.events;
    const eventReads = vi.fn(async (start: bigint, end: bigint, deadline: number) => {
      expect(fakeNow).toBe(13_000);
      expect(deadline).toBe(18_000);
      return read(start, end, deadline);
    });
    input.events = eventReads;
    const time = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      const report = await processNotifications({ store, source: input, sender: async () => true, ...config, deadline: 56_000 });
      expect(report.ingestedPages).toBe(1);
      expect(eventReads).toHaveBeenCalledTimes(1);
    } finally {
      time.mockRestore();
    }
  });

  it("does not reserve a first attempt when its initial read consumes the send allowance", async () => {
    const backing = new MemoryStore();
    const input = source([event(1)]);
    await processNotifications({ store: backing, source: input, sender: async () => false, ...config });
    const key = reservationKey(event(1), input.deployment);
    let fakeNow = 0;
    const store: Store = {
      async get(lookup) {
        const value = await backing.get(lookup);
        if (lookup === key) fakeNow += 33_000;
        return value;
      },
      set: (key, value) => backing.set(key, value),
      setIfAbsent: entries => backing.setIfAbsent(entries)
    };
    const sender = vi.fn(async () => true);
    const time = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      const report = await processNotifications({ store, source: input, sender, ...config, deadline: 43_000 });
      expect(report).toMatchObject({ status: "degraded", sends: 0, accepted: 0, pending: 0 });
      expect(sender).not.toHaveBeenCalled();
      expect(await backing.get(key)).toBeNull();
      expect(await backing.get(`${key}:accepted`)).toBeNull();
    } finally {
      time.mockRestore();
    }
  });

  it("resumes above index 999 and completes a dense page across bounded passes", async () => {
    const store = new MemoryStore();
    const events = Array.from({ length: 1_001 }, (_, index) => event(index + 1));
    const input = source([]);
    await processNotifications({ store, source: input, sender: async () => true, ...config, now: 1_000 });
    const prefix = `raffle-notifications:v1:${input.deployment}`;
    const pageKey = `${prefix}:page:101`;
    await store.setIfAbsent({
      [pageKey]: JSON.stringify({
        version: 2,
        kind: "single-block",
        deployment: input.deployment,
        startBlock: "101",
        actualEnd: "101",
        nextBlock: "102",
        blockNumber: "101",
        blockHash: finalizedHash,
        gasLimit: "30000000",
        events
      }),
      [`${prefix}:ingestion-proof:102`]: "101"
    });
    await store.set(`${prefix}:ingestion-hint`, "102");
    await store.set(`${pageKey}:resume`, "1000");
    await Promise.all(events.map(item => deliverNotification({
      store,
      event: item,
      deployment: input.deployment,
      origin: input.origin,
      sender: async () => true,
      ...config,
      now: 1_500
    })));
    const sender = vi.fn(async () => true);
    await processNotifications({ store, source: input, sender, ...config, now: 2_000 });
    await processNotifications({ store, source: input, sender, ...config, now: 3_000 });
    const report = await processNotifications({ store, source: input, sender, ...config, now: 4_000 });
    expect(report.retryNextBlock).toBe("102");
    expect(sender).not.toHaveBeenCalled();
  });
});
