import { LiveSeller } from "@/components/workflow/LiveSeller";

export default function SellerPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">Seller studio</h1>
      <p className="lede">Create raffles and track your revenue.</p>
      <LiveSeller />
    </section>
  );
}
