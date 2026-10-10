"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import type { BrowserService } from "@/lib/chain/ports";
import type { BlockRef, HistoryItem } from "@/lib/chain/types";
import { buyerRaffleRow, type BuyerRaffleRow } from "./buyer-raffles";
import { useWalletSnapshot } from "./WalletGate";

type Continuation = { cursor: bigint; block: BlockRef };
type State =
  | { kind: "idle" | "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; purchases: readonly HistoryItem[]; rows: readonly BuyerRaffleRow[]; continuation: Continuation | null; loadingMore: boolean };

const HISTORY_PAGES_PER_LOAD = 10;

/** The connected wallet's raffles, from its confirmed purchases and current raffle reads. No signature is requested. */
export function BuyerRaffles({ browser }: { browser: BrowserService }) {
  const wallet = useWalletSnapshot(browser.wallet);
  const [state, setState] = useState<State>({ kind: "idle" });
  const request = useRef(0);
  const ready = browser.kind === "configured" && wallet.kind === "connected" && wallet.chainId === browser.service.manifest.chainId;

  async function load(previous?: Extract<State, { kind: "ready" }>) {
    if (browser.kind !== "configured" || wallet.kind !== "connected") return;
    const version = ++request.current;
    const account: Address = wallet.account;
    setState(previous ? { ...previous, loadingMore: true } : { kind: "loading" });
    try {
      const purchases = previous ? [...previous.purchases] : [];
      let fromBlock = previous?.continuation?.cursor;
      let block = previous?.continuation?.block;
      let continuation: Continuation | null = null;
      for (let page = 0; page < HISTORY_PAGES_PER_LOAD; page += 1) {
        const result = await browser.service.history({ account, fromBlock, block });
        purchases.push(...result.items.filter(item => item.event === "PackPurchased"));
        block = result.block;
        if (result.nextCursor === null) { continuation = null; break; }
        fromBlock = result.nextCursor;
        continuation = { cursor: result.nextCursor, block };
      }
      const byRaffle = new Map<bigint, HistoryItem[]>();
      for (const purchase of purchases) byRaffle.set(purchase.raffleId, [...byRaffle.get(purchase.raffleId) ?? [], purchase]);
      const accounts = await Promise.all([...byRaffle.keys()].map(id => browser.service.readAccount({ id, account, block })));
      if (version !== request.current) return;
      const latest = (id: bigint) => Math.max(...(byRaffle.get(id) ?? []).map(purchase => Number(purchase.blockNumber)));
      const rows = accounts.map(item => buyerRaffleRow(byRaffle.get(item.snapshot.id) ?? [], item)).sort((a, b) => latest(b.id) - latest(a.id));
      setState({ kind: "ready", purchases, rows, continuation, loadingMore: false });
    } catch (error) {
      if (version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "Your raffles couldn't be loaded." });
    }
  }

  useEffect(() => {
    setState({ kind: "idle" });
    if (ready) void load();
    return () => { request.current += 1; };
    // Wallet revision and runtime changes invalidate earlier reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, wallet, ready]);

  if (browser.kind !== "configured") return null;
  return (
    <section className="pearl pad stack" aria-labelledby="buyer-raffles-title">
      <h2 id="buyer-raffles-title">Your raffles</h2>
      {!ready ? <p>{wallet.kind === "connected" ? "Switch networks in your wallet to see your raffles." : "Connect your wallet to see your raffles."}</p> : null}
      {ready && (state.kind === "idle" || state.kind === "loading") ? <p role="status">Loading your raffles…</p> : null}
      {state.kind === "error" ? <div className="notice error stack" role="alert"><span>{state.message}</span><button className="btn btn-dark" type="button" onClick={() => void load()}>Try again</button></div> : null}
      {state.kind === "ready" && !state.rows.length ? <p>{state.continuation ? "No raffles found yet." : "No raffles yet."} <Link className="text-link" href="/">Browse raffles</Link></p> : null}
      {state.kind === "ready" && state.rows.length ? <ol className="private-record-list">{state.rows.map(item => (
        <li key={item.id.toString()}>
          <div><strong><Link href={`/piece/${item.id.toString()}`}>{item.title}</Link></strong><span>{item.status}</span></div>
          <span>{item.memberships} · {item.entries} {item.entries === 1 ? "entry" : "entries"}</span>
          {item.action ? <Link className="btn" href={`/piece/${item.id.toString()}`}>{item.action}</Link> : null}
        </li>
      ))}</ol> : null}
      {state.kind === "ready" && state.continuation ? <button className="btn btn-dark" type="button" disabled={state.loadingMore} onClick={() => void load(state)}>{state.loadingMore ? "Loading…" : "Load more"}</button> : null}
    </section>
  );
}
