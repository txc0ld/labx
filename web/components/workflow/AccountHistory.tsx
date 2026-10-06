"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { BrowserService } from "@/lib/chain/ports";
import type { BlockRef, HistoryItem } from "@/lib/chain/types";
import { formatUsdc, shortAddress } from "./format";
import { useWalletSnapshot, WalletGate } from "./WalletGate";

type HistoryState =
  | { kind: "idle" | "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: readonly HistoryItem[]; nextCursor: bigint | null; loadingMore: boolean; block: BlockRef };

const EVENT_COPY: Record<HistoryItem["event"], { title: string; detail: string }> = {
  PackPurchased: { title: "Membership purchased", detail: "Confirmed membership and included bonus entries" },
  PrizeClaimed: { title: "Prize claimed", detail: "NFT transferred to the recorded winner" },
  ProceedsClaimed: { title: "Proceeds claimed", detail: "Membership proceeds transferred to the seller" },
  FeeClaimed: { title: "Lab fee transferred", detail: "Fee transferred to the pinned treasury" },
  Refunded: { title: "Refund claimed", detail: "Membership price and lab fee returned" },
  PrizeReclaimed: { title: "Prize reclaimed", detail: "NFT returned after cancellation" }
};

export function AccountHistory({ browser }: { browser: BrowserService }) {
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

  if (browser.kind === "unavailable") return <div className="notice warning" role="status">{browser.reason}</div>;
  return (
    <WalletGate wallet={browser.wallet}>
      {state.kind === "idle" || state.kind === "loading" ? <p className="notice" role="status">Loading confirmed account history…</p> : null}
      {state.kind === "error" ? <div className="notice error stack" role="alert"><span>{state.message}</span><button className="btn btn-dark" type="button" onClick={() => void load()}>Retry history</button></div> : null}
      {state.kind === "ready" && !state.items.length ? <div className="well pad stack"><h2>{state.nextCursor !== null ? "No activity in the scanned range" : "No confirmed activity"}</h2><p>No matching contract events were found for {wallet.kind === "connected" ? shortAddress(wallet.account) : "this wallet"}.</p><Link className="btn btn-dark" href="/">Explore raffles</Link></div> : null}
      {state.kind === "ready" && state.items.length ? (
        <div className="stack">
          <ol className="history-list">
            {state.items.map((item) => {
              const copy = EVENT_COPY[item.event];
              return <li key={`${item.transactionHash}-${item.logIndex}`}><div><strong>{copy.title}</strong><p>{copy.detail}</p></div><dl><div><dt>Raffle</dt><dd><Link href={`/piece/${item.raffleId.toString()}`}>#{item.raffleId.toString()}</Link></dd></div><div><dt>Amount</dt><dd>{formatUsdc(item.principal + item.fee)} USDC</dd></div>{item.event === "PackPurchased" ? <div><dt>Memberships</dt><dd>{item.quantity} · {item.bonusEntries} bonus entries</dd></div> : null}<div><dt>Block</dt><dd>{item.blockNumber.toString()}</dd></div></dl><details><summary>Transaction</summary><p className="hash">{item.transactionHash}</p></details></li>;
            })}
          </ol>
        </div>
      ) : null}
      {state.kind === "ready" && state.nextCursor !== null ? <div className="stack"><p className="muted">Partial history. Later blocks have not been scanned yet.</p><button className="btn load-more" type="button" disabled={state.loadingMore} onClick={() => void load(state.nextCursor ?? undefined)}>{state.loadingMore ? "Loading…" : "Scan later activity"}</button></div> : null}
    </WalletGate>
  );
}
