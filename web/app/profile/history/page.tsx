import type { Metadata } from "next";
import Link from "next/link";
import { AccountNav } from "@/components/AccountNav";

export const metadata: Metadata = { title: "Account history" };

export default function HistoryPage() {
  return (
    <section className="section workflow-page stack">
      <header className="workflow-header stack"><h1 className="page-title">History.</h1><p className="lede">Verified membership activity and recorded agreements belong here.</p><AccountNav /></header>
      <div className="workflow-grid">
        <article className="well pad stack"><h2>Entries and purchases</h2><p className="notice warning" role="status">History is unavailable because the website is not connected to an authoritative purchase source.</p><p>Verified pack purchases and the bonus entries attached to them will appear here when that source is connected.</p><Link href="/">Explore pieces</Link></article>
        <article className="pearl pad stack" id="agreements"><h2>Agreements</h2><p className="notice warning" role="status">Agreement records are unavailable.</p><p>A recorded terms, draw-rules and age assertion would belong here. This page does not infer or create one.</p><Link href="/rules">Read draw rules</Link></article>
      </div>
      <div className="btn-row"><Link className="btn" href="/profile/receipts">Receipts</Link><Link className="btn btn-dark" href="/fairness">How draws work</Link></div>
    </section>
  );
}
