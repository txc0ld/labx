import type { Metadata } from "next";
import Link from "next/link";
import { LegalNav } from "@/components/LegalNav";
import { OPERATOR, OPERATOR_LINE } from "@/lib/operator";

export const metadata: Metadata = {
  title: "Privacy",
  description: "Privacy policy for the LABx Sepolia bench operated by Fantom Labs Pty Ltd."
};

export default function PrivacyPage() {
  return (
    <section className="section stack">
      <p className="kicker">Privacy</p>
      <h1 className="page-title">How LABx handles records.</h1>
      <p className="lede legal-copy">
        This notice describes records created when you use the {OPERATOR.brand} bench at {OPERATOR.site}. It is a product draft for counsel, not a legal opinion.
      </p>
      <LegalNav />
      <article className="pearl pad stack legal-copy">
        <h2>Who we are</h2>
        <p>
          {OPERATOR.brand} is operated by {OPERATOR_LINE}. This Sepolia deployment is a test bench. It is not a mainnet product and it is not a consumer promotion.
        </p>

        <h2>This Sepolia bench</h2>
        <p>
          Version 1.0 runs on {OPERATOR.network} only. The website refuses a mainnet wallet. Packs recorded here do not create mainnet obligations. Do not send real-value assets or treat Sepolia balances as cash.
        </p>

        <h2>What we collect</h2>
        <p>Depending on how you use the bench, we may process:</p>
        <ul>
          <li>Wallet address, connected chain, and signed messages you choose to submit.</li>
          <li>Membership agreements: terms, draw rules including the 12-month expiry, and the 18+ eligibility confirmation, with a time stamp.</li>
          <li>Bonus-entry records created in this browser, including piece, pack, count, and expiry.</li>
          <li>Receipt email address, only if you ask for a receipt and sign that request.</li>
          <li>Bot check-in points tied to a wallet and UTC day. The website never embeds the bot token.</li>
          <li>Captcha challenge identifiers and answers needed to request a complimentary entry.</li>
          <li>Studio fields you submit for a piece: title, public summary, and a hash of the private commitment. The private commercial number is not published on public pages.</li>
          <li>Server logs created by hosting, such as IP address, user agent, path, and time, used to operate and secure the site.</li>
        </ul>
        <p>We do not ask for a government identity document on this bench. We do not sell personal information.</p>

        <h2>Why we collect it</h2>
        <p>We use those records to run the Sepolia bench: to record packs and agreements, to send a receipt you requested, to gate complimentary entries, to keep a studio commitment hash, to prevent automated abuse, and to keep the wallet gate on Sepolia.</p>
        <p>Under the Privacy Act 1988 (Cth) and the Australian Privacy Principles, those purposes are the operation of the service you asked for, a legal obligation where one applies, and our legitimate need to keep the bench secure and limited to a test network.</p>

        <h2>How we store it</h2>
        <p>This browser stores a local bench card so explore, studio, and profile keep working if you reload. That store is on your device. Clearing site data removes it.</p>
        <p>When persistence is configured, agreement logs, points, reserves, and complimentary-entry marks may be written to a server store. Without that store, serverless instances do not keep those records between requests.</p>
        <p>Receipts are sent with Resend only when a mail key is configured and a Sepolia wallet has signed the request. If mail is unset, the bench tells you the receipt was not delivered.</p>
        <p>On-chain writes happen only when a Sepolia raffle address is configured in the environment. If that value is unset, studio commits, packs, and complimentary entries stay on this bench. We do not invent or publish a live raffle address as a default.</p>

        <h2>On-chain and public data</h2>
        <p>Anything you send to {OPERATOR.network} is public. Wallet addresses, pack events, escrow, snapshots, VRF words, and settlement are visible to anyone who reads the chain. Do not treat a wallet as private correspondence.</p>
        <p>Public pages show commitment hashes, not the private commercial number and not the salt.</p>

        <h2>Cookies and local storage</h2>
        <p>The bench uses local storage for the in-browser card. It does not use advertising cookies and it does not run a third-party ad pixel. Hosting may set a strictly necessary cookie for the application.</p>

        <h2>Who else sees a record</h2>
        <p>Infrastructure that may process data on our behalf includes the site host, an optional Redis store, an optional email sender, a wallet you install, and public Sepolia infrastructure including Chainlink VRF. Those processors see only what they need to provide that function.</p>
        <p>Some of those services store data outside Australia. If you use the bench, you understand that a wallet address and a receipt email may be processed overseas by those operators.</p>

        <h2>Retention</h2>
        <p>Browser records stay until you clear them. Server points and complimentary marks are kept to enforce one complimentary entry per person per piece and one check-in award per UTC day. Agreement logs are kept to show that the three confirmations were made. Email is retained by the mail provider according to that provider&apos;s terms. Public chain records cannot be deleted by {OPERATOR.brand}.</p>

        <h2>Your rights</h2>
        <p>You may ask {OPERATOR.name} for access to personal information we hold about you, and you may ask for a correction. You may ask us to delete server-side records that are not required to keep the bench honest, such as a receipt email. We may refuse a request that would break a draw, hide an agreement, or rewrite a public chain event.</p>
        <p>If you are not satisfied, you may complain to us first. You may also contact the Office of the Australian Information Commissioner.</p>

        <h2>Children</h2>
        <p>The bench is for people 18 or older. A pack or complimentary entry requires that confirmation. Do not use the bench if you are under 18.</p>

        <h2>Changes</h2>
        <p>We may update this notice as the Sepolia bench changes. The date below is the current draft. Material changes will be posted on this page.</p>

        <h2>Contact</h2>
        <p>Write to {OPERATOR.name}, the operator published on {OPERATOR.site}. Do not send wallet keys, seed phrases, or a private commitment in that correspondence.</p>
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
