"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { BrowserService } from "@/lib/chain/ports";
import type { RaffleSnapshot } from "@/lib/chain/types";
import { formatDate, phaseLabel } from "./format";
import { useWalletSnapshot, WalletGate } from "./WalletGate";

type SellerState =
  | { kind: "idle" | "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; raffles: readonly RaffleSnapshot[] };

export function SellerDashboard({ browser, draftForm }: { browser: BrowserService; draftForm?: React.ReactNode }) {
  const wallet = useWalletSnapshot(browser.wallet);
  const [state, setState] = useState<SellerState>({ kind: "idle" });
  const request = useRef(0);

  async function load() {
    if (browser.kind !== "configured" || wallet.kind !== "connected") return;
    const version = ++request.current;
    setState({ kind: "loading" });
    try {
      const all: RaffleSnapshot[] = [];
      let cursor: bigint | undefined;
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page = await browser.service.listRaffles({ cursor, limit: 25 });
        all.push(...page.items.filter((item) => item.raffle.seller.toLowerCase() === wallet.account.toLowerCase()));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      if (version === request.current) setState({ kind: "ready", raffles: all });
    } catch (error) {
      if (version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "Seller raffles could not be loaded." });
    }
  }

  useEffect(() => {
    setState({ kind: "idle" });
    if (browser.kind === "configured" && wallet.kind === "connected") void load();
    return () => { request.current += 1; };
    // Wallet revision and runtime changes invalidate the seller portfolio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, wallet]);

  if (browser.kind === "unavailable") return <p className="notice warning" role="status">{browser.reason}</p>;
  return (
    <WalletGate wallet={browser.wallet}>
      <section className="workflow-grid seller-workspace">
        <article className="pearl pad stack">
          <div><p className="kicker">Your raffles</p><h2>Continue on-chain work</h2></div>
          {state.kind === "idle" || state.kind === "loading" ? <p className="notice" role="status">Loading seller raffles…</p> : null}
          {state.kind === "error" ? <div className="notice error stack" role="alert"><span>{state.message}</span><button className="btn btn-dark" type="button" onClick={() => void load()}>Retry</button></div> : null}
          {state.kind === "ready" && !state.raffles.length ? <p>No raffles owned by this wallet were found on the verified deployment.</p> : null}
          {state.kind === "ready" && state.raffles.length ? <ol className="seller-raffle-list">{state.raffles.map((snapshot) => <li key={snapshot.id.toString()}><div><strong>{snapshot.raffle.title}</strong><span>{phaseLabel(Number(snapshot.raffle.phase))} · closes {formatDate(snapshot.raffle.salesEnd)} UTC</span></div><Link className="btn btn-dark" href={`/piece/${snapshot.id.toString()}`}>Open workspace</Link></li>)}</ol> : null}
        </article>
        <article className="well pad stack">
          <div><p className="kicker">New raffle</p><h2>Prepare and review</h2></div>
          {draftForm ?? <><p>Creating a raffle is unavailable until the commitment recovery service is configured.</p><p className="notice warning" role="status">Do not place a private salt, seed or wallet secret into a public form.</p></>}
        </article>
      </section>
    </WalletGate>
  );
}
