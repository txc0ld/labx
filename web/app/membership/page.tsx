import type { Metadata } from "next";
import Link from "next/link";
import type { PackName } from "@/lib/seed";
import { BUYER_FEE_BPS } from "@/lib/chain/fees";

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
        <p className="lede">Choose a pack. Get your membership and its bonus entries.</p>
      </header>
      <div className="membership-facts">
        <div className="pearl pad"><span>Purchase fee</span><strong>+{BUYER_FEE_BPS / 100}%</strong></div>
        <div className="pearl pad"><span>Quantity per transaction</span><strong>1–20 packs</strong></div>
        <div className="pearl pad"><span>Bonus-entry expiry</span><strong>12 months</strong></div>
      </div>
      <section className="well pad stack" aria-labelledby="tiers-title">
        <h2 id="tiers-title">Pack tiers</h2>
        <ol className="tier-list">{PACKS.map((pack) => <li key={pack} data-tier={pack.toLowerCase()}><span>{pack}</span><span className="tier-orbs" aria-hidden="true" /></li>)}</ol>
        <p className="muted">These are LABx’s visual tiers. A verified raffle can publish up to eight custom membership names, prices, bonus entries and supply limits.</p>
      </section>
      <article className="notice warning stack">
        <strong>Check the verified raffle before purchasing.</strong>
        <span>The percentage fee applies to the new contract version. Membership controls appear only for an open raffle on an approved deployment. This comparison does not reserve a pack or place an order.</span>
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
