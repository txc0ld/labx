import type { Metadata } from "next";
import Link from "next/link";
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
        <p className="lede">Two partner offers are documented below. Check each offer for its current redemption status.</p>
      </header>
      <div className="offer-grid">
        {PARTNER_OFFERS.map((offer, index) => (
          <article className={`${index === 0 ? "pearl" : "well"} pad stack offer-card`} key={offer.slug}>
            <p className="kicker">{offer.partner}</p>
            <strong className="offer-percent">5%</strong>
            <h2>{offer.slug === "fantom-labs" ? "Any Fantom Labs service" : "SeatMap Pro membership"}</h2>
            <p className="muted">Working code and exact eligibility pending.</p>
            <Link className="btn" href={`/discounts/${offer.slug}`}>View offer details</Link>
          </article>
        ))}
      </div>
      <div className="btn-row"><Link className="btn btn-dark" href="/membership">Membership overview</Link><Link className="btn btn-lime" href="/profile">Open profile</Link></div>
    </section>
  );
}
