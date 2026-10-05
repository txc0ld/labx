"use client";

import { useState, type FormEvent } from "react";
import { useBench } from "@/lib/bench";

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
    setTone("ok");
    setMessage("Complimentary entry recorded.");
  }

  return (
    <section className="section stack">
      <p className="kicker">Draw rules</p>
      <h1 className="page-title">How a piece is drawn.</h1>
      <article className="pearl pad stack">
        <p>Packs are memberships. Each pack includes a published number of bonus entries into that piece only.</p>
        <p>Entries expire 12 months after they are recorded. Expired entries are left out of the snapshot.</p>
        <p>The snapshot is taken before randomness is requested. Chainlink VRF v2.5 supplies the word used to walk the frozen weights.</p>
        <p>The lab fee is 5 USDC per pack, paid to the Safe treasury on settlement. Pack price and fee are refunded if the piece is cancelled before settlement.</p>
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
          <button className="btn btn-dark" type="button" onClick={loadChallenge}>Start captcha</button>
          {challenge ? (
            <label htmlFor="answer">{challenge.prompt}
              <input id="answer" inputMode="numeric" value={answer} onChange={(event) => setAnswer(event.target.value)} required />
            </label>
          ) : null}
          <label htmlFor="c-terms"><input id="c-terms" type="checkbox" checked={terms} onChange={(event) => setTerms(event.target.checked)} /> I agree to the membership terms.</label>
          <label htmlFor="c-rules"><input id="c-rules" type="checkbox" checked={rules} onChange={(event) => setRules(event.target.checked)} /> I agree to the draw rules and the 12-month expiry.</label>
          <label htmlFor="c-age"><input id="c-age" type="checkbox" checked={age} onChange={(event) => setAge(event.target.checked)} /> I am 18 or older and eligible to participate.</label>
          <button className="btn btn-lime" type="submit" disabled={!challenge}>Submit complimentary entry</button>
          {message ? <p className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}>{message}</p> : null}
        </form>
      </article>
    </section>
  );
}
