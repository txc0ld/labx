import { LegalNav } from "@/components/LegalNav";
import { OnChainStatus } from "@/components/OnChainStatus";

export default function RulesPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">How a piece is drawn.</h1>
      <LegalNav />
      <article className="pearl pad stack">
        <p>Packs are memberships. Each pack includes a published number of bonus entries into that piece only.</p>
        <p>Entries expire 12 months after they are recorded. Expired entries are left out of the snapshot.</p>
        <p>The snapshot is taken before randomness is requested. Chainlink VRF v2.5 supplies the word used to walk the frozen weights.</p>
        <p>The lab fee is 5 USDC per pack. Settlement (`settle`) flips the piece to the settled phase. The drawn wallet claims the prize with `claimPrize`. The seller claims pack proceeds with `claimProceeds`. The treasury claims the lab fee with `claimFee`. Pack price and fee are refunded if the piece is cancelled before settlement.</p>
      </article>
      <article className="well pad stack">
        <h2>Complimentary entry</h2>
        <p>The contract supports one complimentary bonus entry per person per piece, subject to the published requirements.</p>
        <OnChainStatus surface="rules" />
      </article>
    </section>
  );
}
