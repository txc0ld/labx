import { describe, expect, it } from "vitest";
import {
  advanceWatermark,
  isNotificationUnread,
  reconcileNotificationRead,
  selectLatestActivity,
  type NotificationActivity
} from "@/components/NotificationsBell";

const activity = (identity: string, blockNumber: string, logIndex: number): NotificationActivity => ({
  deployment: "11155111:0xabc",
  identity,
  blockNumber,
  logIndex
});

describe("notification unread ordering", () => {
  it("clears unread when the feed marks activity newer than the bell snapshot", () => {
    const older = activity("older", "100", 9);
    const newer = activity("newer", "101", 0);

    expect(reconcileNotificationRead(older, { kind: "ordered", activity: older }, newer)).toEqual({
      latest: newer,
      watermark: { kind: "ordered", activity: newer },
      unread: false
    });
  });

  it("preserves unread when the feed marks activity older than the bell snapshot", () => {
    const older = activity("older", "100", 9);
    const newer = activity("newer", "101", 0);

    expect(reconcileNotificationRead(newer, { kind: "ordered", activity: older }, older)).toEqual({
      latest: newer,
      watermark: { kind: "ordered", activity: older },
      unread: true
    });
  });

  it("orders same-block activity by canonical log index", () => {
    const older = activity("older", "101", 2);
    const newer = activity("newer", "101", 3);

    expect(reconcileNotificationRead(older, { kind: "ordered", activity: older }, newer)?.unread).toBe(false);
    expect(reconcileNotificationRead(newer, { kind: "ordered", activity: older }, older)?.unread).toBe(true);
  });

  it("does not let an older fetch response replace a newer local read", () => {
    const older = activity("older", "100", 9);
    const newer = activity("newer", "101", 0);

    expect(selectLatestActivity(newer, older)).toBe(newer);
  });

  it("ignores read events from another deployment", () => {
    const latest = activity("latest", "101", 0);
    const other = { ...activity("other", "102", 0), deployment: "11155111:0xdef" };

    expect(reconcileNotificationRead(latest, { kind: "ordered", activity: latest }, other)).toBeNull();
  });

  it("keeps a newer durable read watermark when a stale tab marks older activity", () => {
    const older = activity("older", "100", 9);
    const newer = activity("newer", "101", 0);
    const storedNewer = advanceWatermark(null, newer, false);

    const afterStaleWrite = advanceWatermark(storedNewer, older, false);
    const reconciled = reconcileNotificationRead(newer, afterStaleWrite, older);

    expect(afterStaleWrite).toBe(storedNewer);
    expect(reconciled).toEqual({ latest: newer, watermark: storedNewer, unread: false });
    expect(isNotificationUnread(newer, storedNewer)).toBe(false);
  });

  it("uses a legacy identity watermark without letting a stale read revive that activity", () => {
    const older = activity("older", "100", 9);
    const newer = activity("newer", "101", 0);
    const legacy = { kind: "legacy" as const, identity: newer.identity };

    const reconciled = reconcileNotificationRead(newer, legacy, older);

    expect(reconciled).toEqual({
      latest: newer,
      watermark: { kind: "ordered", activity: newer },
      unread: false
    });
  });

  it("keeps equal-position identities distinct", () => {
    const first = activity("first-canonical", "101", 3);
    const replacement = activity("replacement-canonical", "101", 3);

    expect(isNotificationUnread(replacement, { kind: "ordered", activity: first })).toBe(true);
  });
});
