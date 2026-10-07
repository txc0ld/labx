"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { Piece } from "@/lib/seed";
import { BUYER_FEE_BPS } from "@/lib/chain/fees";
import { pieceView } from "@/lib/piece-view";
import { useBenchTime } from "@/lib/use-bench-time";
import { ResolvedTitle } from "./ResolvedTitle";

type Filter = "all" | "open" | "ended";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All pieces" },
  { value: "open", label: "Packs open" },
  { value: "ended", label: "Ended" }
];

export function BenchHub({ pieces, banner }: {
  pieces: Piece[];
  banner?: { tone: "warning" | "error" | "ok"; text: string };
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const now = useBenchTime();
  const shown = pieces.filter((piece) => {
    const view = pieceView(piece, now);
    return filter === "all" || (filter === "open" ? view.isOpen : view.isEnded);
  });
  return (
    <>
      <section className="collection-intro" aria-labelledby="hero-title" data-reveal>
        <div className="collection-title-block">
          <ResolvedTitle />
        </div>
        <div className="collection-intro-actions">
          <p className="collection-status-label"><strong>Listings unavailable</strong></p>
          <Link href="/guide" className="guide-link">How it works <span aria-hidden="true">↗</span></Link>
        </div>
      </section>
      {banner ? <p className={`notice ${banner.tone}`} role="status">{banner.text}</p> : null}
      <section className="capsule-collection" id="bench" aria-labelledby="bench-title" data-reveal>
        <div className="collection-heading">
          <h2 className="sr" id="bench-title">Available pieces</h2>
          <div className="collection-filters" role="group" aria-label="Filter raffles">
            {FILTERS.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
          </div>
        </div>
        <p className="sr" role="status">Showing {shown.length} {shown.length === 1 ? "raffle" : "raffles"}.</p>
        {shown.length ? (
          <ul className="capsule-grid" data-count={shown.length}>
            {shown.map((piece) => <Capsule key={piece.id} piece={piece} now={now} />)}
          </ul>
        ) : (
          <div className="well empty-bench">
            <span className="empty-port" aria-hidden="true" />
            <h3>{pieces.length ? "No raffles in this view" : "No raffles listed"}</h3>
            <p>{pieces.length ? "Choose All pieces to view every listed raffle." : <>Listing tools are not connected yet. Read the <Link href="/guide">guide</Link> to learn how raffles are intended to work.</>}</p>
            {!pieces.length ? <div className="btn-row"><Link className="btn" href="/membership">Compare membership packs</Link><Link className="btn btn-dark" href="/discounts">See partner discounts</Link></div> : null}
            {filter !== "all" ? <button className="btn btn-dark" type="button" onClick={() => setFilter("all")}>Show all pieces</button> : null}
          </div>
        )}
      </section>
    </>
  );
}

function Capsule({ piece, now }: { piece: Piece; now: number }) {
  const view = pieceView(piece, now);
  const entry = piece.packs.find((pack) => pack.name === "Entry");
  const entrySummary = !entry
    ? "Entry pack unavailable"
    : entry.remaining > 0
      ? `${entry.priceUsdc} USDC entry pack`
      : "Entry pack sold out";
  return (
    <li data-reveal>
      <Link className="raffle-capsule" href={`/piece/${piece.id}`} aria-label={`Open ${piece.title}`}>
        <div className="capsule-art">
          <Image src={piece.image} alt={piece.imageAlt} width={1101} height={1101} unoptimized />
        </div>
        <div className="capsule-meta">
          <div className="capsule-title-row">
            <div><h3>{piece.title}</h3><p className="capsule-artist">{piece.artist}</p></div>
            <span className={`capsule-status ${view.isOpen ? "is-open" : ""}`}>{view.status}</span>
          </div>
          <p className="capsule-price">{entrySummary} · +{BUYER_FEE_BPS / 100}% purchase fee</p>
          <div className="capsule-foot"><span>{view.timing}</span><span className="capsule-open" aria-hidden="true">View piece ↗</span></div>
        </div>
      </Link>
    </li>
  );
}
