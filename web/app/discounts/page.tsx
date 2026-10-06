import type { Metadata } from "next";
import Link from "next/link";
import { PartnerPass } from "@/components/PartnerPass";
import { PARTNER_OFFERS } from "@/lib/offers";

export const metadata: Metadata = {
  title: "Partner discounts",
  description: "View the current LABx partner discount offers."
};

export default function DiscountsPage() {
  return (
    <section className="section workflow-page stack">
      <header className="workflow-header stack">
        <p className="kicker">Member benefits</p>
        <h1 className="page-title">Discounts.</h1>
        <p className="lede">A little extra from our partners.</p>
      </header>
      <div className="offer-grid">
        {PARTNER_OFFERS.map((offer) => <PartnerPass key={offer.slug} offer={offer} />)}
      </div>
      <div className="btn-row"><Link className="btn btn-dark" href="/membership">Membership overview</Link><Link className="btn btn-lime" href="/profile">Open profile</Link></div>
    </section>
  );
}
