"use client";

import Link from "next/link";
import { useBench } from "@/lib/bench";
import { catalogAvailability, shortAddress } from "./format";

export function FairnessRecords() {
  const bench = useBench();
  if (bench.catalog.kind === "loading") return <div className="state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading draw records</strong><p>Reading verified raffle state.</p></div></div>;
  if (bench.catalog.kind !== "ready") return <div className="stack"><h2>Draw records unavailable</h2><p className="notice warning" role="status">{bench.catalog.reason}</p><p>Nothing is shown until a verified deployment loads.</p><button className="btn btn-dark" type="button" onClick={() => void bench.refreshCatalog()}>Retry</button></div>;
  if (!bench.catalog.items.length) return <div className="stack"><h2>No raffle records</h2><p>The verified deployment has no raffles yet.</p><div className="btn-row"><Link className="btn" href="/">Explore</Link><Link className="btn btn-dark" href="/rules">Read draw rules</Link></div></div>;
  return <table><caption className="sr">Prize, LABx review, draw setup and draw status</caption><thead><tr><th scope="col">Raffle</th><th scope="col">Prize</th><th scope="col">LABx review</th><th scope="col">Draw setup</th><th scope="col">Entries counted</th><th scope="col">Outcome</th></tr></thead><tbody>{bench.catalog.items.map((snapshot) => <tr key={snapshot.id.toString()} id={snapshot.id.toString()}><td><Link href={`/piece/${snapshot.id.toString()}`}>{snapshot.raffle.title}</Link></td><td>{snapshot.raffle.escrowed ? "Locked" : "Not locked"}</td><td>{snapshot.admission.status === "pending" ? "Pending" : snapshot.admission.status === "changed" ? "Changed" : snapshot.admission.status === "approved" ? "Current draft approved" : snapshot.admission.status === "opened" ? "Approved at opening" : "Not recorded at opening"}</td><td className="hash">{snapshot.raffle.revealed ? shortAddress(snapshot.raffle.publicHash) : shortAddress(snapshot.raffle.reserveCommit)}</td><td>{snapshot.raffle.snapshotted ? snapshot.raffle.snapshotTotal.toString() : "Not counted yet"}</td><td>{Number(snapshot.raffle.phase) >= 4 && snapshot.raffle.winner !== "0x0000000000000000000000000000000000000000" ? shortAddress(snapshot.raffle.winner) : catalogAvailability(snapshot).label}</td></tr>)}</tbody></table>;
}
