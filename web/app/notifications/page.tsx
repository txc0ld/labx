import type { Metadata } from "next";
import { NotificationFeed } from "@/components/NotificationFeed";
import { configuredChainId, NETWORKS } from "@/lib/chain/networks";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <section className="section notification-page" aria-labelledby="notifications-title">
      <header className="notification-heading">
        <h1 id="notifications-title" className="page-title">Updates</h1>
        <p className="lede">New drafts and opened raffles, confirmed on {NETWORKS[configuredChainId()].shortName}.</p>
      </header>
      <NotificationFeed />
    </section>
  );
}
