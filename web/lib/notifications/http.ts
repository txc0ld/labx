import { createHash, timingSafeEqual } from "node:crypto";
import type { Store } from "../points";
import type { MailSender } from "../receipt-delivery";
import { ADMIN_NOTIFICATION_RECIPIENT, deliverAdminConnectionTest } from "./delivery";
import { processNotifications, type NotificationProcessorSource } from "./processor";
import { parsePublicCursor, type PublicNotificationPage } from "./public-feed";

export function createNotificationsHandler(dependencies: {
  read: (args: { cursor?: string; limit?: number }) => Promise<PublicNotificationPage>;
}) {
  return async function GET(request: Request): Promise<Response> {
    const search = new URL(request.url).searchParams;
    const cursor = search.get("cursor") ?? undefined;
    const limitRaw = search.get("limit");
    try {
      if (cursor !== undefined) parsePublicCursor(cursor);
      if (limitRaw !== null && !/^[1-9]\d?$/.test(limitRaw)) throw new Error("Invalid page size.");
    } catch {
      return Response.json({ ok: false, error: "Notification pagination is invalid." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && limit > 50) {
      return Response.json({ ok: false, error: "Notification pagination is invalid." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    try {
      const page = await dependencies.read({ cursor, limit });
      return Response.json(
        { ok: true, ...page },
        { headers: { "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=60" } }
      );
    } catch {
      return Response.json(
        { ok: false, kind: "unavailable", items: [], range: null, fresh: false, error: "Finalized raffle activity is temporarily unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
  };
}

type CronDependencies = {
  store: () => Store;
  source: () => Promise<NotificationProcessorSource>;
  sender: (apiKey: string) => MailSender;
};

export function createNotificationCronHandler(dependencies: CronDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const configuration = cronConfiguration(request);
    if (configuration instanceof Response) return configuration;

    try {
      const source = await within(dependencies.source(), 12_000);
      const transportIdentity = createHash("sha256").update(configuration.apiKey).digest("hex");
      const report = await processNotifications({
        store: dependencies.store(),
        source,
        sender: dependencies.sender(configuration.apiKey),
        from: configuration.from,
        transportIdentity
      });
      const ok = report.status !== "degraded" && report.status !== "reconciliation-required";
      console.info("notification-cron", {
        status: report.status,
        ingestedPages: report.ingestedPages,
        ingestedEvents: report.ingestedEvents,
        checkedEvents: report.checkedEvents,
        sends: report.sends,
        accepted: report.accepted,
        pending: report.pending,
        reconciliationRequired: report.reconciliationRequired,
        ingestion: report.ingestion,
        ingestionNextBlock: report.ingestionNextBlock,
        retryNextBlock: report.retryNextBlock,
        lastIncident: report.lastIncident
      });
      return Response.json({ ok, ...report }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return cronError("Notification processing did not complete.", 503);
    }
  };
}

export function createNotificationConnectionTestHandler(dependencies: CronDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const configuration = cronConfiguration(request);
    if (configuration instanceof Response) return configuration;
    let body: string;
    try { body = await request.text(); } catch { return cronError("Connection test request is invalid.", 400); }
    if (body.length !== 0) return cronError("Connection test does not accept a request body.", 400);
    try {
      const source = await within(dependencies.source(), 12_000);
      const result = await deliverAdminConnectionTest({
        store: dependencies.store(),
        deployment: source.deployment,
        sender: dependencies.sender(configuration.apiKey),
        from: configuration.from,
        transportIdentity: createHash("sha256").update(configuration.apiKey).digest("hex")
      });
      return Response.json(
        { ok: result.status !== "reconciliation-required", status: result.status, providerAccepted: result.status === "accepted", repeated: result.status === "accepted" ? result.repeated : false },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch {
      return cronError("Notification connection test did not complete.", 503);
    }
  };
}

function cronConfiguration(request: Request): { apiKey: string; from: string } | Response {
  const secret = process.env.CRON_SECRET;
  if (!secret) return cronError("Notification cron is not configured.", 503);
  if (!validBearer(request.headers.get("authorization"), secret)) return cronError("Notification cron authorization failed.", 401);
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from || process.env.LABX_ADMIN_EMAIL !== ADMIN_NOTIFICATION_RECIPIENT) {
    return cronError("Notification delivery is not configured.", 503);
  }
  return { apiKey, from };
}

function validBearer(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ") || expected.length < 16) return false;
  const supplied = header.slice(7);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cronError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });
}

async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Notification source timed out.")), milliseconds); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
