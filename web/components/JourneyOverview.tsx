import Link from "next/link";

const journeys = [
  {
    title: "Buy a membership",
    tone: "buyer",
    action: "Compare memberships",
    href: "/membership",
    steps: [
      { title: "Choose", copy: "Check the artwork, membership price, processing fee, supply, bonus entries and closing time." },
      { title: "Confirm", copy: "Read the rules, approve the exact USDC amount and wait for the purchase receipt to confirm." },
      { title: "Follow", copy: "Track the draw. A winner claims the piece; a cancelled raffle returns pack principal. Processing fees are retained." }
    ]
  },
  {
    title: "Run a raffle",
    tone: "seller",
    action: "Open Studio",
    href: "/seller",
    steps: [
      { title: "Prepare", copy: "Validate the NFT, configure the memberships and review the commitment before creating a draft." },
      { title: "Open", copy: "Escrow the NFT and get LABx approval for the prize and draw funding. Then open your reviewed raffle." },
      { title: "Complete", copy: "Close on schedule, snapshot entries, request randomness, reveal the commitment and settle the result." }
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
          <article className={`journey-card journey-card--${journey.tone}`} key={journey.title}>
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
