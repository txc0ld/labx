"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { LAB_FEE, type Piece } from "@/lib/seed";
import { closingDate, pieceView } from "@/lib/piece-view";
import { useBenchTime } from "@/lib/use-bench-time";

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
      <section className="discovery-hero pearl" aria-labelledby="hero-title">
        <div className="discovery-heading">
          <p className="kicker">LABx / Sepolia demo bench</p>
          <h1 id="hero-title">Pieces, linked<br className="desktop-break" /> on the bench.</h1>
          <p className="lede">Choose a capsule. Open its piece console. Explore membership packs and the bonus entries that come with them.</p>
          <div className="btn-row">
            <a className="btn" href="#bench">Explore the bench <span aria-hidden="true">↗</span></a>
            <Link className="hero-about" href="/about">About the lab</Link>
          </div>
        </div>
        <aside className="discovery-readout terminal" aria-label="Demo bench information">
          <div className="readout-top"><span className="lamp lavender"><i /> Browser demo</span><span className="kicker">Sepolia</span></div>
          <p className="readout-number">{String(pieces.length).padStart(2, "0")}<span> demo {pieces.length === 1 ? "piece" : "pieces"}</span></p>
          <dl className="readout-specs">
            <div><dt>Pack currency</dt><dd>USDC</dd></div>
            <div><dt>Fee per pack</dt><dd>+{LAB_FEE} USDC</dd></div>
            <div><dt>Packs open</dt><dd>{available} demo {available === 1 ? "piece" : "pieces"}</dd></div>
          </dl>
          <p className="readout-note">Local demo fixtures and browser records. These controls do not transfer funds or submit transactions.</p>
          <Link href="/fairness" className="readout-link">How a draw stays fair <span aria-hidden="true">↗</span></Link>
        </aside>
      </section>
      {banner ? <p className={`notice ${banner.tone}`} role="status">{banner.text}</p> : null}
      <section className="capsule-collection" id="bench" aria-labelledby="bench-title">
        <div className="collection-heading">
          <div><p className="kicker">01 / Discovery</p><h2 id="bench-title">On the bench <span className="collection-count">{pieces.length}</span></h2></div>
          <div className="collection-filters" role="group" aria-label="Filter demo pieces">
            {FILTERS.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
          </div>
        </div>
        <p className="collection-note" role="status">Showing {shown.length} {shown.length === 1 ? "demo piece" : "demo pieces"}. Demo artwork and status; this is not a live raffle listing.</p>
        {shown.length ? (
          <ul className="capsule-grid" data-count={shown.length}>
            {shown.map((piece, index) => <Capsule key={piece.id} piece={piece} now={now} index={index} />)}
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

function Capsule({ piece, now, index }: { piece: Piece; now: number; index: number }) {
  const view = pieceView(piece, now);
  const entry = piece.packs.find((pack) => pack.name === "Entry");
  return (
    <li>
      <Link className="raffle-capsule bezel" href={`/piece/${piece.id}`} aria-label={`Open ${piece.title} demo piece`}>
        <div className="capsule-art">
          <Image src={piece.image} alt={piece.imageAlt} width={1101} height={1101} unoptimized />
          <span className="capsule-index" aria-hidden="true">LAB / {String(index + 1).padStart(2, "0")}</span>
          <span className="capsule-art-label">Demo artwork</span>
        </div>
        <div className="capsule-meta pearl">
          <span className={`lamp ${view.isOpen ? "mint" : "lavender"}`}><i /> {view.status}</span>
          <h3>{piece.title}</h3>
          <p className="capsule-artist">{piece.artist}</p>
          <dl className="capsule-specs">
            <div><dt>Entry pack</dt><dd>{entry ? `${entry.priceUsdc} USDC` : "Unavailable"}</dd></div>
            <div><dt>Lab fee</dt><dd>+{LAB_FEE} USDC / pack</dd></div>
            <div><dt>Sales close · UTC</dt><dd>{view.scheduled ? <time dateTime={piece.salesEnd}>{closingDate(piece.salesEnd)}</time> : "Not scheduled"}</dd></div>
          </dl>
          <div className="capsule-foot"><span>{view.timing}</span><span className="capsule-open" aria-hidden="true">↗</span></div>
        </div>
      </Link>
    </li>
  );
}
