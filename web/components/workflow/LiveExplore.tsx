"use client";

import Link from "next/link";
import { useBench } from "@/lib/bench";
import { RaffleCatalogView, type CatalogState } from "./RaffleCatalog";
import { ResolvedTitle } from "@/components/ResolvedTitle";

export function LiveExplore() {
  const bench = useBench();
  const catalog: CatalogState = bench.catalog.kind === "ready"
    ? { kind: "ready", items: bench.catalog.items, nextCursor: bench.catalog.nextCursor, loadingMore: false }
    : bench.catalog.kind === "loading"
      ? { kind: "loading" }
      : { kind: bench.catalog.kind, message: bench.catalog.reason };
  return (
    <>
      <section className="collection-intro" aria-labelledby="hero-title" data-reveal>
        <div className="collection-title-block"><ResolvedTitle /></div>
        <div className="collection-intro-actions"><p className="collection-status-label"><strong>Verified contract records</strong></p><Link href="/guide" className="guide-link">How it works <span aria-hidden="true">↗</span></Link></div>
      </section>
      {bench.banner ? <p className={`notice ${bench.banner.tone}`} role="status">{bench.banner.text}</p> : null}
      <section className="capsule-collection" id="bench">
        <RaffleCatalogView state={catalog} onRetry={() => void bench.refreshCatalog()} onLoadMore={() => void bench.loadMoreCatalog()} />
      </section>
    </>
  );
}
