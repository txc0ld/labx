import { keccak256, toBytes } from "viem";
import type { Store } from "../points";
import type { MailPayload, MailSender } from "../receipt-delivery";
import type { NotificationEvent } from "./events";

export type { NotificationEvent } from "./events";

export const ADMIN_NOTIFICATION_RECIPIENT = "team@fantomlabs.io";
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1_000;

type DeliveryReservation = {
  version: 1;
  identity: string;
  deployment: string;
  binding: unknown;
  createdAt: number;
  transportIdentity: string;
  payload: MailPayload;
};

export type NotificationDeliveryResult =
  | { status: "accepted"; repeated: boolean; key: string }
  | { status: "pending"; key: string }
  | { status: "reconciliation-required"; reason: ReconciliationReason; key: string };
type ReconciliationReason = "provider-identity-changed" | "payload-configuration-changed" | "retry-window-ended" | "invalid-record";

export async function deliverNotification(args: {
  store: Store;
  event: NotificationEvent;
  deployment: string;
  origin: string;
  sender: MailSender;
  from: string;
  transportIdentity: string;
  now?: number;
  clock?: () => number;
}): Promise<NotificationDeliveryResult> {
  const now = args.now ?? Date.now();
  requireDeliveryConfig(args.from, args.transportIdentity, args.origin, now);
  const identity = `${args.deployment}:${args.event.blockHash}:${args.event.transactionHash}:${args.event.logIndex}:${args.event.eventName}`;
  const key = `raffle-notification:${keccak256(toBytes(identity))}`;
  return deliverReservedMail({
    store: args.store,
    sender: args.sender,
    identity,
    key,
    deployment: args.deployment,
    binding: args.event,
    payload: notificationPayload(args.from, args.origin, args.event),
    transportIdentity: args.transportIdentity,
    clock: args.clock ?? (args.now === undefined ? Date.now : () => now)
  });
}

export async function deliverAdminConnectionTest(args: {
  store: Store;
  deployment: string;
  sender: MailSender;
  from: string;
  transportIdentity: string;
  now?: number;
  clock?: () => number;
}): Promise<NotificationDeliveryResult> {
  const now = args.now ?? Date.now();
  requireMailConfig(args.from, args.transportIdentity, now);
  const payload = connectionTestPayload(args.from);
  const configuration = keccak256(toBytes(JSON.stringify({ version: 2, payload, transportIdentity: args.transportIdentity })));
  const identity = `${args.deployment}:admin-connection-test:v2:${configuration}`;
  return deliverReservedMail({
    store: args.store,
    sender: args.sender,
    identity,
    key: `raffle-notification-test:${keccak256(toBytes(identity))}`,
    deployment: args.deployment,
    binding: { kind: "admin-connection-test", version: 2, configuration },
    payload,
    transportIdentity: args.transportIdentity,
    clock: args.clock ?? (args.now === undefined ? Date.now : () => now)
  });
}

async function deliverReservedMail(args: {
  store: Store;
  sender: MailSender;
  identity: string;
  key: string;
  deployment: string;
  binding: unknown;
  payload: MailPayload;
  transportIdentity: string;
  clock: () => number;
}): Promise<NotificationDeliveryResult> {
  let raw = await args.store.get(args.key);
  if (raw === null) {
    const reservationTime = args.clock();
    requireTimestamp(reservationTime);
    const candidate: DeliveryReservation = {
      version: 1,
      identity: args.identity,
      deployment: args.deployment,
      binding: args.binding,
      createdAt: reservationTime,
      transportIdentity: args.transportIdentity,
      payload: args.payload
    };
    await args.store.setIfAbsent({ [args.key]: JSON.stringify(candidate) });
    raw = await args.store.get(args.key);
  }
  if (raw === null) throw new Error("Notification reservation was not persisted.");
  let reservation: DeliveryReservation;
  try {
    reservation = parseReservation(raw, { identity: args.identity, deployment: args.deployment, binding: args.binding });
  } catch {
    return recordReconciliation(args.store, `${args.key}:reconciliation`, "invalid-record", checkedClock(args.clock), args.key);
  }

  const acceptedKey = `${args.key}:accepted`;
  const accepted = await args.store.get(acceptedKey);
  if (accepted === "accepted") return { status: "accepted", repeated: true, key: args.key };
  if (accepted !== null) throw new Error("Notification acceptance record is invalid.");

  const reconciliationKey = `${args.key}:reconciliation`;
  const existingReconciliation = await args.store.get(reconciliationKey);
  if (existingReconciliation !== null) {
    return { status: "reconciliation-required", reason: parseReconciliation(existingReconciliation), key: args.key };
  }

  if (JSON.stringify(reservation.payload) !== JSON.stringify(args.payload)) {
    return recordReconciliation(args.store, reconciliationKey, "payload-configuration-changed", checkedClock(args.clock), args.key);
  }

  const sendTime = checkedClock(args.clock);
  const reason = reconciliationReason(reservation, args.transportIdentity, sendTime);
  if (reason) {
    return recordReconciliation(args.store, reconciliationKey, reason, sendTime, args.key);
  }

  let acknowledged = false;
  try {
    acknowledged = await args.sender(reservation.payload, args.key);
  } catch {
    return { status: "pending", key: args.key };
  }
  if (!acknowledged) return { status: "pending", key: args.key };
  const reconciliationAfterSend = await args.store.get(reconciliationKey);
  if (reconciliationAfterSend !== null) {
    return { status: "reconciliation-required", reason: parseReconciliation(reconciliationAfterSend), key: args.key };
  }
  const firstAcceptance = await args.store.setIfAbsent({ [acceptedKey]: "accepted" });
  if (await args.store.get(acceptedKey) !== "accepted") throw new Error("Notification acceptance was not persisted.");
  return { status: "accepted", repeated: !firstAcceptance, key: args.key };
}

