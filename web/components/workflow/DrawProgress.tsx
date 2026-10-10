"use client";
import { useEffect, useRef, useState } from "react";
import { zeroAddress } from "viem";
import type { RaffleService } from "@/lib/chain/ports";
import type { Lot, RaffleSnapshot } from "@/lib/chain/types";
import { formatDate } from "./format";

export function DrawProgress({ service, snapshot }: { service: RaffleService; snapshot: RaffleSnapshot }) {
  const [lots, setLots] = useState<readonly Lot[]>([]);
  const [cursor, setCursor] = useState<bigint | null>(0n);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0), busy = useRef(false);
  useEffect(() => { generation.current += 1; setLots([]); setCursor(0n); setLoading(false); setError(""); }, [snapshot.id, snapshot.block.hash]);
  async function load() {
    if (busy.current || cursor === null) return;
    busy.current = true; setLoading(true); setError(""); const version = generation.current;
    try {
      const page = await service.listLots({ id: snapshot.id, cursor, limit: 25, block: snapshot.block });
      if (version === generation.current) { setLots(current => [...current, ...page.items]); setCursor(page.nextCursor); }
    } catch (error) { if (version === generation.current) setError(error instanceof Error ? error.message : "Entry records are unavailable."); }
    finally { busy.current = false; if (version === generation.current) setLoading(false); }
  }
  const r = snapshot.raffle;
  const deadline = (value: bigint) => <>{formatDate(value)} UTC · {snapshot.block.timestamp >= value ? "Reached" : "Upcoming"}</>;
  return <section className="well pad stack" aria-labelledby="draw-progress-title"><h2 id="draw-progress-title">Draw progress</h2><dl className="review-list">
    <div><dt>Sales close</dt><dd>{deadline(r.salesEnd)}</dd></div>
    {(r.phase === 1 || r.phase === 2) && <div><dt>Draw-start recovery</dt><dd>{deadline(r.salesEnd + snapshot.drawStartGrace)}</dd></div>}
    {r.phase >= 2 && (r.phase !== 6 || r.snapshotted || r.lotCursor > 0n) && <><div><dt>Snapshot progress</dt><dd>{r.lotCursor.toString()} / {snapshot.lotCount.toString()} lots processed{r.snapshotted ? " · Complete" : r.phase === 6 ? " · Stopped at cancellation" : " · In progress"}</dd></div><div><dt>Eligible bonus entries</dt><dd>{r.snapshotTotal.toString()}{!r.snapshotted && r.phase !== 6 ? " so far" : ""}</dd></div></>}
    {r.phase === 3 && <div><dt>Randomness cutoff</dt><dd>{deadline(r.vrfRequestedAt + snapshot.randomnessGrace)}</dd></div>}
    {r.phase === 4 && <div><dt>Settlement without reveal</dt><dd>{deadline(r.drawnAt + snapshot.revealGrace)}</dd></div>}
    {r.winner !== zeroAddress && <div><dt>Drawn wallet</dt><dd className="hash">{r.winner}</dd></div>}
    <div><dt>Commitment</dt><dd>{r.revealed ? "Revealed" : "Not revealed"}</dd></div>
  </dl><p className="muted">The commitment proves matching hashes. It does not enforce a monetary reserve or minimum sale price. Deadlines are shown at block {snapshot.block.number.toString()}; refresh for current availability.</p>
    <details className="workflow-details"><summary>Inspect bonus-entry records ({snapshot.lotCount.toString()} lots)</summary><p>Each row is an on-chain lot. The snapshot determines eligible draw weight; expired lots may contribute no weight.</p>
      {lots.length > 0 && <ol className="private-record-list">{lots.map((lot, index) => <li key={index}><strong>Lot #{index + 1} · {lot.amount} bonus entries</strong><span className="hash">{lot.owner}</span><span>Expires {formatDate(lot.expiresAt)} UTC</span></li>)}</ol>}
      {cursor !== null ? <button className="btn btn-dark" type="button" disabled={loading} onClick={() => void load()}>{loading ? "Loading entries…" : lots.length ? "Load next 25 lots" : "Load entry records"}</button> : <p>{lots.length ? "All lots at this block are shown." : "No entry lots recorded."}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </details>
  </section>;
}
