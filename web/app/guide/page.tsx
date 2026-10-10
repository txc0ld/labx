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
            <p>The collection reads on-chain raffle records. Open a raffle to see its status, deadline, membership prices and remaining supply.</p>
          </details>
          <Link className="guide-action" href="/#bench">View the collection <span aria-hidden="true">↗</span></Link>
        </article>

        <article className="guide-section guide-packs" id="packs">
          <div className="guide-step-label"><span className="guide-step-number">02</span><p className="kicker">Packs</p></div>
          <h2>Pick your pack.</h2>
          <p>Compare the USDC price, bonus entries and remaining supply.</p>
          <dl className="guide-facts">
            <div><dt>Processing fee</dt><dd>{BUYER_FEE_BPS / 100}<small>%</small><span className="fee-minimum">2.50 USDC minimum</span></dd></div>
            <div><dt>Quantity</dt><dd>Live <small>contract limit</small></dd></div>
          </dl>
          <details className="guide-details">
            <summary>Pricing details</summary>
            <p>Each purchase adds the greater of 2.50 USDC or {BUYER_FEE_BPS / 100}% of the pack subtotal. The minimum applies once per purchase call, after multiplying the pack price by quantity. The percentage rounds down to 0.000001 USDC. Separate purchases each have their own minimum. The contract validates quantity and remaining supply before accepting a purchase.</p>
            <p>If a raffle is cancelled, you can claim the pack price. The processing fee is not refunded, including after a draw timeout. ETH-funded purchases also receive principal refunds in USDC. Historical contracts keep their original rules.</p>
            <p>Points are separate from memberships and bonus entries. They don’t give you an entry.</p>
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
          <span className="guide-flow-label">Raffle workflow</span>
        </div>
        <ol className="guide-timeline">
          <li><span className="guide-node" aria-hidden="true">01</span><h3>Prepare</h3><p>The NFT is locked, the draw setup is saved and LABx reviews the raffle.</p></li>
          <li><span className="guide-node" aria-hidden="true">02</span><h3>Close</h3><p>Sales end. Eligible entries are counted.</p></li>
          <li><span className="guide-node" aria-hidden="true">03</span><h3>Draw</h3><p>Chainlink VRF supplies randomness.</p></li>
          <li><span className="guide-node" aria-hidden="true">04</span><h3>Finish</h3><p>The seller confirms the draw. Claims open.</p></li>
        </ol>
        <details className="guide-details guide-workflow-details">
          <summary>Settlement &amp; website availability</summary>
          <div className="guide-detail-body">
            <p>When a seller presses Create, Studio saves the private draw setup after the seller signs in their wallet. LABx checks the exact NFT and draw funding before the seller can list. Editing a draft sends it back for review. After the draw is confirmed and the raffle is finished, the winner, the seller and LABx each claim separately. A {SELLER_FEE_BPS / 100}% seller fee comes off total membership sales when the raffle finishes, rounded down to the nearest 0.000001 USDC. It is separate from the buyer’s processing fee. No seller fee applies to a cancelled raffle.</p>
            <p>The website enables each step only when an approved deployment, the connected wallet and current contract phase allow it. A transaction is complete only after confirmation.</p>
            <div className="guide-links"><Link href="/seller">Open Studio</Link><Link href="/profile">View profile</Link><Link href="/fairness">Inspect fairness</Link></div>
          </div>
        </details>
      </section>
    </section>
  );
}
