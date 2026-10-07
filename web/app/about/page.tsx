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
        Buy a membership for a piece you love. Each pack includes bonus entries in its raffle. The NFT stays in escrow, and Chainlink VRF selects a wallet after sales close.
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
          <p>The new contract adds a processing fee of 2.50 USDC or {BUYER_FEE_BPS / 100}% of the pack subtotal, whichever is higher. It deducts a separate {SELLER_FEE_BPS / 100}% from seller proceeds at settlement. Cancellation returns the pack price only; the processing fee is retained. Historical contracts keep their original rules.</p>
          <p>Public pages do not publish a private commitment. They show the commitment hash, escrow status and draw phase.</p>
        </article>
        <article className="terminal pad stack">
          <h2>Network</h2>
          <p>LABx is being tested on {OPERATOR.network}, chain ID {OPERATOR.chainId}. The website only enables approved test deployments. Ethereum mainnet is blocked by the contract constructor.</p>
        </article>
        <article className="well pad stack">
          <h2>Know your piece</h2>
          <p>LABx reviews the collection contract, exact token, escrow and transfer restrictions before sales open. Check the NFT details yourself too. A familiar name or image does not establish authenticity.</p>
        </article>
      </div>
      <article className="pearl pad stack legal-copy">
        <h2>How a piece moves</h2>
        <ol className="walkthrough-list">
          <li><strong>Prepare.</strong> The seller reviews the membership options, saves the commitment and escrows the NFT.</li>
          <li><strong>Review.</strong> LABx checks the NFT and draw funding. Draft changes require another review.</li>
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
