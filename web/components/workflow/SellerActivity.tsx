"use client";

import { useEffect, useRef, useState } from "react";
import type { RaffleService } from "@/lib/chain/ports";
import { mergeSellerActivityPage, type SellerRaffleActivity } from "@/lib/chain/seller-types";
import type { BlockRef } from "@/lib/chain/types";
import styles from "./SellerPortal.module.css";
import { formatUsdc, shortAddress } from "./format";

type ActivityState =
  | { kind: "loading" }
  | { kind: "error"; items: readonly SellerRaffleActivity[]; block: BlockRef | null; nextCursor: bigint | null; message: string }
  | { kind: "ready"; items: readonly SellerRaffleActivity[]; block: BlockRef; nextCursor: bigint | null; loadingMore: boolean };

export function SellerActivity({ service, id }: { service: RaffleService; id: bigint }) {
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
        message: error instanceof Error ? error.message : "Raffle activity could not be loaded."
      }));
    }
  }

  useEffect(() => {
    void load();
    return () => { request.current += 1; };
    // Route and service changes invalidate activity pages pinned to the previous block.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, service]);

  return (
    <section className={styles.activity} aria-labelledby="seller-activity-title">
      <div className={styles.sectionHeading}><div><p className="kicker">Financial activity</p><h2 id="seller-activity-title">On-chain money movements</h2></div>{state.kind === "ready" && state.nextCursor === null ? <span>Complete</span> : <span>Partial until fully scanned</span>}</div>
      <p className={styles.activityNote}>This event feed supports the detail view. Portfolio totals come from the raffle’s pinned accounting snapshot.</p>
      {state.kind === "loading" ? <p className="notice" role="status">Scanning the first 2,000-block activity range…</p> : null}
      {state.kind === "error" ? <div className="notice error stack" role="alert"><strong>Activity scan stopped</strong><span>{state.message}</span><button className="btn btn-dark" type="button" onClick={() => void load(state.nextCursor ?? undefined, state.block ?? undefined)}>Retry activity scan</button></div> : null}
      {state.kind !== "loading" && state.items.length === 0 ? <p>No financial events were found in the scanned range{state.nextCursor === null ? "." : " yet."}</p> : null}
      {state.kind !== "loading" && state.items.length ? <ol className={styles.activityList}>{state.items.map((item) => <ActivityRow key={`${item.transactionHash}-${item.logIndex}`} item={item} />)}</ol> : null}
      {state.kind === "ready" && state.nextCursor !== null ? <button className="btn btn-dark" type="button" disabled={state.loadingMore} onClick={() => void load(state.nextCursor ?? undefined, state.block)}>{state.loadingMore ? "Scanning next range…" : "Scan next 2,000 blocks"}</button> : null}
    </section>
  );
}

function ActivityRow({ item }: { item: SellerRaffleActivity }) {
  let title: string;
  let description: string;
  switch (item.eventName) {
    case "PackPurchased":
      title = "Membership purchased";
      description = `${shortAddress(item.args.buyer)} paid ${formatUsdc(item.args.principal)} USDC principal + ${formatUsdc(item.args.fee)} buyer fee · quantity ${item.args.qty}`;
      break;
    case "ProceedsClaimed":
      title = "Seller proceeds claimed";
      description = `${formatUsdc(item.args.principal)} USDC sent to ${shortAddress(item.args.seller)}`;
      break;
    case "FeeClaimed":
      title = "Protocol fees sent";
      description = `${formatUsdc(item.args.fee)} USDC sent to ${shortAddress(item.args.treasury)}`;
      break;
    case "Refunded":
      title = "Buyer refund claimed";
      description = `${formatUsdc(item.args.amount)} USDC combined refund sent to ${shortAddress(item.args.buyer)}`;
      break;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
  return <li><div><strong>{title}</strong><p>{description}</p></div><div className={styles.activityMeta}><span>Block {item.blockNumber.toString()}</span><span className="hash">{item.transactionHash}</span></div></li>;
}
