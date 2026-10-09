import { createNotificationConnectionTestHandler, createNotificationCronHandler } from "@/lib/notifications/http";
import { notificationProcessorSource } from "@/lib/notifications/processor";
import { resendSender } from "@/lib/receipt-delivery";
import { activeStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const dependencies = { store: activeStore, source: notificationProcessorSource, sender: resendSender };

export const GET = createNotificationCronHandler(dependencies);
export const POST = createNotificationConnectionTestHandler(dependencies);
