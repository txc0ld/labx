import type { Metadata } from "next";
import Link from "next/link";
import { LegalNav } from "@/components/LegalNav";
import { OPERATOR, OPERATOR_LINE } from "@/lib/operator";

export const metadata: Metadata = {
  title: "Terms",
  description: "LABx membership terms for the Ethereum Sepolia bench operated by Fantom Labs Pty Ltd."
};

export default function LegalPage() {
  return (
    <section className="section stack">
      <p className="kicker">Terms</p>
      <h1 className="page-title">Membership terms.</h1>
      <LegalNav />
      <article className="pearl pad stack legal-copy">
        <h2>Operator</h2>
        <p>{OPERATOR.brand} is operated by {OPERATOR_LINE} at {OPERATOR.site}.</p>

        <h2>Network</h2>
        <p>This deployment is {OPERATOR.network} only. It is a test network. Packs recorded here do not create mainnet obligations. Mainnet deployment is disabled in the contract and in the wallet gate.</p>

        <h2>Membership packs</h2>
        <p>A membership pack is a paid membership for a single piece. Bonus entries included with a pack are a feature of that membership. They expire 12 months after they are recorded.</p>

        <h2>Draw and settlement</h2>
        <p>The piece is escrowed in the contract before packs open. After sales close, an entry snapshot is frozen, then Chainlink VRF v2.5 selects the wallet. Settlement transfers the escrowed token to that wallet and the pack proceeds and lab fee as the contract specifies.</p>

        <h2>Lab fee</h2>
        <p>The lab fee is 5 USDC per pack, denominated in USDC. ETH can be used only as an optional route through Uniswap and the Chainlink ETH/USD feed. USDC is the unit of account.</p>

        <h2>Commitments</h2>
        <p>A private commitment is stored as a hash. {OPERATOR.brand} does not publish that private commercial number on public pages.</p>

        <h2>Complimentary entry</h2>
        <p>One complimentary entry may be requested per person per piece from the <Link href="/rules">draw rules</Link>, after a bot-gated check-in and a captcha. That route is not promoted on the explore bench.</p>

        <h2>Agreements</h2>
        <p>You must confirm the agreements, including that you are 18 or older and eligible where you participate. Participation may be restricted where it is not lawful. These terms are a product draft for counsel, not a legal opinion.</p>

        <h2>Admin</h2>
        <p>The admin and treasury are a Safe multisig. Fantom Labs can pause new packs and rotate the signer. Cancellation before settlement refunds the pack price and the lab fee to the buyer.</p>

        <h2>Privacy</h2>
        <p>Wallet, email, agreement, and server records are described in the <Link href="/privacy">privacy policy</Link>. The operator is introduced on the <Link href="/about">about</Link> page.</p>
        <p className="muted">Last updated 5 October 2026. {OPERATOR_LINE}.</p>
      </article>
    </section>
  );
}
