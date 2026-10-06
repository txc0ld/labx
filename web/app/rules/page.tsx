import Link from "next/link";
import { LegalNav } from "@/components/LegalNav";
import { OnChainStatus } from "@/components/OnChainStatus";

export default function RulesPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">How a piece is drawn.</h1>
      <LegalNav />
      <article className="pearl pad stack">
        <h2>Membership first</h2>
        <p>Customers buy a membership for one piece. Bonus entries are included only with that purchased membership.</p>
        <p>Bonus entries expire 12 months after they are recorded. Expired entries are left out of the snapshot.</p>
      </article>
      <div className="workflow-grid">
        <article className="well pad stack">
          <h2>Before the draw</h2>
          <p>Opening fixes the NFT, membership economics, closing time, treasury and randomness configuration. The raffle cannot close before its published deadline.</p>
          <p>After sales close, eligible entries freeze before randomness is requested.</p>
        </article>
        <article className="pearl pad stack">
          <h2>Outcome and recovery</h2>
          <p>Chainlink VRF selects from the frozen snapshot. The winner claims the NFT, the seller claims membership proceeds, and the pinned treasury receives the lab fee.</p>
          <p>If the raffle is cancelled, each buyer claims the membership price and lab fee they paid. The seller can reclaim the NFT.</p>
        </article>
      </div>
      <OnChainStatus surface="rules" />
      <div className="btn-row"><Link className="btn" href="/fairness">Review draw protections</Link><Link className="text-link" href="/membership">Compare memberships</Link></div>
    </section>
  );
}
