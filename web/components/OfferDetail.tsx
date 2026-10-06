import Link from "next/link";
import { PartnerPass } from "@/components/PartnerPass";
import { DiscountCode } from "@/components/DiscountCode";
import type { PartnerOffer } from "@/lib/offers";

export function OfferDetail({ offer }: { offer: PartnerOffer }) {
  return (
    <section className="section workflow-page stack">
      <div className="detail-path"><Link href="/discounts" className="detail-back"><span aria-hidden="true">←</span> Back to partner discounts</Link></div>
      <header className="workflow-header stack">
        <p className="kicker">Partner discount</p>
        <h1 className="page-title">{offer.partner}</h1>
        <p className="lede">{offer.benefit}</p>
      </header>
      <div className="workflow-grid partner-detail-grid">
        <PartnerPass offer={offer}><DiscountCode /></PartnerPass>
        <article className="well pad stack">
          <h2>Redemption status</h2>
          <p className="notice warning" role="status">Redemption is unavailable. The working code and exact eligibility details are pending.</p>
          <p>Your membership status is unknown until an authoritative membership source is connected.</p>
          <a className="btn" href={offer.website} target="_blank" rel="noreferrer">{offer.websiteLabel} <span aria-hidden="true">↗</span></a>
          <p className="muted">Informational link. The discount is not applied automatically.</p>
        </article>
      </div>
      <div className="btn-row"><Link className="btn btn-dark" href="/membership">Membership overview</Link><Link className="btn btn-lime" href="/profile">Profile</Link></div>
    </section>
  );
}