async function recordReconciliation(
  store: Store,
  reconciliationKey: string,
  reason: ReconciliationReason,
  recordedAt: number,
  key: string
): Promise<NotificationDeliveryResult> {
  const marker = JSON.stringify({ version: 1, reason, recordedAt });
  await store.setIfAbsent({ [reconciliationKey]: marker });
  const persisted = await store.get(reconciliationKey);
  if (persisted === null) throw new Error("Notification reconciliation record was not persisted.");
  return { status: "reconciliation-required", reason: parseReconciliation(persisted), key };
}

function requireDeliveryConfig(from: string, transportIdentity: string, origin: string, now: number): void {
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error("Notification delivery configuration is invalid.");
  }
  requireMailConfig(from, transportIdentity, now);
  if (
    parsedOrigin.origin !== origin
    || (parsedOrigin.protocol !== "https:" && parsedOrigin.hostname !== "localhost")
  ) throw new Error("Notification delivery configuration is invalid.");
}

function requireMailConfig(from: string, transportIdentity: string, now: number): void {
  if (
    !from || /[\r\n]/.test(from)
    || !/^[0-9a-f]{64}$/.test(transportIdentity)
    || !Number.isSafeInteger(now) || now < 0
  ) throw new Error("Notification delivery configuration is invalid.");
}

function notificationPayload(from: string, origin: string, event: NotificationEvent): MailPayload {
  const link = new URL(event.href, origin).href;
  const subject = `[LABx] ${event.label}: Raffle #${event.raffleId}`;
  const text = [
    event.label,
    `Raffle #${event.raffleId}`,
    `Recorded on Sepolia at ${event.occurredAt}.`,
    link
  ].join("\n");
  const anchor = ["<a", `href=${JSON.stringify(link)}`, ">View raffle</a>"].join(" ");
  const html = `<p><strong>${event.label}</strong></p><p>Raffle #${event.raffleId}</p><p>Recorded on Sepolia at ${event.occurredAt}.</p><p>${anchor}</p>`;
  return { from, to: ADMIN_NOTIFICATION_RECIPIENT, subject, text, html };
}

function connectionTestPayload(from: string): MailPayload {
  const subject = "LABx admin alert connection test";
  const text = "This is a LABx admin alert configuration test. It does not report raffle activity.";
  const html = "<p>This is a LABx admin alert configuration test. It does not report raffle activity.</p>";
  return { from, to: ADMIN_NOTIFICATION_RECIPIENT, subject, text, html };
}

function parseReservation(
  raw: string,
  expected: { identity: string; deployment: string; binding: unknown }
): DeliveryReservation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Notification delivery record is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Notification delivery record is invalid.");
  const version = Reflect.get(value, "version");
  const identity = Reflect.get(value, "identity");
  const deployment = Reflect.get(value, "deployment");
  const binding = Reflect.get(value, "binding");
  const createdAt = Reflect.get(value, "createdAt");
  const transportIdentity = Reflect.get(value, "transportIdentity");
  const payload = Reflect.get(value, "payload");
  if (
    version !== 1 || identity !== expected.identity || deployment !== expected.deployment
    || !Number.isSafeInteger(createdAt) || createdAt < 0
    || typeof transportIdentity !== "string" || !/^[0-9a-f]{64}$/.test(transportIdentity)
    || JSON.stringify(binding) !== JSON.stringify(expected.binding)
    || !isMailPayload(payload)
  ) throw new Error("Notification delivery record is invalid.");
  return {
    version,
    identity,
    deployment,
    binding,
    createdAt,
    transportIdentity,
    payload
  };
}

function reconciliationReason(
  reservation: DeliveryReservation,
  transportIdentity: string,
  now: number
): ReconciliationReason | null {
  if (reservation.transportIdentity !== transportIdentity) return "provider-identity-changed";
  if (now < reservation.createdAt || now - reservation.createdAt >= RETRY_WINDOW_MS) return "retry-window-ended";
  return null;
}

function parseReconciliation(raw: string): ReconciliationReason {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Notification reconciliation record is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.get(value, "version") !== 1) {
    throw new Error("Notification reconciliation record is invalid.");
  }
  const reason = Reflect.get(value, "reason");
  const recordedAt = Reflect.get(value, "recordedAt");
  if (
    (reason !== "provider-identity-changed" && reason !== "payload-configuration-changed" && reason !== "retry-window-ended" && reason !== "invalid-record")
    || !Number.isSafeInteger(recordedAt) || recordedAt < 0
  ) throw new Error("Notification reconciliation record is invalid.");
  return reason;
}

function isMailPayload(value: unknown): value is MailPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof Reflect.get(value, "from") === "string"
    && Reflect.get(value, "to") === ADMIN_NOTIFICATION_RECIPIENT
    && typeof Reflect.get(value, "subject") === "string"
    && typeof Reflect.get(value, "text") === "string"
    && typeof Reflect.get(value, "html") === "string";
}

function checkedClock(clock: () => number): number {
  const value = clock();
  requireTimestamp(value);
  return value;
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Notification delivery configuration is invalid.");
}
