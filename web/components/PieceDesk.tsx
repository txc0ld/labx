"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import BookDemoButton from "./pixel-perfect/book-demo-button";
import { OnChainStatus } from "@/components/OnChainStatus";
import { useBench } from "@/lib/bench";
import { LAB_FEE, type PackName } from "@/lib/seed";
import { closingDate, pieceView } from "@/lib/piece-view";
import { useBenchTime } from "@/lib/use-bench-time";
import SquishyPackCard from "@/components/ui/squishy-card-component";

export function PieceDesk({ id }: { id: string }) {
  const bench = useBench();
  const now = useBenchTime();
  const piece = bench.pieces.find((item) => item.id === id);
  const [pack, setPack] = useState<PackName>("Entry");
  const [qty, setQty] = useState(1);

  if (!bench.ready) return <section className="section"><p className="pearl pad">Loading raffle.</p></section>;
  if (!piece) {
    return (
      <section className="section stack">
        <p className="kicker">Raffle unavailable</p>
        <h1 className="page-title">This raffle is not listed.</h1>
        <p className="lede">The website does not have an authoritative listing for this address.</p>
        <div className="btn-row">
          <Link className="btn" href="/">Back to explore</Link>
          <Link className="btn btn-dark" href="/guide">How it works</Link>
        </div>
      </section>
    );
  }

  const selected = piece.packs.find((item) => item.name === pack);
  const total = selected ? selected.priceUsdc * qty + LAB_FEE * qty : 0;
  const entries = selected ? selected.bonusEntries * qty : 0;
  const view = pieceView(piece, now);

  return (
    <>
      <div className="detail-path" data-reveal><Link href="/" className="detail-back"><span aria-hidden="true">←</span> Back to the collection</Link></div>
      <section className="section piece-layout piece-console">
        <figure className="piece-visual" data-reveal>
          <div className="piece-visual-topline"><span>LABx / Piece {piece.tokenId.padStart(2, "0")}</span></div>
          <div className="piece-artwork"><Image src={piece.image} alt={piece.imageAlt} width={1101} height={1101} unoptimized priority /></div>
          <figcaption className="piece-visual-caption"><span className="piece-escrow-status">{piece.escrowed ? "Escrowed" : "Awaiting escrow"}</span></figcaption>
        </figure>
        <div className="purchase-console" data-reveal>
          <header className="purchase-header">
            <div className="purchase-eyebrow"><p className="kicker">{piece.artist}</p><span className="piece-status">{view.status}</span></div>
            <h1 className="page-title">{piece.title}</h1>
            <p className="piece-deadline">{view.timing} · Sales close {closingDate(piece.salesEnd)} UTC</p>
            <Link className="guide-link" href="/guide#packs">Pack guide <span aria-hidden="true">↗</span></Link>
          </header>
          <section className="pack-selector" aria-labelledby="pack-title">
            <div className="console-section-heading"><div><h2 id="pack-title">Pick your pack</h2></div><span>Choose one</span></div>
            <div className="pack-keys" role="radiogroup" aria-label="Membership packs">
              {piece.packs.map((item) => <SquishyPackCard key={item.name} pack={item} feeUsdc={LAB_FEE} selected={item.name === pack} disabled onSelect={setPack} />)}
            </div>
          </section>
          <section className="order-panel" aria-labelledby="order-title">
            <div className="quantity-control">
              <label htmlFor="qty"><span id="order-title">Quantity</span><input id="qty" type="number" min={1} max={5} value={qty} onChange={(event) => setQty(Number(event.target.value))} disabled /></label>
              <span>1–5 packs</span>
            </div>
            <div className="order-total" aria-live="polite"><span>Total</span><strong>{total} <small>USDC</small></strong><p>Includes {LAB_FEE * qty} USDC fee · {entries} bonus {entries === 1 ? "entry" : "entries"}</p></div>
          </section>
          <OnChainStatus surface="piece" compact />
          <footer className="purchase-actions">
            <BookDemoButton className="record-pack-button" type="button" disabled>Purchasing unavailable</BookDemoButton>
            <Link className="hero-about" href={`/fairness#${piece.id}`}>Inspect fairness</Link>
          </footer>
          <p className="hash muted commitment-line">Commitment {piece.commit || "pending"}</p>
        </div>
      </section>
    </>
  );
}
