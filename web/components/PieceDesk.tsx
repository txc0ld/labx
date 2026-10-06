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

export function PieceDesk({ id }: { id: string }) {
  const bench = useBench();
  const now = useBenchTime();
  const piece = bench.pieces.find((item) => item.id === id);
  const [pack, setPack] = useState<PackName>("Entry");
  const [qty, setQty] = useState(1);
  const [terms, setTerms] = useState(false);
  const [rules, setRules] = useState(false);
  const [age, setAge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = piece?.packs.find((item) => item.name === pack);
  const total = selected ? selected.priceUsdc * qty + LAB_FEE * qty : 0;
  const entries = selected ? selected.bonusEntries * qty : 0;
  const view = piece ? pieceView(piece, now) : null;
  const open = view?.isOpen ?? false;
  const available = !!selected && Number.isInteger(qty) && qty >= 1 && qty <= 5 && qty <= selected.remaining;

  if (!bench.ready) return <section className="section"><p className="pearl pad">Opening the bench.</p></section>;
  if (!piece) {
    return (
      <section className="section">
        <h1 className="page-title">Piece not on the bench</h1>
        <Link className="btn" href="/">Back to explore</Link>
      </section>
    );
  }
  const currentPiece = piece;

  function purchase() {
    const result = bench.buy({ pieceId: currentPiece.id, pack, qty, terms, rules, age });
    setError(result);
  }

  return (
    <>
    <div className="detail-path" data-reveal><Link href="/" className="detail-back"><span aria-hidden="true">←</span> Back to the collection</Link></div>
    <section className="section piece-layout piece-console">
      <figure className="piece-visual" data-reveal>
        <div className="piece-visual-topline">
          <span>LABx / Piece {piece.tokenId.padStart(2, "0")}</span>
        </div>
        <div className="piece-artwork">
          <Image src={piece.image} alt={piece.imageAlt} width={1101} height={1101} unoptimized priority />
        </div>
        <figcaption className="piece-visual-caption">
          <span className="piece-escrow-status">{piece.escrowed ? "Escrowed" : "Awaiting escrow"}</span>
        </figcaption>
      </figure>
      <div className="purchase-console" data-reveal>
        <header className="purchase-header">
          <div className="purchase-eyebrow">
            <p className="kicker">{piece.artist}</p>
            <span className="piece-status">{view?.status}</span>
          </div>
          <h1 className="page-title">{piece.title}</h1>
          <p className="piece-deadline">{view?.timing} · Sales close {closingDate(piece.salesEnd)} UTC</p>
          <Link className="guide-link" href="/guide#packs">Pack guide <span aria-hidden="true">↗</span></Link>
        </header>

        <section className="pack-selector" aria-labelledby="pack-title">
          <div className="console-section-heading">
            <div><h2 id="pack-title">Membership pack</h2></div>
            <span>Choose one</span>
          </div>
          <div className="pack-keys" role="radiogroup" aria-label="Membership packs">
            {piece.packs.map((item) => (
              <label
                key={item.name}
                className={`pack-key ${item.name === pack ? "on" : ""}`}
              >
                <input
                  className="sr"
                  type="radio"
                  name="membership-pack"
                  value={item.name}
                  checked={item.name === pack}
                  disabled={item.remaining < 1}
                  onChange={() => setPack(item.name)}
                />
                <span className="pack-check" aria-hidden="true" />
                <strong>{item.name}</strong>
                <span className="pack-price">{item.priceUsdc}<small> USDC</small></span>
                <span className="pack-entry-count">{item.bonusEntries} bonus {item.bonusEntries === 1 ? "entry" : "entries"}</span>
                <small>{item.remaining} remaining · +{LAB_FEE} USDC fee</small>
              </label>
            ))}
          </div>
        </section>

        <section className="order-panel" aria-labelledby="order-title">
          <div className="quantity-control">
            <label htmlFor="qty"><span id="order-title">Quantity</span>
              <input id="qty" type="number" min={1} max={5} value={qty} onChange={(event) => setQty(Number(event.target.value))} />
            </label>
            <span>1–5 packs</span>
          </div>
          <div className="order-total" aria-live="polite">
            <span>Total</span>
            <strong>{total} <small>USDC</small></strong>
            <p>Includes {LAB_FEE * qty} USDC fee · {entries} bonus {entries === 1 ? "entry" : "entries"}</p>
          </div>
        </section>

        <OnChainStatus surface="piece" compact />

        <section className="agreements-section" aria-labelledby="agreements-title">
          <div className="console-section-heading">
            <div><h2 id="agreements-title">Confirm eligibility</h2></div>
            <span>Required</span>
          </div>
          <fieldset className="agreements">
            <legend className="sr">Agreements</legend>
            <label htmlFor="terms">
              <input id="terms" type="checkbox" checked={terms} onChange={(event) => setTerms(event.target.checked)} />
              <span>I agree to the <Link href="/legal" onClick={(event) => event.stopPropagation()}>LABx membership terms</Link>.</span>
            </label>
            <label htmlFor="rules">
              <input id="rules" type="checkbox" checked={rules} onChange={(event) => setRules(event.target.checked)} />
              <span>I agree to the <Link href="/rules" onClick={(event) => event.stopPropagation()}>draw rules</Link> and the 12-month bonus entry expiry.</span>
            </label>
            <label htmlFor="age"><input id="age" type="checkbox" checked={age} onChange={(event) => setAge(event.target.checked)} /> I confirm I am eligible and I am 18 or older.</label>
          </fieldset>
        </section>

        {error ? <p className="notice error" role="alert">{error}</p> : null}
        {bench.banner ? <p className={`notice ${bench.banner.tone}`} role="status">{bench.banner.text}</p> : null}
        {!open ? <p className="notice warning">Packs are unavailable on this demo piece: {view?.status}.</p> : null}
        {open && !available ? <p className="notice warning">Choose an available pack and a whole quantity from 1 to 5 within its remaining supply.</p> : null}

        <footer className="purchase-actions">
          <BookDemoButton className="record-pack-button" type="button" disabled={!open || !available} onClick={purchase}>Record demo pack</BookDemoButton>
          <Link className="hero-about" href={`/fairness#${piece.id}`}>Inspect fairness</Link>
        </footer>
        <p className="hash muted commitment-line">Commitment {piece.commit || "pending"}</p>
      </div>
    </section>
    </>
  );
}
