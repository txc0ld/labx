import type { Metadata } from "next";
import Link from "next/link";
import { JourneyOverview } from "@/components/JourneyOverview";
import { BUYER_FEE_BPS, SELLER_FEE_BPS } from "@/lib/chain/fees";

export const metadata: Metadata = {
  title: "How LABx works",
  description: "A guide to LABx membership packs, eligibility, and the intended draw workflow."
};

export default function GuidePage() {
  return (
    <section className="section guide-page">
      <header className="guide-header">
        <h1 className="page-title">How it works.</h1>
        <p className="guide-intro">Find a piece. Choose a pack. Follow the draw.</p>
        <p className="guide-availability"><span>Sepolia test network</span>Every listing and action requires an approved deployment.</p>
      </header>

      <div className="guide-grid">
        <article className="guide-section guide-browse" id="browse">
          <div className="guide-step-label"><span className="guide-step-number">01</span><p className="kicker">Browse</p></div>
          <h2>Find your piece.</h2>
          <p>Check the artwork and the details before choosing.</p>
          <ul className="guide-checklist">
            <li>Status &amp; closing date</li>
            <li>Pack prices &amp; availability</li>
          </ul>
          <details className="guide-details">
            <summary>Browsing details</summary>
            <p>The collection reads verified contract records. Open a raffle to see its status, deadline, membership prices and remaining supply.</p>
          </details>
          <Link className="guide-action" href="/#bench">View the collection <span aria-hidden="true">↗</span></Link>
        </article>

        <article className="guide-section guide-packs" id="packs">
          <div className="guide-step-label"><span className="guide-step-number">02</span><p className="kicker">Packs</p></div>
          <h2>Pick your pack.</h2>
          <p>Compare the USDC price, bonus entries and remaining supply.</p>
          <dl className="guide-facts">
            <div><dt>Purchase fee</dt><dd>+{BUYER_FEE_BPS / 100}<small>%</small></dd></div>
            <div><dt>Quantity</dt><dd>Live <small>contract limit</small></dd></div>
          </dl>
          <details className="guide-details">
            <summary>Pricing details</summary>
            <p>The new contract version adds a {BUYER_FEE_BPS / 100}% fee to the membership subtotal. The contract validates quantity and remaining supply again before the wallet request. Each purchase fee rounds down to the nearest 0.000001 USDC.</p>
            <p>If a raffle is cancelled, you can claim the membership price and the purchase fee you paid. Historical contracts keep their original fees.</p>
          </details>
          <Link className="guide-action" href="/fairness">Read about fairness <span aria-hidden="true">↗</span></Link>
        </article>

        <article className="guide-section guide-eligibility" id="eligibility">
          <div className="guide-step-label"><span className="guide-step-number">03</span><p className="kicker">Eligibility</p></div>
          <h2>Check you’re set.</h2>
          <p>Confirm eligibility and read the terms before purchasing.</p>
          <dl className="guide-facts">
            <div><dt>Minimum age</dt><dd>18<small>+</small></dd></div>
            <div><dt>Bonus-entry expiry</dt><dd>12 <small>months</small></dd></div>
          </dl>
          <details className="guide-details">
            <summary>What you agree to</summary>
            <p>The intended purchase flow requires agreement to the membership terms, draw rules and 12-month bonus-entry expiry. You must confirm you are eligible and at least 18.</p>
          </details>
          <div className="guide-links"><Link href="/legal">Membership terms</Link><Link href="/rules">Draw rules</Link></div>
        </article>
      </div>

      <JourneyOverview />

      <section className="guide-workflow" id="workflow" aria-labelledby="workflow-title">
        <div className="guide-workflow-heading">
          <div><p className="kicker">Behind the draw</p><h2 id="workflow-title">What happens next?</h2></div>
          <span className="guide-flow-label">Verified contract workflow</span>
        </div>
        <ol className="guide-timeline">
          <li><span className="guide-node" aria-hidden="true">01</span><h3>Prepare</h3><p>NFT escrow + private commitment.</p></li>
          <li><span className="guide-node" aria-hidden="true">02</span><h3>Close</h3><p>Sales end. Eligible entries form a snapshot.</p></li>
          <li><span className="guide-node" aria-hidden="true">03</span><h3>Draw</h3><p>Chainlink VRF supplies randomness.</p></li>
          <li><span className="guide-node" aria-hidden="true">04</span><h3>Settle</h3><p>Reveal the commitment. Enable separate claims.</p></li>
        </ol>
        <details className="guide-details guide-workflow-details">
          <summary>Settlement &amp; website availability</summary>
          <div className="guide-detail-body">
            <p>Studio prepares the piece, escrow and private commitment before packs open. After the draw and reveal, settlement enables separate prize, proceeds and fee claims. The new contract version deducts a {SELLER_FEE_BPS / 100}% seller fee from total membership revenue at settlement, rounded down to the nearest 0.000001 USDC. This is separate from the buyer’s purchase fee. No seller fee applies to a cancelled raffle.</p>
            <p>The website enables each step only when an approved deployment, the connected wallet and current contract phase allow it. A transaction is complete only after confirmation.</p>
            <div className="guide-links"><Link href="/seller">Open Studio</Link><Link href="/profile">View profile</Link><Link href="/fairness">Inspect fairness</Link></div>
          </div>
        </details>
      </section>
    </section>
  );
}
