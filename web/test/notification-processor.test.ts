import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@/lib/store";
import { processNotifications, type NotificationProcessorSource } from "@/lib/notifications/processor";
import type { NotificationEvent } from "@/lib/notifications/delivery";

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
    async block(number) { return number === 100n ? { number, hash: activationHash, timestamp: 1n } : { number, hash: finalizedHash, timestamp: 2n }; },
    async events(fromBlock, toBlock) { return { events, range: { fromBlock, toBlock }, finalized: { number: 101n, hash: finalizedHash, timestamp: 2n } }; }
  };
}

const config = { from: "LABx <alerts@example.com>", transportIdentity: "a".repeat(64) };

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
    input.block = async number => ({ number, hash: finalizedHash, timestamp: 1n });
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
});
