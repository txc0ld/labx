import { OnChainStatus } from "@/components/OnChainStatus";
import { StudioPreparation } from "@/components/StudioPreparation";

export default function SellerPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">Prepare a listing.</h1>
      <p className="lede">Draft public piece details and review them before the future escrow and publishing steps.</p>
      <ol className="workflow-rail" aria-label="Seller workflow">
        <li><span>01</span><strong>Prepare</strong><small>Draft and review</small></li>
        <li><span>02</span><strong>Escrow</strong><small>Approve and verify</small></li>
        <li><span>03</span><strong>Open</strong><small>Publish fixed terms</small></li>
        <li><span>04</span><strong>Draw</strong><small>Snapshot and request</small></li>
        <li><span>05</span><strong>Finish</strong><small>Settle or recover</small></li>
      </ol>
      <div className="workflow-grid legal-surfaces">
        <article className="pearl pad stack">
          <h2>Current status</h2>
          <OnChainStatus surface="studio" />
          <p>Studio does not save drafts, upload files, create listings, request signatures or publish on-chain.</p>
          <p className="muted">A live listing still needs NFT escrow, a public commitment and an authoritative publishing connection.</p>
        </article>
        <article className="well pad"><StudioPreparation /></article>
      </div>
    </section>
  );
}
