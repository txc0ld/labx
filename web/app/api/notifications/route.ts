import { createNotificationsHandler } from "@/lib/notifications/http";
import { readRecentNotificationsCached } from "@/lib/notifications/public-feed";

export const dynamic = "force-dynamic";

export const GET = createNotificationsHandler({ read: readRecentNotificationsCached });
