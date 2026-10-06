import type { Metadata } from "next";
import Link from "next/link";
import { LAB_FEE } from "@/lib/seed";

export const metadata: Metadata = {
  title: "How LABx works",
  description: "A guide to LABx membership packs, eligibility, and the intended draw workflow."
};

export default function GuidePage() {
  return (
    <section className="section guide-page">
      <header className="guide-header">
        <p className="kicker">Guide</p>
        <h1 className="page-title">How LABx works.</h1>
        <p className="lede">Website listing, purchase and history tools are not connected yet. This guide describes the intended Sepolia contract flow.</p>
      </header>

      <nav className="guide-toc" aria-label="Guide sections">
        <a href="#browse">Browse</a>
        <a href="#packs">Packs</a>
        <a href="#eligibility">Eligibility</a>
        <a href="#workflow">Draw workflow</a>
      </nav>

      <div className="guide-grid">
        <article className="guide-section" id="browse">
          <p className="kicker">Browse</p>
          <h2>Find a piece.</h2>
          <p>When listings are connected, you will be able to filter the collection by pack availability, then open a piece to see its status, closing date, pack prices and remaining supply.</p>
          <Link href="/#bench">View the collection</Link>
        </article>

        <article className="guide-section" id="packs">
          <p className="kicker">Packs</p>
          <h2>Choose a pack.</h2>
          <p>Each membership pack publishes a USDC price, its bonus-entry count and remaining supply. A {LAB_FEE} USDC lab fee is added to the price of each pack. Quantity is limited to 1–5 packs and cannot exceed the selected pack’s remaining supply.</p>
          <Link href="/fairness">Read about fairness</Link>
        </article>

        <article className="guide-section" id="eligibility">
          <p className="kicker">Eligibility</p>
          <h2>Confirm before recording.</h2>
          <p>The intended purchase flow requires agreement to the membership terms, the draw rules and the 12-month bonus-entry expiry, plus confirmation that you are eligible and at least 18.</p>
          <div className="guide-links"><Link href="/legal">Membership terms</Link><Link href="/rules">Draw rules</Link></div>
        </article>

        <article className="guide-section" id="workflow">
          <p className="kicker">Intended workflow</p>
          <h2>From Studio to settlement.</h2>
          <p>In the intended contract workflow, Studio prepares a piece, escrow and a private commitment before packs open. After sales close, eligible entries form a snapshot, Chainlink VRF supplies randomness, the commitment can be revealed, and settlement enables separate prize, proceeds and fee claims.</p>
          <p>The website does not currently create listings, accept purchases, request signatures, or submit these actions on-chain.</p>
          <div className="guide-links"><Link href="/seller">Open Studio</Link><Link href="/profile">View profile</Link><Link href="/fairness">Inspect fairness</Link></div>
        </article>
      </div>
    </section>
  );
}
