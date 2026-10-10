import Link from "next/link";
import { LiveSeller } from "@/components/workflow/LiveSeller";

export default function SellerPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">Seller studio</h1>
      <p className="lede">Create raffles and track your revenue. <Link className="text-link" href="/guide#selling">How selling works</Link></p>
      <LiveSeller />
    </section>
  );
}
