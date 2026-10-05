"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { LegalNav } from "@/components/LegalNav";
import { OnChainStatus } from "@/components/OnChainStatus";
import { useBench } from "@/lib/bench";
import { onChainReady } from "@/lib/wallet";

export default function RulesPage() {
  const bench = useBench();
  const [pieceId, setPieceId] = useState(bench.pieces[0]?.id || "");
  const [challenge, setChallenge] = useState<{ id: string; prompt: string; expiresAt: number; mac: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [terms, setTerms] = useState(false);
  const [rules, setRules] = useState(false);
  const [age, setAge] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"warning" | "error" | "ok">("warning");
  const [raffleId, setRaffleId] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const wired = onChainReady();
  if (!bench.ready) return <section className="section"><p className="pearl pad">Opening the bench.</p></section>;

  async function loadChallenge() {
    const response = await fetch("/api/amoe/challenge", { method: "POST" });
    const body = await response.json();
    if (!response.ok) {
      setTone("error");
      setMessage(body.error || "Challenge unavailable.");
      return;
    }
    setChallenge(body);
    setMessage(null);
  }

  async function claim(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    const response = await fetch("/api/amoe/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: bench.address,
        pieceId,
        raffleId: raffleId.trim() || undefined,
        terms,
        rules,
        age,
        ...challenge,
        answer
      })
    });
    const body = await response.json();
    if (!response.ok) {
      setTone("error");
      setMessage(body.error || "Request refused.");
      return;
    }
    bench.recordComplimentary(pieceId);
    setSignature(typeof body.signature === "string" ? body.signature : null);
    setTone("ok");
    setMessage(body.mode === "signed" ? "Complimentary entry signed. Submit it with the raffle." : "Complimentary entry recorded.");
  }

  return (
    <section className="section stack">
      <p className="kicker">Draw rules</p>
      <h1 className="page-title">How a piece is drawn.</h1>
      <LegalNav />
      <OnChainStatus surface="rules" />
      <article className="pearl pad stack">
        <p>Packs are memberships. Each pack includes a published number of bonus entries into that piece only.</p>
        <p>Entries expire 12 months after they are recorded. Expired entries are left out of the snapshot.</p>
        <p>The snapshot is taken before randomness is requested. Chainlink VRF v2.5 supplies the word used to walk the frozen weights.</p>
        <p>The lab fee is 5 USDC per pack. Settlement (`settle`) flips the piece to the settled phase. The drawn wallet claims the prize with `claimPrize`. The seller claims pack proceeds with `claimProceeds`. The treasury claims the lab fee with `claimFee`. Pack price and fee are refunded if the piece is cancelled before settlement.</p>
      </article>
      <article className="well pad stack">
        <h2>Complimentary entry</h2>
        <p>One complimentary bonus entry is available per person per piece after a bot check-in and this captcha. It is not shown on the explore bench.</p>
        <form className="stack" onSubmit={claim}>
          <label htmlFor="piece">Piece
            <select id="piece" value={pieceId} onChange={(event) => setPieceId(event.target.value)}>
              {bench.pieces.map((piece) => (
                <option key={piece.id} value={piece.id}>{piece.title}</option>
              ))}
            </select>
          </label>
          {wired ? (
            <label htmlFor="raffle">On-chain raffle id
              <input id="raffle" inputMode="numeric" value={raffleId} onChange={(event) => setRaffleId(event.target.value)} />
            </label>
          ) : (
            <p className="muted">On-chain raffle id stays off until the Sepolia contract is wired.</p>
          )}
          <button className="btn btn-dark" type="button" onClick={loadChallenge}>Start captcha</button>
          {challenge ? (
            <label htmlFor="answer">{challenge.prompt}
              <input id="answer" inputMode="numeric" value={answer} onChange={(event) => setAnswer(event.target.value)} required />
            </label>
          ) : null}
          <label htmlFor="c-terms">
            <input id="c-terms" type="checkbox" checked={terms} onChange={(event) => setTerms(event.target.checked)} />
            <span>I agree to the <Link href="/legal" onClick={(event) => event.stopPropagation()}>membership terms</Link>.</span>
          </label>
          <label htmlFor="c-rules">
            <input id="c-rules" type="checkbox" checked={rules} onChange={(event) => setRules(event.target.checked)} />
            <span>I agree to the draw rules and the 12-month expiry.</span>
          </label>
          <label htmlFor="c-age"><input id="c-age" type="checkbox" checked={age} onChange={(event) => setAge(event.target.checked)} /> I am 18 or older and eligible to participate.</label>
          <button className="btn btn-lime" type="submit" disabled={!challenge}>Submit complimentary entry</button>
          {message ? <p className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}>{message}</p> : null}
          {signature ? <p className="hash">{signature}</p> : null}
        </form>
      </article>
    </section>
  );
}
