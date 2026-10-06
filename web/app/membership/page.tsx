import type { Metadata } from "next";
import Link from "next/link";
import { LAB_FEE, type PackName } from "@/lib/seed";

export const metadata: Metadata = {
  title: "Membership packs",
  description: "Compare LABx membership pack tiers and review the current pack rules."
};

const PACKS: PackName[] = ["Entry", "Bronze", "Silver", "Gold", "Platinum"];

export default function MembershipPage() {
  return (
    <section className="section workflow-page stack">
      <header className="workflow-header stack">
        <p className="kicker">Membership</p>
        <h1 className="page-title">Membership.</h1>
        <p className="lede">Each pack is a membership for one piece. A live listing must publish its price, bonus entries and remaining supply.</p>
      </header>
      <div className="membership-facts">
        <div className="pearl pad"><span>Lab fee per pack</span><strong>+{LAB_FEE} USDC</strong></div>
        <div className="pearl pad"><span>Quantity per purchase</span><strong>1–5 packs</strong></div>
        <div className="pearl pad"><span>Bonus-entry expiry</span><strong>12 months</strong></div>
      </div>
      <section className="well pad stack" aria-labelledby="tiers-title">
        <h2 id="tiers-title">Pack tiers</h2>
        <ol className="tier-list">{PACKS.map((pack) => <li key={pack} data-tier={pack.toLowerCase()}>{pack}</li>)}</ol>
        <p className="muted">Each piece listing sets the price, bonus entries and available supply for every offered tier.</p>
      </section>
      <article className="notice warning stack">
        <strong>No packs are available to purchase on this website.</strong>
        <span>Listings and purchase tools are not connected. Comparing a tier does not reserve a pack or place an order.</span>
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
