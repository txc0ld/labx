"use client";

import { useBench } from "@/lib/bench";

export default function FairnessPage() {
  const { pieces, ready } = useBench();
  if (!ready) return <section className="section"><p className="pearl pad">Opening the bench.</p></section>;
  return (
    <section className="section">
      <p className="kicker">Fairness</p>
      <h1 className="page-title">Three locks on every draw.</h1>
      <div className="piece-grid" style={{ marginTop: "1rem" }}>
        <article className="pearl pad">
          <h2>Escrow</h2>
          <p>The piece moves into the contract before packs open. Settlement sends that same token to the drawn wallet.</p>
        </article>
        <article className="pearl pad">
          <h2>Commit</h2>
          <p>A private commitment is hashed on the server and stored on-chain. Public pages show the hash. The plaintext is not published.</p>
        </article>
        <article className="terminal pad">
          <h2 style={{ color: "#dbdbdb" }}>VRF</h2>
          <p>Sales close, then the entry snapshot freezes. Only then does the contract ask Chainlink VRF v2.5. Later entries miss the snapshot.</p>
        </article>
      </div>
      <div className="section table-wrap well pad">
        <table>
          <caption className="sr">Commitment and draw status</caption>
          <thead>
            <tr>
              <th scope="col">Piece</th>
              <th scope="col">Escrow</th>
              <th scope="col">Commit</th>
              <th scope="col">Snapshot</th>
              <th scope="col">Draw</th>
            </tr>
          </thead>
          <tbody>
            {pieces.map((piece) => (
              <tr key={piece.id} id={piece.id}>
                <td>{piece.title}</td>
                <td>{piece.escrowed ? "Held" : "Open"}</td>
                <td className="hash">{piece.revealed ? piece.publicSummary || piece.commit : piece.commit || "—"}</td>
                <td>{piece.snapshotTotal ?? "—"}</td>
                <td>{piece.winner || piece.phase}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
