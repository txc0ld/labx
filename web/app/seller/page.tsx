import { OnChainStatus } from "@/components/OnChainStatus";
import { StudioPreparation } from "@/components/StudioPreparation";

export default function SellerPage() {
  return (
    <section className="section stack page-frame">
      <h1 className="page-title">Prepare a listing.</h1>
      <p className="lede">Draft public piece details and review them before the future escrow and publishing steps.</p>
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
