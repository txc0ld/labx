import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import type { PartnerOffer } from "@/lib/offers";

export function PartnerPass({ offer, children }: { offer: PartnerOffer; children?: ReactNode }) {
  if (offer.slug === "fantom-labs") {
    const artwork = <Image src="/partners/fantom-labs-violet.png" alt="Fantom Labs" width={908} height={256} unoptimized />;
    const card = (
      <article className="partner-pass partner-pass--fantom-labs">
        {children ? artwork : <Link href="/discounts/fantom-labs" aria-label="View Fantom Labs discount">{artwork}</Link>}
      </article>
    );
    return children ? <div className="stack">{card}{children}</div> : card;
  }

  return (
    <article className={`partner-pass partner-pass--${offer.slug}`}>
      <div className="partner-pass-face">
        <div className="partner-pass-brand">
          <span className="partner-wordmark"><span className="seatmap-mark" aria-hidden="true" />SeatMap<span className="seatmap-brand-dot">.</span></span>
          <span className="partner-pass-tag">Pro perk</span>
        </div>
        <div className="partner-pass-art" aria-hidden="true">
          <div className="seatmap-cabin">
            {Array.from({ length: 16 }, (_, index) => <span key={index} className={index === 5 || index === 10 ? "seatmap-seat is-highlighted" : "seatmap-seat"} />)}
          </div>
        </div>
        <div className="partner-pass-value"><strong>5<span>%</span></strong><span className="partner-pass-off">off</span></div>
        <h2>Pro membership.</h2>
        <p className="partner-pass-scope">SeatMap Pro</p>
      </div>
      <div className="partner-pass-footer">
        {children || <>
          <p>Redemption details coming soon.</p>
          <Link className="partner-pass-link" href={`/discounts/${offer.slug}`}>Explore offer <span aria-hidden="true">↗</span><span className="sr"> from {offer.partner}</span></Link>
        </>}
      </div>
    </article>
  );
}
