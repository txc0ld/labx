import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Eligibility review",
  description: "Review the stated LABx membership and draw requirements."
};

export default function EligibilityPage() {
  return (
    <section className="section workflow-page stack">
      <header className="workflow-header stack">
        <p className="kicker">Before a purchase</p>
        <h1 className="page-title">Eligibility.</h1>
        <p className="lede">Use this checklist to review the published requirements. It does not verify eligibility, record an agreement or grant access.</p>
      </header>
      <fieldset className="eligibility-list pearl pad">
        <legend>Personal review</legend>
        <label><input type="checkbox" /> I am at least 18 years old.</label>
        <label><input type="checkbox" /> I have read the membership terms.</label>
        <label><input type="checkbox" /> I have read the draw rules.</label>
        <label><input type="checkbox" /> I understand that bonus entries expire 12 months after they are recorded.</label>
        <label><input type="checkbox" /> I have checked that participation is lawful where I am.</label>
      </fieldset>
      <p className="notice warning" role="status">This local checklist is informational. The website does not save it or confirm that you are eligible.</p>
      <div className="btn-row"><Link className="btn" href="/membership">Back to membership</Link><Link className="btn btn-dark" href="/">Explore pieces</Link><Link className="btn btn-lime" href="/legal">Read terms</Link><Link className="btn btn-pink" href="/rules">Read draw rules</Link></div>
    </section>
  );
}
