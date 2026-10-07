"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import BookDemoButton from "./pixel-perfect/book-demo-button";
import { OnChainStatus } from "@/components/OnChainStatus";
import { useBench } from "@/lib/bench";
import type { PackName } from "@/lib/seed";
import { formatUnits, parseUnits } from "viem";
import { buyerFee, BUYER_FEE_BPS, MIN_BUYER_FEE_USDC } from "@/lib/chain/fees";
import { formatUsdc } from "@/components/workflow/format";
import { closingDate, pieceView } from "@/lib/piece-view";
import { useBenchTime } from "@/lib/use-bench-time";
import SquishyPackCard from "@/components/ui/squishy-card-component";

export function PieceDesk({ id }: { id: string }) {
  const bench = useBench();
  const now = useBenchTime();
  const piece = bench.pieces.find((item) => item.id === id);
  const [pack, setPack] = useState<PackName>("Entry");
  const [qty, setQty] = useState(1);

  if (!bench.ready) return <section className="section state-section"><div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading raffle</strong><p>Checking the collection.</p></div></div></section>;
  if (!piece) {
    return (
      <section className="section stack missing-state">
        <h1 className="page-title">This raffle is not listed.</h1>
        <p className="lede">The website does not have an authoritative listing for this address.</p>
        <div className="btn-row">
          <Link className="btn" href="/">Back to explore</Link>
          <Link className="btn btn-dark" href="/guide">How it works</Link>
          <Link className="btn btn-lime" href="/membership">Membership packs</Link>
        </div>
      </section>
    );
  }

  const selected = piece.packs.find((item) => item.name === pack);
  const principal = selected ? parseUnits(String(selected.priceUsdc), 6) * BigInt(qty) : 0n;
  const fee = buyerFee(principal, BUYER_FEE_BPS, MIN_BUYER_FEE_USDC);
  const total = principal + fee;
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
              {piece.packs.map((item) => <SquishyPackCard key={item.name} pack={item} feeUsdc={Number(formatUnits(buyerFee(parseUnits(String(item.priceUsdc), 6), BUYER_FEE_BPS, MIN_BUYER_FEE_USDC), 6))} selected={item.name === pack} disabled onSelect={setPack} />)}
            </div>
          </section>
          <section className="order-panel" aria-labelledby="order-title">
            <div className="quantity-control">
              <label htmlFor="qty"><span id="order-title">Quantity</span><input id="qty" type="number" min={1} max={5} value={qty} onChange={(event) => setQty(Number(event.target.value))} disabled /></label>
              <span>1–5 packs</span>
            </div>
            <div className="order-total" aria-live="polite"><span>Total</span><strong>{formatUsdc(total)} <small>USDC</small></strong><p>{formatUsdc(principal)} USDC principal + {formatUsdc(fee)} USDC nonrefundable processing fee · {entries} bonus {entries === 1 ? "entry" : "entries"}</p></div>
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
