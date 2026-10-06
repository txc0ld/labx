import type { Metadata } from "next";
import Link from "next/link";
import { AccountNav } from "@/components/AccountNav";

export const metadata: Metadata = { title: "Purchase receipts" };

export default function ReceiptsPage() {
  return (
    <section className="section workflow-page stack">
      <header className="workflow-header stack"><h1 className="page-title">Receipts.</h1><p className="lede">Verified purchases will supply the receipt records shown here.</p><AccountNav /></header>
      <article className="well pad stack">
        <h2>No receipt records available</h2>
        <p className="notice warning" role="status">Purchase history is not connected, so the website cannot verify or display a receipt.</p>
        <p>A verified receipt would describe the piece, pack, bonus entries, pack price and lab fee. No purchase or delivery is inferred here.</p>
      </article>
      <div className="btn-row"><Link className="btn" href="/profile#email-preferences">Email preferences</Link><Link className="btn btn-dark" href="/profile/history">Account history</Link></div>
    </section>
  );
}
