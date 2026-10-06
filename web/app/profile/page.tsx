"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { OnChainStatus } from "@/components/OnChainStatus";
import { useBench } from "@/lib/bench";

type PointsState =
  | { status: "idle" | "loading" }
  | { status: "ready"; balance: number }
  | { status: "error"; message: string };

export default function ProfilePage() {
  const bench = useBench();
  const [points, setPoints] = useState<PointsState>({ status: "idle" });
  const [email, setEmail] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (bench.ready) setEmail(bench.email);
  }, [bench.email, bench.ready]);

  const loadPoints = useCallback(async () => {
    if (!bench.wallet) {
      setPoints({ status: "idle" });
      return;
    }
    setPoints({ status: "loading" });
    try {
      const response = await fetch(`/api/points?address=${bench.wallet}`);
      const body = await response.json() as { balance?: unknown; error?: unknown };
      if (!response.ok || typeof body.balance !== "number" || !Number.isFinite(body.balance)) {
        throw new Error(typeof body.error === "string" ? body.error : "Points are unavailable.");
      }
      setPoints({ status: "ready", balance: body.balance });
    } catch (error) {
      setPoints({ status: "error", message: error instanceof Error ? error.message : "Points are unavailable." });
    }
  }, [bench.wallet]);

  useEffect(() => {
    void loadPoints();
  }, [loadPoints]);

  if (!bench.ready) return <section className="section"><p className="pearl pad">Loading profile.</p></section>;

  function savePreference(event: FormEvent) {
    event.preventDefault();
    setNote(bench.saveEmail(email));
  }

  return (
    <section className="section split">
      <div className="pearl pad stack">
        <p className="kicker">Profile</p>
        <h1 className="page-title" style={{ fontSize: "clamp(2rem, 4vw, 3.4rem)" }}>Your bench</h1>
        <div className="terminal pad">
          <div>wallet {bench.wallet || "not connected"}</div>
          <div>
            points {points.status === "ready" ? points.balance : points.status === "loading" ? "loading" : points.status === "error" ? "unavailable" : "connect wallet"}
          </div>
          <div>chain sepolia</div>
        </div>
        <OnChainStatus surface="profile" />
        <p className="muted">Points come from the lab bot check-in. They are not for sale. The website does not hold the bot token.</p>
        <div className="btn-row">
          <button className="btn" type="button" onClick={() => bench.connect()}>Connect Sepolia</button>
          {points.status === "error" ? <button className="btn btn-dark" type="button" onClick={() => void loadPoints()}>Retry points</button> : null}
        </div>
        {points.status === "error" ? <p className="notice error" role="alert">{points.message}</p> : null}
        {bench.banner ? <p className={`notice ${bench.banner.tone}`} role="status">{bench.banner.text}</p> : null}
        <form className="stack" onSubmit={savePreference}>
          <label htmlFor="email">Email preference
            <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <p className="muted">This address is stored only in this browser. Purchase receipts are unavailable until verified purchase history is connected. See the <Link href="/privacy">privacy policy</Link>.</p>
          <button className="btn btn-lime" type="submit">Save email in this browser</button>
          {note ? <p className="notice warning" role="status">{note}</p> : null}
        </form>
      </div>
      <div className="stack">
        <div className="well pad">
          <h2>Bonus entries</h2>
          <p>Entry history is unavailable because the website is not connected to an authoritative raffle source.</p>
        </div>
        <div className="pearl pad">
          <h2>Agreements</h2>
          <p className="muted">Agreement history is unavailable.</p>
        </div>
      </div>
    </section>
  );
}
