import type { Metadata } from "next";
import Link from "next/link";
import { LegalNav } from "@/components/LegalNav";
import { OPERATOR, OPERATOR_LINE, publicSiteHost } from "@/lib/operator";

export const metadata: Metadata = {
  title: "Privacy",
  description: "Privacy policy for the LABx Sepolia bench operated by Fantom Labs Pty Ltd."
};

export default function PrivacyPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">Your data</h1>
      <p className="lede legal-copy">
        This notice describes records created when you use the {OPERATOR.brand} bench at {publicSiteHost()}. It is a product draft for counsel, not a legal opinion.
      </p>
      <LegalNav />
      <div className="piece-grid legal-surfaces">
        <article className="pearl pad stack legal-copy">
          <h2>Who we are</h2>
          <p>
            {OPERATOR.brand} is operated by {OPERATOR_LINE}. This Sepolia deployment is a test bench. It is not a mainnet product and it is not a consumer promotion.
          </p>
        </article>
        <article className="terminal pad stack legal-copy">
          <h2>This Sepolia bench</h2>
          <p>
            Version 1.0 is intended for {OPERATOR.network} only. The website refuses a mainnet wallet. Listing and purchase tools are not connected. Do not send real-value assets or treat Sepolia balances as cash.
          </p>
        </article>
      </div>
      <article className="well pad stack legal-copy">
        <h2>What we collect</h2>
        <p>Depending on how you use the bench, we may process:</p>
        <ul>
          <li>Wallet address, connected chain, and signed messages you choose to submit.</li>
          <li>An email preference, only if you choose to save one in this browser.</li>
          <li>Existing points records tied to a wallet and UTC day. Points do not create bonus entries.</li>
          <li>Server logs created by hosting, such as IP address, user agent, path, and time, used to operate and secure the site.</li>
        </ul>
        <p>We do not ask for a government identity document on this bench. We do not sell personal information.</p>
        <h2>Why we collect it</h2>
        <p>
          The Privacy Act 1988 (Cth) applies to this operator. We collect this information under Australian Privacy Principle 3 because it is reasonably necessary for the current Sepolia site: connecting a wallet when you ask, showing existing account records, saving your local email preference, stopping automated abuse, and keeping the wallet gate on Sepolia.
        </p>
        <p>
          We use and disclose it under Australian Privacy Principle 6 for that primary purpose. A secondary purpose is limited to security, abuse prevention, and a legal obligation. We do not use these records for unrelated marketing.
        </p>
      </article>
      <article className="pearl pad stack legal-copy">
        <h2>How we store it</h2>
        <p>This browser stores only the email preference you choose to save. It does not store a wallet identity, raffle listing, purchase, entry, agreement, or draw history. Clearing site data removes the preference.</p>
        <p>When persistence is configured, agreement logs, points and reserve records may be written to a server store. Without that store, serverless instances do not keep those records between requests.</p>
        <p>Website listing, purchase, agreement and receipt tools are not connected. Saving an email preference does not send it to the server.</p>

        <h2>On-chain and public data</h2>
        <p>Anything you send to {OPERATOR.network} is public. Wallet addresses, pack events, escrow, snapshots, VRF words, and settlement are visible to anyone who reads the chain. Do not treat a wallet as private correspondence.</p>
        <p>Public pages show commitment hashes, not the private commercial number and not the salt.</p>

        <h2>Cookies and local storage</h2>
        <p>The bench uses local storage for the email preference. It does not use advertising cookies and it does not run a third-party ad pixel. Hosting may set a strictly necessary cookie for the application.</p>

        <h2>Who else sees a record</h2>
        <p>Infrastructure that may process data on our behalf includes the site host, an optional Redis store, an optional email sender, a wallet you install, and public Sepolia infrastructure including Chainlink VRF. Those processors see only what they need to provide that function.</p>
        <p>We do not publish a country-by-country storage map. Hosting, optional persistence, and optional mail may process a record outside Australia. Use of the bench is use of those processors.</p>

        <h2>Retention</h2>
        <p>The browser email preference stays until you replace it or clear site data. Server points are kept to enforce one check-in award per wallet and UTC day. Public chain records cannot be deleted by {OPERATOR.brand}.</p>

        <h2>Your rights</h2>
        <p>You may ask {OPERATOR.name} for access to personal information we hold about you, and you may ask for a correction. You may ask us to delete server-side records that are not required to keep the bench honest. We cannot rewrite a public chain event.</p>
        <p>If you are not satisfied, complain to the operator first. If that does not resolve it, you may complain to the Office of the Australian Information Commissioner. The process is published at <a href="https://www.oaic.gov.au/">the OAIC</a>.</p>

        <h2>Children</h2>
        <p>The bench is for people 18 or older. A membership purchase requires that confirmation. Do not use the bench if you are under 18.</p>

        <h2>Changes</h2>
        <p>We may update this notice as the Sepolia bench changes. The date below is the current draft. Material changes will be posted on this page.</p>

        <h2>Contact</h2>
        {/* TODO: add a published privacy mailbox when counsel assigns one. Do not invent an address. */}
        <p>Privacy contact via the site operator (Fantom Labs Pty Ltd). Use the operator published on {publicSiteHost()}. Do not send wallet keys, seed phrases, or a private commitment in that correspondence.</p>
        <p className="muted">Last updated 5 October 2026. {OPERATOR_LINE}.</p>
        <div className="btn-row">
          <Link className="btn" href="/legal">Terms</Link>
          <Link className="btn btn-dark" href="/about">About</Link>
          <Link className="btn btn-dark" href="/rules">Draw rules</Link>
        </div>
      </article>
    </section>
  );
}
