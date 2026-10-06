import { LiveSeller } from "@/components/workflow/LiveSeller";

export default function SellerPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">Prepare a listing.</h1>
      <p className="lede">Create, open and complete a raffle from the connected seller wallet.</p>
      <ol className="workflow-rail" aria-label="Seller workflow">
        <li><span>01</span><strong>Prepare</strong><small>Draft and review</small></li>
        <li><span>02</span><strong>Escrow</strong><small>Approve and verify</small></li>
        <li><span>03</span><strong>Open</strong><small>Publish fixed terms</small></li>
        <li><span>04</span><strong>Draw</strong><small>Snapshot and request</small></li>
        <li><span>05</span><strong>Finish</strong><small>Settle or recover</small></li>
      </ol>
      <LiveSeller />
    </section>
  );
}
