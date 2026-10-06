import type { Metadata } from "next";
import Link from "next/link";
import { LegalNav } from "@/components/LegalNav";
import { OPERATOR, OPERATOR_LINE, publicSiteHost } from "@/lib/operator";

export const metadata: Metadata = {
  title: "About",
  description: "LABx is the Sepolia membership bench operated by Fantom Labs Pty Ltd. Escrowed pieces, membership packs, Chainlink VRF."
};

export default function AboutPage() {
  return (
    <section className="section stack">
      <p className="kicker">About</p>
      <h1 className="page-title">About LABx</h1>
      <p className="lede legal-copy">
        LABx is a membership bench for one escrowed piece at a time. Bonus entries come with the pack. After sales close, an entry snapshot freezes, then Chainlink VRF v2.5 selects the wallet.
      </p>
      <LegalNav />
      <div className="piece-grid">
        <article className="pearl pad stack">
          <h2>Operator</h2>
          <p>{OPERATOR.brand} is operated by {OPERATOR_LINE}.</p>
          <p>The public site is {publicSiteHost()}. The intended treasury and admin authority is a Safe multisig. Fantom Labs is intended to be able to pause new packs and rotate the complimentary-entry signer.</p>
        </article>
        <article className="pearl pad stack">
          <h2>The bench</h2>
          <p>What is sold is a membership pack for a single piece. The ladder is Entry through Platinum. Each pack publishes its USDC price, bonus-entry count, remaining supply, and the 5 USDC lab fee.</p>
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
        <p>Studio commits a piece, escrows the token, then opens packs. Buyers confirm three agreements. Sales close, expired entries drop out of the snapshot, VRF supplies the word, the commitment can be revealed, then settlement or cancel-and-claim.</p>
        <p>A complimentary bonus entry lives on the draw-rules page after a bot-gated check-in and a captcha. It is not promoted on explore.</p>
        <p>These pages are a product draft for counsel, not a legal opinion and not a consumer promotion.</p>
        <div className="btn-row">
          <Link className="btn" href="/">Explore the bench</Link>
          <Link className="btn btn-dark" href="/fairness">Fairness</Link>
          <Link className="btn btn-dark" href="/legal">Terms</Link>
          <Link className="btn btn-dark" href="/privacy">Privacy</Link>
        </div>
      </article>
    </section>
  );
}
