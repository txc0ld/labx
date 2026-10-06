import type { Metadata } from "next";
import Link from "next/link";
import { LegalNav } from "@/components/LegalNav";
import { OPERATOR, OPERATOR_LINE, publicSiteHost } from "@/lib/operator";

export const metadata: Metadata = {
  title: "Terms",
  description: "LABx membership terms for the Ethereum Sepolia bench operated by Fantom Labs Pty Ltd."
};

export default function LegalPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">Membership terms.</h1>
      <LegalNav />
      <div className="piece-grid legal-surfaces">
        <article className="pearl pad stack legal-copy">
          <h2>Operator</h2>
          <p>{OPERATOR.brand} is operated by {OPERATOR_LINE} at {publicSiteHost()}.</p>
        </article>
        <article className="terminal pad stack legal-copy">
          <h2>Network</h2>
          <p>This deployment is intended for {OPERATOR.network} only. It is a test network. The current website does not accept pack purchases. Mainnet deployment is disabled in the contract and in the wallet gate.</p>
        </article>
      </div>
      <article className="well pad stack legal-copy">
        <h2>Membership packs</h2>
        <p>A membership pack is a paid membership for a single piece. Bonus entries included with a pack are a feature of that membership. They expire 12 months after they are recorded.</p>
        <h2>Agreements</h2>
        <p>You must confirm the agreements, including that you are 18 or older and eligible where you participate. Participation may be restricted where it is not lawful. These terms are a product draft for counsel, not a legal opinion.</p>
      </article>
      <article className="pearl pad stack legal-copy">
        <h2>Draw and settlement</h2>
        <p>The piece is escrowed before memberships open. After sales close, eligible bonus entries are frozen, then Chainlink VRF v2.5 selects the wallet. The winner claims the NFT, the seller claims membership proceeds, and the pinned treasury receives the lab fee.</p>
        <p>If a raffle is cancelled before settlement, each buyer can claim the membership price and lab fee they paid. The seller can reclaim the NFT.</p>

        <h2>Lab fee</h2>
        <p>The lab fee is 5 USDC per pack, denominated in USDC. ETH can be used only as an optional route through Uniswap and the Chainlink ETH/USD feed. USDC is the unit of account.</p>

        <h2>Commitments</h2>
        <p>A private commitment is stored as a hash. {OPERATOR.brand} does not publish that private commercial number on public pages.</p>

        <h2>Admin</h2>
        <p>The intended admin and treasury authority is a Safe multisig. Fantom Labs can pause new membership sales. A pause does not stop closing, drawing, settlement, claims or timed recovery for an existing raffle.</p>

        <h2>Privacy</h2>
        <p>Wallet, email, agreement, and server records are described in the <Link href="/privacy">privacy policy</Link>. The operator is introduced on the <Link href="/about">about</Link> page.</p>
        <p className="muted">Last updated 5 October 2026. {OPERATOR_LINE}.</p>
        <div className="btn-row"><Link className="btn" href="/rules">Read the draw rules</Link><Link className="text-link" href="/guide">Follow the walkthrough</Link></div>
      </article>
    </section>
  );
}
