import type { Metadata } from "next";
import Link from "next/link";
import { LegalNav } from "@/components/LegalNav";
import { OPERATOR, OPERATOR_LINE, publicSiteHost } from "@/lib/operator";
import { BUYER_FEE_BPS, SELLER_FEE_BPS } from "@/lib/chain/fees";

export const metadata: Metadata = {
  title: "About",
  description: "LABx is the Sepolia membership bench operated by Fantom Labs Pty Ltd. Escrowed pieces, membership packs, Chainlink VRF."
};

export default function AboutPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">About LABx</h1>
      <p className="lede legal-copy">
        LABx is a membership bench for one escrowed piece at a time. Bonus entries come with the pack. After sales close, an entry snapshot freezes, then Chainlink VRF v2.5 selects the wallet.
      </p>
      <LegalNav />
      <div className="piece-grid">
        <article className="pearl pad stack">
          <h2>Operator</h2>
          <p>{OPERATOR.brand} is operated by {OPERATOR_LINE}.</p>
          <p>The public site is {publicSiteHost()}. The intended treasury and admin authority is a Safe multisig. Fantom Labs can pause new membership sales, while existing draw and recovery steps remain available.</p>
        </article>
        <article className="pearl pad stack">
          <h2>The bench</h2>
          <p>What is sold is a membership pack for a single piece. The ladder is Entry through Platinum. Each pack publishes its USDC price, bonus-entry count and remaining supply.</p>
          <p>The new contract version adds a {BUYER_FEE_BPS / 100}% purchase fee and deducts a separate {SELLER_FEE_BPS / 100}% seller fee at settlement. Cancelled raffles return the membership price and purchase fee to buyers. Historical contracts keep their original fees.</p>
          <p>Public pages do not publish a private commitment. They show the outer hash, the escrow lamp, and the draw phase.</p>
        </article>
        <article className="terminal pad stack">
          <h2>Network</h2>
          <p>This deployment is {OPERATOR.network} only, chain id {OPERATOR.chainId}. Sepolia assets have no cash value. Mainnet is disabled in the contract constructor, the deploy script, and the wallet gate.</p>
        </article>
        <article className="well pad stack">
          <h2>Materials</h2>
          <p>Matte ceramic and enamel panels. Fluoro chrome laboratory tubes with fittings. Black SVG marks. Capsule NFT CONTAINER well.</p>
        </article>
      </div>
      <article className="pearl pad stack legal-copy">
        <h2>How a piece moves</h2>
        <ol className="walkthrough-list">
          <li><strong>Prepare.</strong> The seller reviews the membership options, saves the commitment and escrows the NFT.</li>
          <li><strong>Open.</strong> Buyers choose a membership. Its published bonus entries join that piece only.</li>
          <li><strong>Draw.</strong> Sales close, eligible entries freeze, and Chainlink VRF supplies randomness.</li>
          <li><strong>Finish.</strong> The winner, seller and treasury claim their respective assets. Cancellation enables buyer refunds and NFT recovery.</li>
        </ol>
        <p>These pages are a product draft for counsel, not a legal opinion and not a consumer promotion.</p>
        <div className="btn-row">
          <Link className="btn" href="/guide">Follow the walkthrough</Link>
          <Link className="text-link" href="/fairness">Review draw protections</Link>
        </div>
      </article>
    </section>
  );
}
