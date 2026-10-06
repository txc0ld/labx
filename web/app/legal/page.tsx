import type { Metadata } from "next";
import Link from "next/link";
import { LegalNav } from "@/components/LegalNav";
import { OPERATOR_LINE, publicSiteHost } from "@/lib/operator";
import { MEMBERSHIP_TERMS, TERMS_VERSION } from "@/lib/published-terms";

export const metadata: Metadata = {
  title: "Terms",
  description: "LABx membership terms for the Ethereum Sepolia bench operated by Fantom Labs Pty Ltd."
};

export default function LegalPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">Membership terms.</h1>
      <LegalNav />
      <div className="legal-section-grid">
        {MEMBERSHIP_TERMS.map((section, index) => <article className={`${index % 2 ? "well" : "pearl"} pad stack legal-copy`} key={section.heading}><h2>{section.heading}</h2>{section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</article>)}
      </div>
      <article className="pearl pad stack legal-copy">
        <h2>Published version</h2>
        <p>These are the exact terms version checked before a membership purchase. Availability still depends on a verified deployment and current contract state.</p>
        <p className="muted">{TERMS_VERSION} · {OPERATOR_LINE} · {publicSiteHost()}.</p>
        <div className="btn-row"><Link className="btn" href="/rules">Read the draw rules</Link><Link className="text-link" href="/guide">Follow the walkthrough</Link></div>
      </article>
    </section>
  );
}
