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
    expect(report).toMatchObject({ accepted: 1, pending: 1 });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await backing.get(`${reservationKey(events[1]!, input.deployment)}:accepted`)).toBe("accepted");
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
