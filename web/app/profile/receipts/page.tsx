import type { Metadata } from "next";
import Link from "next/link";
import { AccountNav } from "@/components/AccountNav";
import { LivePrivateRecords } from "@/components/workflow/LivePrivateRecords";

export const metadata: Metadata = { title: "Purchase receipts" };

export default function ReceiptsPage() {
  return (
    <section className="section workflow-page stack">
      <header className="workflow-header stack"><h1 className="page-title">Receipts.</h1><p className="lede">Email yourself a receipt for any purchase.</p><AccountNav /></header>
      <LivePrivateRecords />
      <div className="btn-row"><Link className="btn" href="/profile#email-preferences">Receipt email</Link><Link className="btn btn-dark" href="/profile/history">Account history</Link></div>
    </section>
  );
}
