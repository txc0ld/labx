import { describe, expect, it } from "vitest";
import {
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

    expect(reconcileNotificationRead(older, newer)).toEqual({ latest: newer, unread: false });
  });

  it("preserves unread when the feed marks activity older than the bell snapshot", () => {
    const older = activity("older", "100", 9);
    const newer = activity("newer", "101", 0);

    expect(reconcileNotificationRead(newer, older)).toEqual({ latest: newer, unread: true });
  });

  it("orders same-block activity by canonical log index", () => {
    const older = activity("older", "101", 2);
    const newer = activity("newer", "101", 3);

    expect(reconcileNotificationRead(older, newer)).toEqual({ latest: newer, unread: false });
    expect(reconcileNotificationRead(newer, older)).toEqual({ latest: newer, unread: true });
  });

  it("does not let an older fetch response replace a newer local read", () => {
    const older = activity("older", "100", 9);
    const newer = activity("newer", "101", 0);

    expect(selectLatestActivity(newer, older)).toBe(newer);
  });

  it("ignores read events from another deployment", () => {
    const latest = activity("latest", "101", 0);
    const other = { ...activity("other", "102", 0), deployment: "11155111:0xdef" };

    expect(reconcileNotificationRead(latest, other)).toBeNull();
  });
});
