"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { BrowserService, RaffleService } from "@/lib/chain/ports";
import type { RaffleSnapshot } from "@/lib/chain/types";
import { formatDate, formatUsdc, minimumActivePrice, catalogAvailability, shortAddress } from "./format";
import { RaffleArtwork } from "./RaffleArtwork";

export type CatalogState =
  | { kind: "loading" }
  | { kind: "unavailable" | "legacy" | "mismatch" | "error"; message: string }
  | { kind: "ready"; items: readonly RaffleSnapshot[]; nextCursor: bigint | null; loadingMore: boolean };

export function RaffleCatalog({ browser }: { browser: BrowserService }) {
  const [state, setState] = useState<CatalogState>({ kind: "loading" });
  const request = useRef(0);

  async function load(cursor?: bigint) {
    if (browser.kind === "unavailable") {
      setState({ kind: "unavailable", message: browser.reason });
      return;
    }
    const version = ++request.current;
    try {
      if (cursor === undefined) {
        setState({ kind: "loading" });
        const deployment = await browser.service.attest();
        if (version !== request.current) return;
        if (deployment.kind !== "verified") {
          setState({ kind: deployment.kind, message: deployment.reason });
          return;
        }
      } else {
        setState((current) => current.kind === "ready" ? { ...current, loadingMore: true } : current);
      }
      const page = await browser.service.listRaffles({ cursor, limit: 12 });
      if (version !== request.current) return;
      setState((current) => ({
        kind: "ready",
        items: cursor !== undefined && current.kind === "ready" ? [...current.items, ...page.items] : page.items,
        nextCursor: page.nextCursor,
        loadingMore: false
      }));
    } catch (error) {
      if (version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "The collection could not be loaded." });
    }
  }

  useEffect(() => {
    void load();
    return () => { request.current += 1; };
    // A new runtime invalidates the previous authoritative read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser]);

  return <RaffleCatalogView state={state} service={browser.kind === "configured" ? browser.service : undefined} onRetry={() => void load()} onLoadMore={(cursor) => void load(cursor)} />;
}

export function RaffleCatalogView({ state, service, onRetry, onLoadMore }: {
  state: CatalogState;
  service?: RaffleService;
  onRetry: () => void;
  onLoadMore: (cursor: bigint) => void;
}) {
  const [filter, setFilter] = useState<"all" | "open" | "finished">("all");
  if (state.kind === "loading") return <div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading the collection</strong><p>Reading verified raffle records.</p></div></div>;
  if (state.kind !== "ready") {
    return (
      <div className="well empty-bench stack">
        <h2>{state.kind === "legacy" ? "Legacy deployment detected" : state.kind === "mismatch" ? "Deployment mismatch" : "Collection unavailable"}</h2>
        <p className="notice warning" role={state.kind === "error" ? "alert" : "status"}>{state.message}</p>
        <p>Please try again shortly.</p>
        <button className="btn btn-dark" type="button" onClick={onRetry}>Retry connection</button>
      </div>
    );
  }
  if (!state.items.length) {
    return <div className="well empty-bench stack"><h2>No raffles listed</h2><p>The verified deployment has no raffle records yet.</p><Link className="btn btn-dark" href="/guide">How LABx works</Link></div>;
  }

  const shown = state.items.filter((snapshot) => filter === "all" || (filter === "open" ? catalogAvailability(snapshot).purchasable : catalogAvailability(snapshot).ended));
  return (
    <section className="stack" aria-labelledby="live-raffles-title">
      <div className="collection-heading"><h2 id="live-raffles-title">Verified raffles <span className="collection-count">{state.items.length} loaded</span></h2><div className="collection-filters" role="group" aria-label="Filter raffles">{([['all','All'],['open','Open'],['finished','Ended']] as const).map(([value,label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div></div>
      {shown.length ? <ul className="capsule-grid" data-count={shown.length}>{shown.map((snapshot) => <RaffleCard key={snapshot.id.toString()} service={service} snapshot={snapshot} />)}</ul> : <div className="well empty-bench stack"><h3>No raffles in this view</h3><p>Choose another filter to see the verified records already loaded.</p><button className="btn btn-dark" type="button" onClick={() => setFilter("all")}>Show all</button></div>}
      {state.nextCursor !== null ? <button className="btn load-more" type="button" disabled={state.loadingMore} onClick={() => onLoadMore(state.nextCursor ?? 0n)}>{state.loadingMore ? "Loading…" : "Load more raffles"}</button> : null}
    </section>
  );
}

function RaffleCard({ service, snapshot }: { service?: RaffleService; snapshot: RaffleSnapshot }) {
  const price = minimumActivePrice(snapshot);
  const status = catalogAvailability(snapshot);
  return (
    <li>
      <Link className="raffle-capsule chain-capsule" href={`/piece/${snapshot.id.toString()}`} aria-label={`Open ${snapshot.raffle.title}`}>
        {service ? <RaffleArtwork service={service} snapshot={snapshot} compact /> : <div className="chain-capsule-art"><span aria-hidden="true">{snapshot.raffle.title.slice(0, 2).toUpperCase()}</span><p>NFT artwork unavailable</p><small>Token #{snapshot.raffle.tokenId.toString()}</small></div>}
        <div className="capsule-meta">
          <div className="capsule-title-row"><div><h3>{snapshot.raffle.title}</h3><p className="capsule-artist">NFT {shortAddress(snapshot.raffle.nft)}</p></div><span className={`capsule-status ${status.purchasable ? "is-open" : ""}`}>{status.label}</span></div>
          <p className="capsule-price">{!status.purchasable || price === null ? "Membership sales unavailable" : `From ${formatUsdc(price + snapshot.labFee)} USDC · includes ${formatUsdc(snapshot.labFee)} lab fee`}</p>
          <div className="capsule-foot"><span>{status.purchasable ? `${status.remaining.toLocaleString("en-US")} memberships left · ` : ""}Sales deadline {formatDate(snapshot.raffle.salesEnd)} UTC</span><span className="capsule-open" aria-hidden="true">View raffle ↗</span></div>
        </div>
      </Link>
    </li>
  );
}
