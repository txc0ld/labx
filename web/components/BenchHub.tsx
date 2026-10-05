"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { LAB_FEE, type Piece } from "@/lib/seed";
import { closingDate, pieceView } from "@/lib/piece-view";
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
  const available = pieces.filter((piece) => pieceView(piece, now).isOpen).length;

  return (
    <>
      <section className="collection-intro" aria-labelledby="hero-title" data-reveal>
        <div className="collection-title-block">
          <p className="kicker">LABx / Sepolia browser demo</p>
          <ResolvedTitle />
        </div>
        <div className="collection-intro-copy">
          <p>Explore artwork, membership packs and availability.</p>
          <p className="collection-demo-label"><strong>Demo collection</strong> · {pieces.length} {pieces.length === 1 ? "piece" : "pieces"} · {available} open · no live transactions</p>
        </div>
      </section>
      {banner ? <p className={`notice ${banner.tone}`} role="status">{banner.text}</p> : null}
      <section className="capsule-collection" id="bench" aria-labelledby="bench-title" data-reveal>
        <div className="collection-heading">
          <h2 className="sr" id="bench-title">Available pieces</h2>
          <div className="collection-filters" role="group" aria-label="Filter demo pieces">
            {FILTERS.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
          </div>
        </div>
        <p className="sr" role="status">Showing {shown.length} {shown.length === 1 ? "demo piece" : "demo pieces"}. Demo artwork and status; this is not a live raffle listing.</p>
        {shown.length ? (
          <ul className="capsule-grid" data-count={shown.length}>
            {shown.map((piece) => <Capsule key={piece.id} piece={piece} now={now} />)}
          </ul>
        ) : (
          <div className="well empty-bench">
            <span className="empty-port" aria-hidden="true" />
            <h3>{pieces.length ? "No pieces in this view" : "The bench is clear"}</h3>
            <p>{pieces.length ? "Choose All pieces to explore the available demo capsules." : "No demo pieces are available in this browser yet."}</p>
            {filter !== "all" ? <button className="btn btn-dark" type="button" onClick={() => setFilter("all")}>Show all pieces</button> : null}
          </div>
        )}
      </section>
      <p className="notice warning">Sepolia demo bench. Pack and draw records stay in this browser; they do not submit transactions. Ethereum mainnet is disabled.</p>
    </>
  );
}

function Capsule({ piece, now }: { piece: Piece; now: number }) {
  const view = pieceView(piece, now);
  const entry = piece.packs.find((pack) => pack.name === "Entry");
  return (
    <li data-reveal>
      <Link className="raffle-capsule" href={`/piece/${piece.id}`} aria-label={`Open ${piece.title} demo piece`}>
        <div className="capsule-art">
          <Image src={piece.image} alt={piece.imageAlt} width={1101} height={1101} unoptimized />
        </div>
        <div className="capsule-meta">
          <div className="capsule-title-row">
            <div><h3>{piece.title}</h3><p className="capsule-artist">{piece.artist}</p></div>
            <span className={`capsule-status ${view.isOpen ? "is-open" : ""}`}>{view.status}</span>
          </div>
          <dl className="capsule-specs">
            <div><dt>Entry pack</dt><dd>{entry ? `${entry.priceUsdc} USDC` : "Unavailable"}</dd></div>
            <div><dt>Lab fee</dt><dd>+{LAB_FEE} USDC / pack</dd></div>
            <div><dt>Sales close · UTC</dt><dd>{view.scheduled ? <time dateTime={piece.salesEnd}>{closingDate(piece.salesEnd)}</time> : "Not scheduled"}</dd></div>
          </dl>
          <div className="capsule-foot"><span>{view.timing}</span><span className="capsule-open" aria-hidden="true">View piece ↗</span></div>
        </div>
      </Link>
    </li>
  );
}
