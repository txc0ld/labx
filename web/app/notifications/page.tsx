import type { Metadata } from "next";
import { NotificationFeed } from "@/components/NotificationFeed";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <section className="section notification-page" aria-labelledby="notifications-title">
      <header className="notification-heading">
        <p className="kicker">Raffle activity</p>
        <h1 id="notifications-title" className="page-title">Notifications</h1>
        <p className="lede">Finalized draft and sales-open events from the reviewed LABx deployment.</p>
      </header>
      <NotificationFeed />
    </section>
  );
}
