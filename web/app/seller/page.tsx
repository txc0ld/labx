"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";
import { useBench } from "@/lib/bench";

export default function SellerPage() {
  const bench = useBench();
  const [title, setTitle] = useState("");
  const [publicSummary, setPublicSummary] = useState("The escrowed piece is the prize.");
  const [privateCommitment, setPrivateCommitment] = useState("");
  const [salesEnd, setSalesEnd] = useState("2027-08-01");
  const [nft, setNft] = useState("0x000000000000000000000000000000000000a11c");
  const [tokenId, setTokenId] = useState("1");
  const [error, setError] = useState<string | null>(null);
  if (!bench.ready) return <section className="section"><p className="pearl pad">Opening the bench.</p></section>;

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    const result = await bench.createPiece({
      title,
      publicSummary,
      privateCommitment,
      salesEnd: new Date(salesEnd).toISOString(),
      nft,
      tokenId
    });
    setError(result);
    if (!result) setPrivateCommitment("");
  }

  return (
    <section className="section">
      <p className="kicker">Studio</p>
      <h1 className="page-title">Build a piece.</h1>
      <div className="split" style={{ marginTop: "1rem" }}>
        <form className="pearl pad stack" onSubmit={onCreate}>
          <label htmlFor="title">Piece title
            <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label htmlFor="summary">Public summary
            <textarea id="summary" value={publicSummary} onChange={(event) => setPublicSummary(event.target.value)} />
          </label>
          <label htmlFor="private">Private commitment
            <textarea id="private" value={privateCommitment} autoComplete="off" onChange={(event) => setPrivateCommitment(event.target.value)} required />
          </label>
          <p className="muted">The private commitment is hashed and stored off the public pages. The bench shows the hash only.</p>
          <label htmlFor="end">Sales end
            <input id="end" type="date" value={salesEnd} onChange={(event) => setSalesEnd(event.target.value)} required />
          </label>
          <label htmlFor="nft">Prize contract
            <input id="nft" value={nft} onChange={(event) => setNft(event.target.value)} />
          </label>
          <label htmlFor="token">Token id
            <input id="token" value={tokenId} onChange={(event) => setTokenId(event.target.value)} />
          </label>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
          {bench.banner ? <p className={`notice ${bench.banner.tone}`} role="status">{bench.banner.text}</p> : null}
          <button className="btn" type="submit">Commit and create</button>
        </form>
        <div className="bezel">
          <Image src="/lab/filter-panel.jpg" alt="Glossy filter panel used as the studio console" width={900} height={675} />
        </div>
      </div>
      <div className="section stack">
        <h2>Your bench</h2>
        {bench.pieces.map((piece) => (
          <article key={piece.id} className="pearl pad stack">
            <div className="btn-row">
              <h3 style={{ margin: 0 }}>{piece.title}</h3>
              <span className="lamp lavender"><i /> {piece.phase}</span>
              <span className={`lamp ${piece.escrowed ? "mint" : "pink"}`}><i /> {piece.escrowed ? "escrowed" : "not escrowed"}</span>
            </div>
            <p className="hash">{piece.commit || "No commitment yet"}</p>
            <div className="btn-row">
              {(["escrow", "open", "close", "snapshot", "draw", "reveal", "settle", "cancel", "claim"] as const).map((action) => (
                <button key={action} className="btn btn-dark" type="button" onClick={() => setError(bench.mark(piece.id, action))}>
                  {action}
                </button>
              ))}
            </div>
            {piece.winner ? <p>Demonstration result {piece.winner}</p> : null}
            {piece.vrfNote ? <p className="muted">{piece.vrfNote}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
