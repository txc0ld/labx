import type { Metadata } from "next";
import Link from "next/link";
import { AccountNav } from "@/components/AccountNav";
import { LiveAccountHistory } from "@/components/workflow/LiveAccountHistory";

export const metadata: Metadata = { title: "Account history" };

export default function HistoryPage() {
  return (
    <section className="section workflow-page stack">
      <header className="workflow-header stack"><h1 className="page-title">History.</h1><p className="lede">Your purchases, claims and refunds.</p><AccountNav /></header>
      <LiveAccountHistory />
      <div className="btn-row"><Link className="btn" href="/profile/receipts">Receipts</Link><Link className="btn btn-dark" href="/fairness">How draws work</Link></div>
    </section>
  );
}
