"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import type { BrowserService } from "@/lib/chain/ports";
import type { HistoryItem } from "@/lib/chain/types";
import { shortAddress } from "./format";
import { useWalletSnapshot, WalletGate } from "./WalletGate";

type PrivateRecords = {
  agreements: { raffleId: string; recorded: boolean; at: string | null }[];
  receipts: { transactionHash: Hex; logIndex: number; status: "missing" | "pending" | "delivered" }[];
};

export type ReadPrivateRecords = (input: { raffleIds: string[]; purchases: { transactionHash: Hex; logIndex: number }[] }) => Promise<PrivateRecords>;
export type DeliverReceipt = (input: { transactionHash: Hex; logIndex: number }) => Promise<{ delivered: boolean; repeated?: boolean; reason?: string }>;

type RecordsState =
  | { kind: "loading-history" }
  | { kind: "ready-history"; purchases: readonly HistoryItem[] }
  | { kind: "loading-records"; purchases: readonly HistoryItem[] }
  | { kind: "ready"; purchases: readonly HistoryItem[]; records: PrivateRecords }
  | { kind: "error"; message: string };

export function PrivateRecordsPanel({ browser, email, readRecords, deliverReceipt }: {
  browser: BrowserService;
  email: string;
  readRecords: ReadPrivateRecords;
  deliverReceipt: DeliverReceipt;
}) {
  const wallet = useWalletSnapshot(browser.wallet);
  const [state, setState] = useState<RecordsState>({ kind: "loading-history" });
  const [delivery, setDelivery] = useState<Record<string, "sending" | "delivered" | "error">>({});
  const [deliveryError, setDeliveryError] = useState("");
  const [historyLimited, setHistoryLimited] = useState(false);
  const request = useRef(0);
  const recordsInFlight = useRef(false);
  const deliveryInFlight = useRef(new Set<string>());

  async function loadHistory() {
    if (browser.kind !== "configured" || wallet.kind !== "connected") return;
    const version = ++request.current;
    setState({ kind: "loading-history" });
    try {
      const items: HistoryItem[] = [];
      let fromBlock: bigint | undefined;
      let more = false;
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page = await browser.service.history({ account: wallet.account, fromBlock });
        items.push(...page.items.filter((item) => item.event === "PackPurchased"));
        if (page.nextCursor === null) { more = false; break; }
        more = true;
        fromBlock = page.nextCursor;
      }
      if (version === request.current) { setHistoryLimited(more); setState({ kind: "ready-history", purchases: items }); }
    } catch (error) {
      if (version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "Purchase history could not be loaded." });
    }
  }

  useEffect(() => {
    setDelivery({});
    setDeliveryError("");
    if (browser.kind === "configured" && wallet.kind === "connected") void loadHistory();
    else setState({ kind: "loading-history" });
    return () => { request.current += 1; };
    // Wallet revision invalidates private records and their authorization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, wallet]);

  async function loadRecords(purchases: readonly HistoryItem[]) {
    if (recordsInFlight.current) return;
    recordsInFlight.current = true;
    const version = ++request.current;
    setState({ kind: "loading-records", purchases });
    try {
      const records = await readRecords({
        raffleIds: [...new Set(purchases.map((item) => item.raffleId.toString()))],
        purchases: purchases.map((item) => ({ transactionHash: item.transactionHash, logIndex: item.logIndex }))
      });
      if (version === request.current) setState({ kind: "ready", purchases, records });
    } catch (error) {
      if (version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "Private records could not be loaded." });
    } finally {
      recordsInFlight.current = false;
    }
  }

  async function send(transactionHash: Hex, logIndex: number) {
    const key = `${transactionHash}-${logIndex}`;
    if (deliveryInFlight.current.has(key)) return;
    deliveryInFlight.current.add(key);
    setDelivery((current) => ({ ...current, [key]: "sending" }));
    setDeliveryError("");
    try {
      const result = await deliverReceipt({ transactionHash, logIndex });
      if (!result.delivered) throw new Error(result.reason || "Receipt delivery was not acknowledged.");
      setDelivery((current) => ({ ...current, [key]: "delivered" }));
    } catch (error) {
      setDelivery((current) => ({ ...current, [key]: "error" }));
      setDeliveryError(error instanceof Error ? error.message : "Receipt delivery failed.");
    } finally {
      deliveryInFlight.current.delete(key);
    }
  }

  if (browser.kind === "unavailable") return <p className="notice warning" role="status">{browser.reason}</p>;
  return (
    <WalletGate wallet={browser.wallet}>
      {state.kind === "loading-history" ? <p className="notice" role="status">Loading confirmed purchases…</p> : null}
      {state.kind === "error" ? <div className="notice error stack" role="alert"><span>{state.message}</span><button className="btn btn-dark" type="button" onClick={() => void loadHistory()}>Retry</button></div> : null}
      {state.kind === "ready-history" && !state.purchases.length ? <div className="well pad stack"><h2>No confirmed purchases</h2><p>No membership purchase events were found for {wallet.kind === "connected" ? shortAddress(wallet.account) : "this wallet"}.</p><Link className="btn btn-dark" href="/">Explore raffles</Link></div> : null}
      {(state.kind === "ready-history" || state.kind === "loading-records") && state.purchases.length ? <div className="well pad stack"><h2>Load private records</h2><p>A wallet signature is required to read agreement and receipt delivery status. It does not submit a transaction.</p><button className="btn" type="button" disabled={state.kind === "loading-records"} onClick={() => void loadRecords(state.purchases)}>{state.kind === "loading-records" ? "Opening wallet…" : "Sign to load records"}</button></div> : null}
      {historyLimited ? <p className="notice warning" role="status">Receipt lookup is limited to the first 250 history records. Older purchases are not shown in this view.</p> : null}
      {state.kind === "ready" ? (
        <div className="workflow-grid">
          <section className="pearl pad stack"><h2>Receipts</h2>{!email ? <p className="notice warning">Add an email preference before requesting delivery. <Link href="/profile#email-preferences">Email preferences</Link></p> : null}<ol className="private-record-list">{state.purchases.map((purchase) => {
            const key = `${purchase.transactionHash}-${purchase.logIndex}`;
            const record = state.records.receipts.find((item) => item.transactionHash.toLowerCase() === purchase.transactionHash.toLowerCase() && item.logIndex === purchase.logIndex);
            const status = delivery[key] === "delivered" ? "delivered" : record?.status ?? "missing";
            return <li key={key}><div><strong>Raffle #{purchase.raffleId.toString()}</strong><span>{status === "delivered" ? "Delivered" : status === "pending" ? "Delivery pending" : "Not delivered"}</span></div><p className="hash">{purchase.transactionHash}</p>{status !== "delivered" ? <button className="btn btn-dark" type="button" disabled={!email || delivery[key] === "sending"} onClick={() => void send(purchase.transactionHash, purchase.logIndex)}>{delivery[key] === "sending" ? "Sending…" : "Sign and send receipt"}</button> : null}</li>;
          })}</ol>{deliveryError ? <p className="notice error" role="alert">{deliveryError}</p> : null}</section>
          <section className="well pad stack"><h2>Agreements</h2>{!state.records.agreements.length ? <p>No agreement record was returned.</p> : <ol className="private-record-list">{state.records.agreements.map((agreement) => <li key={agreement.raffleId}><strong>Raffle #{agreement.raffleId}</strong><span>{agreement.recorded ? `Recorded${agreement.at ? ` · ${new Date(agreement.at).toLocaleString("en-AU")}` : ""}` : "Not recorded"}</span></li>)}</ol>}</section>
        </div>
      ) : null}
    </WalletGate>
  );
}
