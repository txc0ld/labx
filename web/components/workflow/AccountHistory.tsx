"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { BrowserService } from "@/lib/chain/ports";
import type { BlockRef, HistoryItem } from "@/lib/chain/types";
import { formatUsdcAmount } from "./usdc-amount";
import { useWalletSnapshot, WalletGate } from "./WalletGate";

type HistoryState =
  | { kind: "idle" | "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: readonly HistoryItem[]; nextCursor: bigint | null; loadingMore: boolean; block: BlockRef };

const EVENT_COPY: Record<HistoryItem["event"], { title: string; detail: string }> = {
  PackPurchased: { title: "Membership purchased", detail: "Membership price + processing fee" },
  PrizeClaimed: { title: "Prize claimed", detail: "NFT sent to the winner" },
  ProceedsClaimed: { title: "Proceeds claimed", detail: "Membership sales paid to the seller" },
  FeeClaimed: { title: "LABx fees paid out", detail: "Processing fees and any seller fee sent to LABx" },
  Refunded: { title: "Refund received", detail: "Membership price refunded; processing fee not refunded" },
  PrizeReclaimed: { title: "Prize reclaimed", detail: "NFT returned to the seller after cancellation" }
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function AccountHistory({ browser, loading = false }: { browser: BrowserService; loading?: boolean }) {
  const wallet = useWalletSnapshot(browser.wallet);
  const [state, setState] = useState<HistoryState>({ kind: "idle" });
  const request = useRef(0);

  async function load(fromBlock?: bigint) {
    if (browser.kind !== "configured" || wallet.kind !== "connected") return;
    const version = ++request.current;
    if (fromBlock === undefined) setState({ kind: "loading" });
    else setState((current) => current.kind === "ready" ? { ...current, loadingMore: true } : current);
    try {
      const page = await browser.service.history({ account: wallet.account, fromBlock, block: fromBlock !== undefined && state.kind === "ready" ? state.block : undefined });
      if (version !== request.current) return;
      setState((current) => ({
        kind: "ready",
        items: fromBlock !== undefined && current.kind === "ready" ? [...current.items, ...page.items] : page.items,
        nextCursor: page.nextCursor,
        loadingMore: false, block: page.block
      }));
    } catch (error) {
      if (version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "History could not be loaded." });
    }
  }

  useEffect(() => {
    setState({ kind: "idle" });
    if (browser.kind === "configured" && wallet.kind === "connected") void load();
    return () => { request.current += 1; };
    // Wallet revision and runtime changes invalidate prior account history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, wallet]);

  if (loading) return <p className="notice" role="status">Loading your activity…</p>;
  if (browser.kind === "unavailable") return <div className="notice warning" role="status">{browser.reason}</div>;
  return (
    <WalletGate wallet={browser.wallet}>
      {state.kind === "idle" || state.kind === "loading" ? <p className="notice" role="status">Loading your activity…</p> : null}
      {state.kind === "error" ? <div className="notice error stack" role="alert"><span>{state.message}</span><button className="btn btn-dark" type="button" onClick={() => void load()}>Try again</button></div> : null}
      {state.kind === "ready" && !state.items.length ? <div className="well pad stack"><h2>{state.nextCursor !== null ? "No activity found yet" : "No activity yet"}</h2><Link className="btn btn-dark" href="/">Browse raffles</Link></div> : null}
      {state.kind === "ready" && state.items.length ? (
        <div className="stack">
          <ol className="history-list">
            {state.items.map((item) => {
              const copy = EVENT_COPY[item.event];
              return <li key={`${item.transactionHash}-${item.logIndex}`}><div><strong>{copy.title}</strong><p>{copy.detail}</p></div><dl><div><dt>Raffle</dt><dd><Link href={`/piece/${item.raffleId.toString()}`}>#{item.raffleId.toString()}</Link></dd></div><div><dt>Amount</dt><dd>{formatUsdcAmount(item.principal + item.fee)} USDC</dd></div>{item.event === "PackPurchased" ? <div><dt>Memberships</dt><dd>{plural(item.quantity, "membership", "memberships")} · {plural(item.bonusEntries, "bonus entry", "bonus entries")}</dd></div> : null}</dl><details><summary>Transaction details</summary><p>Block {item.blockNumber.toString()}</p><p className="hash">{item.transactionHash}</p></details></li>;
            })}
          </ol>
        </div>
      ) : null}
      {state.kind === "ready" && state.nextCursor !== null ? <div className="stack"><p className="muted">Newer activity isn’t shown yet.</p><button className="btn load-more" type="button" disabled={state.loadingMore} onClick={() => void load(state.nextCursor ?? undefined)}>{state.loadingMore ? "Loading…" : "Load more"}</button></div> : null}
    </WalletGate>
  );
}
