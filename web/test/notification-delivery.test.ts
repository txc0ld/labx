import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes } from "viem";
import { MemoryStore } from "@/lib/store";
import { ADMIN_NOTIFICATION_RECIPIENT, deliverAdminConnectionTest, deliverNotification, type NotificationEvent } from "@/lib/notifications/delivery";

const event: NotificationEvent = {
  kind: "draft-created",
  eventName: "RaffleCreated",
  label: "Draft awaiting review",
  raffleId: "12",
  blockNumber: "101",
  blockHash: `0x${"11".repeat(32)}`,
  transactionHash: `0x${"22".repeat(32)}`,
  transactionIndex: 1,
  logIndex: 3,
  occurredAt: "2026-10-09T01:02:03.000Z",
  href: "/review/12"
};

const baseTime = Date.UTC(2026, 9, 9, 1, 5);
const base = {
  event,
  deployment: "11155111:0x8b0332d0ca48908e174f42ea1b3123e63f3f4327",
  origin: "https://labx.example",
  from: "LABx <alerts@example.com>",
  transportIdentity: "a".repeat(64),
  now: baseTime,
  clock: () => baseTime
};

describe("admin notification delivery", () => {
  it("reserves one immutable payload and safely retries an uncertain acknowledgement", async () => {
    const store = new MemoryStore();
    const calls: { key: string; payload: { to: string; subject: string } }[] = [];
    const sender = vi.fn(async (payload, key) => {
      calls.push({ key, payload });
      return calls.length > 1;
    });

    await expect(deliverNotification({ ...base, store, sender })).resolves.toMatchObject({ status: "pending" });
    await expect(deliverNotification({ ...base, store, sender, now: base.now + 1_000 })).resolves.toMatchObject({ status: "accepted", repeated: false });
    await expect(deliverNotification({ ...base, store, sender, now: base.now + 2_000 })).resolves.toMatchObject({ status: "accepted", repeated: true });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]?.payload.to).toBe(ADMIN_NOTIFICATION_RECIPIENT);
    expect(calls[0]?.payload.subject).toContain("Draft awaiting review");
    expect(calls[0]?.key).toBe(`raffle-notification:${keccak256(toBytes(`${base.deployment}:${event.blockHash}:${event.transactionHash}:${event.logIndex}:RaffleCreated`))}`);
  });

  it.each([
    ["provider identity changed", { transportIdentity: "b".repeat(64), now: base.now + 1_000, clock: () => baseTime + 1_000 }],
    ["safe retry window ended", { now: base.now + 23 * 60 * 60 * 1_000, clock: () => baseTime + 23 * 60 * 60 * 1_000 }]
  ])("records reconciliation when the %s", async (_name, changed) => {
    const store = new MemoryStore();
    await deliverNotification({ ...base, store, sender: async () => false });
    const sender = vi.fn(async () => true);
    const result = await deliverNotification({ ...base, ...changed, store, sender });
    expect(result.status).toBe("reconciliation-required");
    expect(sender).not.toHaveBeenCalled();
    expect(await store.get(`${result.key}:reconciliation`)).not.toBeNull();
  });

  it("records corrupt persisted reservations for reconciliation without sending", async () => {
    const store = new MemoryStore();
    const key = `raffle-notification:${keccak256(toBytes(`${base.deployment}:${event.blockHash}:${event.transactionHash}:${event.logIndex}:RaffleCreated`))}`;
    await store.set(key, JSON.stringify({ version: 1, payload: { to: "attacker@example.com" } }));
    const sender = vi.fn(async () => true);
    await expect(deliverNotification({ ...base, store, sender }))
      .resolves.toMatchObject({ status: "reconciliation-required", reason: "invalid-record" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("treats a thrown provider request as pending", async () => {
    const store = new MemoryStore();
    await expect(deliverNotification({ ...base, store, sender: async () => { throw new Error("network down"); } }))
      .resolves.toMatchObject({ status: "pending" });
  });

  it("checks the retry cutoff after delayed reservation reads", async () => {
    const store = new MemoryStore();
    await deliverNotification({ ...base, store, sender: async () => false });
    const sender = vi.fn(async () => true);
    await expect(deliverNotification({
      ...base,
      store,
      sender,
      now: baseTime + 1_000,
      clock: () => baseTime + 23 * 60 * 60 * 1_000
    })).resolves.toMatchObject({ status: "reconciliation-required", reason: "retry-window-ended" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("records payload configuration drift but preserves historical acceptance", async () => {
    const pendingStore = new MemoryStore();
    await deliverNotification({ ...base, store: pendingStore, sender: async () => false });
    const changedSender = vi.fn(async () => true);
    await expect(deliverNotification({
      ...base,
      store: pendingStore,
      sender: changedSender,
      from: "LABx <fixed@example.com>"
    })).resolves.toMatchObject({ status: "reconciliation-required", reason: "payload-configuration-changed" });
    expect(changedSender).not.toHaveBeenCalled();

    const acceptedStore = new MemoryStore();
    await deliverNotification({ ...base, store: acceptedStore, sender: async () => true });
    await expect(deliverNotification({
      ...base,
      store: acceptedStore,
      sender: changedSender,
      from: "LABx <fixed@example.com>"
    })).resolves.toMatchObject({ status: "accepted", repeated: true });
    expect(changedSender).not.toHaveBeenCalled();
  });
});

describe("admin connection test delivery", () => {
  const connection = {
    deployment: base.deployment,
    from: base.from,
    transportIdentity: base.transportIdentity,
    now: baseTime,
    clock: () => baseTime
  };

  it("uses one fixed payload and provider idempotency identity across concurrent requests", async () => {
    const store = new MemoryStore();
    const calls: { key: string; subject: string; to: string; text: string }[] = [];
    const sender = vi.fn(async (payload, key) => {
      calls.push({ key, subject: payload.subject, to: payload.to, text: payload.text });
      return true;
    });
    const results = await Promise.all([
      deliverAdminConnectionTest({ ...connection, store, sender }),
      deliverAdminConnectionTest({ ...connection, store, sender })
    ]);
    expect(results.every(result => result.status === "accepted")).toBe(true);
    expect(new Set(calls.map(call => call.key)).size).toBe(1);
    expect(calls[0]).toMatchObject({
      subject: "LABx admin alert connection test",
      to: ADMIN_NOTIFICATION_RECIPIENT,
      text: "This is a LABx admin alert configuration test. It does not report raffle activity."
    });
  });

  it("retries a lost acknowledgement with the exact same provider key", async () => {
    const store = new MemoryStore();
    const keys: string[] = [];
    const sender = vi.fn(async (_payload, key) => { keys.push(key); return keys.length > 1; });
    await expect(deliverAdminConnectionTest({ ...connection, store, sender })).resolves.toMatchObject({ status: "pending" });
    await expect(deliverAdminConnectionTest({ ...connection, store, sender })).resolves.toMatchObject({ status: "accepted" });
    expect(keys[0]).toBe(keys[1]);
  });

  it("sends one fresh connection test after provider credentials change", async () => {
    const store = new MemoryStore();
    await deliverAdminConnectionTest({ ...connection, store, sender: async () => true });
    const sender = vi.fn(async () => true);
    await expect(deliverAdminConnectionTest({ ...connection, store, sender, transportIdentity: "b".repeat(64) }))
      .resolves.toMatchObject({ status: "accepted", repeated: false });
    await expect(deliverAdminConnectionTest({ ...connection, store, sender, transportIdentity: "b".repeat(64) }))
      .resolves.toMatchObject({ status: "accepted", repeated: true });
    expect(sender).toHaveBeenCalledTimes(1);
  });
});
