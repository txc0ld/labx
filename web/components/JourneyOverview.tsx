import Link from "next/link";
import React from "react";
import { SELLER_FEE_BPS } from "@/lib/chain/fees";

const journeys = [
  {
    id: "buying",
    title: "Buy a membership",
    tone: "buyer",
    action: "Compare memberships",
    href: "/membership",
    steps: [
      { title: "Choose", copy: "Check the artwork, membership price, processing fee, supply, bonus entries and closing time." },
      { title: "Confirm", copy: "Read the rules, approve the exact USDC amount and wait for the purchase receipt to confirm." },
      { title: "Follow", copy: "Track the draw. A winner claims the piece. If a raffle is cancelled, you get the membership price back; the processing fee is not refunded." }
    ]
  },
  {
    id: "selling",
    title: "How selling works",
    tone: "seller",
    action: "Open Studio",
    href: "/seller",
    steps: [
      { title: "Create", copy: "Pick your NFT, set tier prices and press Create. Your wallet asks for 1 signature and up to 3 confirmations, then your NFT is locked." },
      { title: "LABx review", copy: "LABx checks the NFT and the draw funding. Editing a draft sends it back for review." },
      { title: "List", copy: "Press List to open sales. Prices and fees are fixed from then on." },
      { title: "Draw", copy: "After sales end, the draw runs. When a winner is drawn, confirm the draw." },
      { title: "Claim", copy: `When the raffle finishes, claim your sales after the ${SELLER_FEE_BPS / 100}% seller fee. If a raffle is cancelled, reclaim your NFT.` }
    ]
  }
] as const;

export function JourneyOverview() {
  return (
    <section className="journey-overview" aria-labelledby="journey-title">
      <header className="journey-heading">
        <div>
          <p className="kicker">Buyer and seller paths</p>
          <h2 id="journey-title">From membership to outcome.</h2>
        </div>
        <p>These website actions remain unavailable until the verified contract connection is complete.</p>
      </header>
      <div className="journey-grid">
        {journeys.map((journey) => (
          <article className={`journey-card journey-card--${journey.tone}`} key={journey.title} id={journey.id} style={{ scrollMarginTop: "8rem" }}>
            <h3>{journey.title}</h3>
            <ol>
              {journey.steps.map((step, index) => (
                <li key={step.title}>
                  <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <div><strong>{step.title}</strong><p>{step.copy}</p></div>
                </li>
              ))}
            </ol>
            <Link className="btn" href={journey.href}>{journey.action}</Link>
          </article>
        ))}
      </div>
    </section>
  );
}
