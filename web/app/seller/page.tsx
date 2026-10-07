import { LiveSeller } from "@/components/workflow/LiveSeller";

export default function SellerPage() {
  return (
    <section className="section stack page-frame">
      <p className="kicker">Seller studio</p>
      <h1 className="page-title">Your raffles. One clear view.</h1>
      <p className="lede">Track settled revenue, pending principal and refunds, then continue every permitted seller step from the connected raffle owner wallet.</p>
      <LiveSeller />
    </section>
  );
}
