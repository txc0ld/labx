import Link from "next/link";
import { LegalNav } from "@/components/LegalNav";
import { OnChainStatus } from "@/components/OnChainStatus";
import { DRAW_RULES, TERMS_VERSION } from "@/lib/published-terms";

export default function RulesPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">How a piece is drawn.</h1>
      <LegalNav />
      <div className="legal-section-grid">{DRAW_RULES.map((section, index) => <article className={`${index % 2 ? "well" : "pearl"} pad stack`} key={section.heading}><h2>{section.heading}</h2>{section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</article>)}</div>
      <p className="muted">Published rules version: {TERMS_VERSION}.</p>
      <OnChainStatus surface="rules" />
      <div className="btn-row"><Link className="btn" href="/fairness">Review draw protections</Link><Link className="text-link" href="/membership">Compare memberships</Link></div>
    </section>
  );
}
