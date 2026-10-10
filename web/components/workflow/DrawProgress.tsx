"use client";
import { useEffect, useRef, useState } from "react";
import { zeroAddress } from "viem";
import type { RaffleService } from "@/lib/chain/ports";
import type { Lot, RaffleSnapshot } from "@/lib/chain/types";
import { formatDate } from "./format";

const plural = (count: bigint | number, one: string, many: string) => `${count.toString()} ${count.toString() === "1" ? one : many}`;

/** Closed "Draw details" disclosure: deadlines, counting progress, winner and per-purchase entry records. */
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
  return <details className="workflow-details"><summary>Draw details</summary><section className="stack draw-details" aria-label="Draw details"><dl className="review-list">
    <div><dt>Sales end</dt><dd>{deadline(r.salesEnd)}</dd></div>
    {(r.phase === 1 || r.phase === 2) && <div><dt>Refunds open if the draw hasn’t started by</dt><dd>{deadline(r.salesEnd + snapshot.drawStartGrace)}</dd></div>}
    {r.phase >= 2 && (r.phase !== 6 || r.snapshotted || r.lotCursor > 0n) && <><div><dt>Entries counted</dt><dd>{r.lotCursor.toString()} of {plural(snapshot.lotCount, "purchase", "purchases")}{r.snapshotted ? " · Complete" : r.phase === 6 ? " · Stopped at cancellation" : " · In progress"}</dd></div><div><dt>Entries in the draw</dt><dd>{r.snapshotTotal.toString()}{!r.snapshotted && r.phase !== 6 ? " so far" : ""}</dd></div></>}
    {r.phase === 3 && <div><dt>Draw result due by</dt><dd>{deadline(r.vrfRequestedAt + snapshot.randomnessGrace)}</dd></div>}
    {r.phase === 4 && <div><dt>Can finish without the seller from</dt><dd>{deadline(r.drawnAt + snapshot.revealGrace)}</dd></div>}
    {r.winner !== zeroAddress && <div><dt>Winner</dt><dd className="hash">{r.winner}</dd></div>}
    <div><dt>Draw setup</dt><dd>{r.revealed ? "Confirmed by the seller" : "Not confirmed yet"}</dd></div>
  </dl><p className="muted">The draw setup proves the seller’s saved values match. It does not set a reserve or minimum price. Shown as of block {snapshot.block.number.toString()}.</p>
    <details className="workflow-details"><summary>Entry records ({plural(snapshot.lotCount, "purchase", "purchases")})</summary><p>Each row is one purchase. Expired purchases may not count in the draw.</p>
      {lots.length > 0 && <ol className="private-record-list">{lots.map((lot, index) => <li key={index}><strong>Purchase #{index + 1} · {plural(lot.amount, "entry", "entries")}</strong><span className="hash">{lot.owner}</span><span>Expires {formatDate(lot.expiresAt)} UTC</span></li>)}</ol>}
      {cursor !== null ? <button className="btn btn-dark" type="button" disabled={loading} onClick={() => void load()}>{loading ? "Loading entries…" : lots.length ? "Load next 25" : "Load entry records"}</button> : <p>{lots.length ? "All purchases at this block are shown." : "No purchases recorded."}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </details>
  </section></details>;
}
