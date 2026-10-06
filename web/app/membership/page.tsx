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
        <h1 className="page-title">Membership.</h1>
        <p className="lede">Each pack is a membership for one piece. A live listing must publish its price, bonus entries and remaining supply.</p>
      </header>
      <div className="membership-facts">
        <div className="pearl pad"><span>Lab fee per pack</span><strong>+{LAB_FEE} USDC</strong></div>
        <div className="pearl pad"><span>Quantity per transaction</span><strong>1–20 packs</strong></div>
        <div className="pearl pad"><span>Bonus-entry expiry</span><strong>12 months</strong></div>
      </div>
      <section className="well pad stack" aria-labelledby="tiers-title">
        <h2 id="tiers-title">Pack tiers</h2>
        <ol className="tier-list">{PACKS.map((pack) => <li key={pack} data-tier={pack.toLowerCase()}>{pack}</li>)}</ol>
        <p className="muted">These are LABx’s visual tiers. A verified raffle can publish up to eight custom membership names, prices, bonus entries and supply limits.</p>
      </section>
      <article className="notice warning stack">
        <strong>Check the verified raffle before purchasing.</strong>
        <span>Membership controls appear only for an open raffle on a reviewed v2 deployment. This comparison does not reserve a pack or place an order.</span>
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
