import type { Metadata } from "next";
import Link from "next/link";
import { BUYER_FEE_BPS } from "@/lib/chain/fees";
import { STANDARD_MEMBERSHIP_TIERS } from "@/lib/membership-tiers";

export const metadata: Metadata = {
  title: "Membership packs",
  description: "Compare LABx membership pack tiers and review the current pack rules."
};

export default function MembershipPage() {
  return (
    <section className="section workflow-page stack">
      <header className="workflow-header stack">
        <h1 className="page-title">Membership.</h1>
        <p className="lede">Choose a pack. Get your membership and its bonus entries.</p>
      </header>
      <div className="membership-facts">
        <div className="pearl pad"><span>Processing fee per purchase</span><strong>{BUYER_FEE_BPS / 100}%<span className="fee-minimum">2.50 USDC minimum</span></strong></div>
        <div className="pearl pad"><span>Quantity per purchase</span><strong>1–20 packs</strong></div>
        <div className="pearl pad"><span>Bonus-entry expiry</span><strong>12 months</strong></div>
      </div>
      <section className="well pad stack" aria-labelledby="tiers-title">
        <h2 id="tiers-title">Pack tiers</h2>
        <ol className="tier-list">{STANDARD_MEMBERSHIP_TIERS.map((pack) => <li key={pack} data-tier={pack.toLowerCase()}><span>{pack}</span><span className="tier-orbs" aria-hidden="true" /></li>)}</ol>
        <p className="muted">New LABx raffles use these five standard membership names in this order. Each raffle sets its own prices, bonus entries and supply. Existing raffles keep the membership packs already published on-chain.</p>
      </section>
      <article className="notice warning stack">
        <strong>Review your total before purchasing.</strong>
        <span>The new contract uses the greater of 2.50 USDC or 2% of your pack subtotal. Processing fees are not refunded if a raffle is cancelled. Pack prices and purchase controls appear on open raffles; this comparison does not place an order.</span>
      </article>
      <div className="btn-row">
        <Link className="btn" href="/">Explore pieces</Link>
        <Link className="btn btn-dark" href="/discounts">Partner discounts</Link>
        <Link className="btn btn-lime" href="/eligibility">Review eligibility</Link>
        <Link className="btn btn-pink" href="/legal">Membership terms</Link>
      </div>
    </section>
  );
}
