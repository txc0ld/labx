import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms" };

export default function LegalPage() {
  return (
    <section className="section stack">
      <p className="kicker">Terms</p>
      <h1 className="page-title">Membership terms.</h1>
      <article className="pearl pad stack">
        <p>LABx is operated by Fantom Labs Pty Ltd (ABN 56 702 056 166, ACN 702 056 166) at labx.art.</p>
        <p>This deployment is Ethereum Sepolia only. It is a test network. Packs recorded here do not create mainnet obligations. Mainnet deployment is disabled in the contract and in the wallet gate.</p>
        <p>A membership pack is a paid membership for a single piece. Bonus entries included with a pack are a feature of that membership. They expire 12 months after they are recorded.</p>
        <p>The piece is escrowed in the contract before packs open. After sales close, an entry snapshot is frozen, then Chainlink VRF v2.5 selects the wallet. Settlement transfers the escrowed token to that wallet and the pack proceeds and lab fee as the contract specifies.</p>
        <p>The lab fee is 5 USDC per pack, denominated in USDC. ETH can be used only as an optional route through Uniswap and the Chainlink ETH/USD feed. USDC is the unit of account.</p>
        <p>A private commitment is stored as a hash. LABx does not publish that private commercial number on public pages.</p>
        <p>One complimentary entry may be requested per person per piece from the draw rules, after a bot-gated check-in and a captcha. That route is not promoted on the explore bench.</p>
        <p>You must confirm the agreements, including that you are 18 or older and eligible where you participate. Participation may be restricted where it is not lawful. These terms are a product draft for counsel, not a legal opinion.</p>
        <p>The admin and treasury are a Safe multisig. Fantom Labs can pause new packs and rotate the signer. Cancellation before settlement refunds the pack price and the lab fee to the buyer.</p>
      </article>
    </section>
  );
}
