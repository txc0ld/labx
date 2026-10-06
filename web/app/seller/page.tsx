import Image from "next/image";
import Link from "next/link";
import { OnChainStatus } from "@/components/OnChainStatus";

export default function SellerPage() {
  return (
    <section className="section stack">
      <p className="kicker">Studio</p>
      <h1 className="page-title">Listing tools are unavailable.</h1>
      <div className="split legal-surfaces">
        <article className="pearl pad stack">
          <OnChainStatus surface="studio" />
          <p>The Studio will support authoritative raffle creation after the website listing integration is ready.</p>
          <Link className="btn" href="/guide#workflow">Read the intended workflow</Link>
        </article>
        <div className="bezel">
          <Image src="/lab/filter-panel.jpg" alt="Glossy filter panel in the Studio" width={900} height={675} />
        </div>
      </div>
    </section>
  );
}
