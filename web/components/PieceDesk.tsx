"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { OnChainStatus } from "@/components/OnChainStatus";
import { useBench } from "@/lib/bench";
import { LAB_FEE, type PackName } from "@/lib/seed";

export function PieceDesk({ id }: { id: string }) {
  const bench = useBench();
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
  const open = useMemo(() => piece?.phase === "open", [piece]);

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
    <section className="section piece-layout">
      <div className="bezel">
        <div className="shot">
          <Image src={piece.image} alt={piece.imageAlt} width={1200} height={900} priority />
        </div>
      </div>
      <div className="pearl pad stack">
        <p className="kicker">{piece.artist}</p>
        <h1 className="page-title" style={{ fontSize: "clamp(2rem, 4vw, 3.4rem)" }}>{piece.title}</h1>
        <div className="btn-row">
          <span className={`lamp ${piece.escrowed ? "mint" : "pink"}`}><i /> {piece.escrowed ? "escrowed" : "awaiting escrow"}</span>
          <span className="lamp lavender"><i /> {piece.phase}</span>
        </div>
        <p className="lede">Choose a membership pack. Bonus entries are part of the pack. A {LAB_FEE} USDC lab fee on each pack goes to the treasury.</p>
        <div className="pack-keys" role="radiogroup" aria-label="Membership packs">
          {piece.packs.map((item) => (
            <button
              key={item.name}
              type="button"
              className={`pack-key ${item.name === pack ? "on" : ""}`}
              role="radio"
              aria-checked={item.name === pack}
              onClick={() => setPack(item.name)}
            >
              <strong>{item.name}</strong>
              <span>{item.priceUsdc} USDC</span>
              <small>{item.bonusEntries} bonus entries · {item.remaining} remaining</small>
              <small>+{LAB_FEE} USDC lab fee</small>
            </button>
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
        <p><strong>{total} USDC</strong> including {LAB_FEE * qty} USDC lab fee · {entries} bonus entries</p>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        {bench.banner ? <p className={`notice ${bench.banner.tone}`} role="status">{bench.banner.text}</p> : null}
        <div className="btn-row">
          <button className="btn btn-lime" type="button" disabled={!open} onClick={purchase}>Record pack</button>
          <Link className="btn btn-dark" href={`/fairness#${piece.id}`}>Fairness</Link>
        </div>
        {!open ? <p className="notice warning">Packs are closed on this piece.</p> : null}
        <p className="hash muted">Commitment {piece.commit || "pending"}</p>
      </div>
    </section>
  );
}
