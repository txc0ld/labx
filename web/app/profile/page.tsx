"use client";

import { useEffect, useState } from "react";
import { useBench } from "@/lib/bench";

export default function ProfilePage() {
  const bench = useBench();
  const [points, setPoints] = useState(0);
  const [email, setEmail] = useState(bench.email);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!bench.address) return;
    fetch(`/api/points?address=${bench.address}`)
      .then((response) => response.json())
      .then((body) => setPoints(body.balance || 0))
      .catch(() => setPoints(0));
  }, [bench.address]);

  if (!bench.ready) return <section className="section"><p className="pearl pad">Opening the bench.</p></section>;
  const mine = bench.entries.filter((entry) => entry.address.toLowerCase() === bench.address.toLowerCase());

  return (
    <section className="section split">
      <div className="pearl pad stack">
        <p className="kicker">Profile</p>
        <h1 className="page-title" style={{ fontSize: "clamp(2rem, 4vw, 3.4rem)" }}>Your bench card</h1>
        <div className="terminal pad">
          <div>wallet {bench.wallet || "bench default"}</div>
          <div>points {points}</div>
          <div>chain sepolia</div>
        </div>
        <p className="muted">Points come from the lab bot check-in. They are not for sale. The website does not hold the bot token.</p>
        <div className="btn-row">
          <button className="btn" type="button" onClick={() => bench.connect()}>Connect Sepolia</button>
          <button className="btn btn-dark" type="button" onClick={() => bench.useBenchWallet()}>Use bench wallet</button>
        </div>
        {bench.banner ? <p className={`notice ${bench.banner.tone}`} role="status">{bench.banner.text}</p> : null}
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            const latest = mine[0];
            const result = await bench.saveEmail(email, latest?.pieceTitle || "LABx", latest?.label || "Entry", latest?.count || 0, 25);
            setNote(result || "Receipt request finished.");
          }}
        >
          <label htmlFor="email">Receipt email
            <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <button className="btn btn-lime" type="submit">Send receipt</button>
          {note ? <p className="notice warning" role="status">{note}</p> : null}
        </form>
      </div>
      <div className="stack">
        <div className="well pad">
          <h2>Bonus entries</h2>
          {mine.length === 0 ? <p>No entries on this wallet yet.</p> : (
            <div className="table-wrap">
              <table>
                <caption className="sr">Bonus entries and expiry</caption>
                <thead>
                  <tr><th scope="col">Piece</th><th scope="col">Pack</th><th scope="col">Entries</th><th scope="col">Expires</th></tr>
                </thead>
                <tbody>
                  {mine.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.pieceTitle}</td>
                      <td>{entry.label}</td>
                      <td>{entry.count}</td>
                      <td>{new Date(entry.expiresAt).toLocaleDateString("en-AU")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="pearl pad">
          <h2>Agreements</h2>
          {bench.agreements.length === 0 ? <p className="muted">None recorded in this browser yet.</p> : (
            <ul>
              {bench.agreements.map((item) => (
                <li key={item.at}>{item.pieceId} · {new Date(item.at).toLocaleString("en-AU")}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
