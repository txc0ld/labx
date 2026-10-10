"use client";

import { useEffect, useRef, useState } from "react";
import type { RaffleService } from "@/lib/chain/ports";
import { mergeSellerActivityPage, type SellerRaffleActivity } from "@/lib/chain/seller-types";
import type { BlockRef } from "@/lib/chain/types";
import styles from "./SellerPortal.module.css";
import { formatUsdcAmount, shortAddress } from "./format";

type ActivityState =
  | { kind: "loading" }
  | { kind: "error"; items: readonly SellerRaffleActivity[]; block: BlockRef | null; nextCursor: bigint | null; message: string }
  | { kind: "ready"; items: readonly SellerRaffleActivity[]; block: BlockRef; nextCursor: bigint | null; loadingMore: boolean };

/** "Sales and payouts" list for one raffle. `refreshKey` reloads it whenever the raffle snapshot refreshes. */
export function SellerActivity({ service, id, refreshKey }: { service: RaffleService; id: bigint; refreshKey?: string }) {
  const [state, setState] = useState<ActivityState>({ kind: "loading" });
  const request = useRef(0);

  async function load(cursor?: bigint, block?: BlockRef) {
    const version = ++request.current;
    if (cursor === undefined) setState({ kind: "loading" });
    else setState((current) => current.kind === "ready" ? { ...current, loadingMore: true } : current);
    try {
      const page = await service.listRaffleActivity({ id, cursor, block });
      if (version !== request.current) return;
      setState((latest) => ({
        kind: "ready",
        items: mergeSellerActivityPage(latest.kind, latest.kind === "loading" ? [] : latest.items, page.items, cursor),
        block: page.block,
        nextCursor: page.nextCursor,
        loadingMore: false
      }));
    } catch (error) {
      if (version !== request.current) return;
      setState((latest) => ({
        kind: "error",
        items: latest.kind === "ready" || latest.kind === "error" ? latest.items : [],
        block: latest.kind === "ready" || latest.kind === "error" ? latest.block : null,
        nextCursor: latest.kind === "ready" || latest.kind === "error" ? latest.nextCursor : cursor ?? null,
        message: error instanceof Error ? error.message : "Sales and payouts could not be loaded."
      }));
    }
  }

  useEffect(() => {
    void load();
    return () => { request.current += 1; };
    // Route, service and raffle refreshes invalidate activity pages pinned to the previous block.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, service, refreshKey]);

  return (
    <section className="stack sales-activity" aria-label="Sales and payouts">
      {state.kind === "loading" ? <p className="notice" role="status">Loading sales and payouts…</p> : null}
      {state.kind === "error" ? <div className="notice error stack" role="alert"><strong>Couldn’t load all sales and payouts</strong><span>{state.message}</span><button className="btn btn-dark" type="button" onClick={() => void load(state.nextCursor ?? undefined, state.block ?? undefined)}>Try again</button></div> : null}
      {state.kind !== "loading" && state.items.length === 0 ? <p>{state.nextCursor === null ? "No sales or payouts yet." : "None found so far."}</p> : null}
      {state.kind !== "loading" && state.items.length ? <ol className={styles.activityList}>{state.items.map((item) => <ActivityRow key={`${item.transactionHash}-${item.logIndex}`} item={item} />)}</ol> : null}
      {state.kind === "ready" && state.nextCursor !== null ? <button className="btn btn-dark" type="button" disabled={state.loadingMore} onClick={() => void load(state.nextCursor ?? undefined, state.block)}>{state.loadingMore ? "Loading…" : "Load more"}</button> : null}
    </section>
  );
}

function ActivityRow({ item }: { item: SellerRaffleActivity }) {
  let title: string;
  let description: string;
  switch (item.eventName) {
    case "PackPurchased":
      title = `${shortAddress(item.args.buyer)} bought ${item.args.qty} ${item.args.qty === 1 ? "membership" : "memberships"}`;
      description = `${formatUsdcAmount(item.args.principal)} USDC + ${formatUsdcAmount(item.args.fee)} USDC processing fee`;
      break;
    case "ProceedsClaimed":
      title = "Sales paid out";
      description = `${formatUsdcAmount(item.args.principal)} USDC to ${shortAddress(item.args.seller)}`;
      break;
    case "FeeClaimed":
      title = "LABx fees paid out";
      description = `${formatUsdcAmount(item.args.fee)} USDC to ${shortAddress(item.args.treasury)}`;
      break;
    case "Refunded":
      title = "Refund";
      description = `${formatUsdcAmount(item.args.amount)} USDC to ${shortAddress(item.args.buyer)}. The processing fee is not refunded.`;
      break;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
  return <li><div><strong>{title}</strong><p>{description}</p></div><details className={`workflow-details ${styles.activityMeta}`}><summary>Details</summary><span>Block {item.blockNumber.toString()}</span><span className="hash">{item.transactionHash}</span></details></li>;
}
