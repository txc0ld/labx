"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
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

  function purchase() {
    const result = bench.buy({ pieceId: piece!.id, pack, qty, terms, rules, age });
    setError(result);
  }

  return (
    <>
    <div className="detail-path"><Link href="/" className="detail-back"><span aria-hidden="true">←</span> Back to the bench</Link><span className="kicker">Demo piece console</span></div>
    <section className="section piece-layout">
      <div className="bezel">
        <div className="shot piece-artwork">
          <Image src={piece.image} alt={piece.imageAlt} width={1101} height={1101} unoptimized priority />
        </div>
      </div>
      <div className="pearl pad stack">
        <p className="kicker">{piece.artist}</p>
        <h1 className="page-title" style={{ fontSize: "clamp(2rem, 4vw, 3.4rem)" }}>{piece.title}</h1>
        <div className="btn-row">
          <span className={`lamp ${piece.escrowed ? "mint" : "pink"}`}><i /> {piece.escrowed ? "escrowed" : "awaiting escrow"}</span>
          <span className="lamp lavender"><i /> {view?.status}</span>
        </div>
        <p className="piece-deadline">{view?.timing} · Sales close {closingDate(piece.salesEnd)} UTC</p>
        <p className="lede">Choose a membership pack. Bonus entries are part of the pack. A {LAB_FEE} USDC lab fee on each pack goes to the treasury.</p>
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
              <strong>{item.name}</strong>
              <span>{item.priceUsdc} USDC</span>
              <small>{item.bonusEntries} bonus {item.bonusEntries === 1 ? "entry" : "entries"} · {item.remaining} remaining</small>
              <small>+{LAB_FEE} USDC lab fee</small>
            </label>
          ))}
        </div>
        <label htmlFor="qty">Quantity
          <input id="qty" type="number" min={1} max={5} value={qty} onChange={(event) => setQty(Number(event.target.value))} />
        </label>
        <OnChainStatus surface="piece" />
        <fieldset className="agreements well">
          <legend className="kicker">Agreements</legend>
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
        <p><strong>{total} USDC</strong> including {LAB_FEE * qty} USDC lab fee · {entries} bonus {entries === 1 ? "entry" : "entries"}</p>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        {bench.banner ? <p className={`notice ${bench.banner.tone}`} role="status">{bench.banner.text}</p> : null}
        <div className="btn-row">
          <button className="btn btn-lime" type="button" disabled={!open || !available} onClick={purchase}>Record demo pack</button>
          <Link className="btn btn-dark" href={`/fairness#${piece.id}`}>Fairness</Link>
        </div>
        {!open ? <p className="notice warning">Packs are unavailable on this demo piece: {view?.status}.</p> : null}
        {open && !available ? <p className="notice warning">Choose an available pack and a whole quantity from 1 to 5 within its remaining supply.</p> : null}
        <p className="hash muted">Commitment {piece.commit || "pending"}</p>
      </div>
    </section>
    </>
  );
}
