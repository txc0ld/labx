"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import type { BrowserService } from "@/lib/chain/ports";
import { loadPrivateRecordBatches } from "./record-batches";
import { readHistoryPages, type HistoryContinuation } from "./history-pages";
import type { HistoryItem, WalletSnapshot } from "@/lib/chain/types";
import { sameAddress } from "@/lib/chain/validation";
import { formatUsdcAmount } from "./format";
import { useWalletSnapshot, WalletGate } from "./WalletGate";

type PrivateRecords = {
  agreements: { raffleId: string; recorded: boolean; at: string | null }[];
  receipts: { transactionHash: Hex; logIndex: number; status: "missing" | "pending" | "delivered" }[];
};

export type ReadPrivateRecords = (input: { raffleIds: string[]; purchases: { transactionHash: Hex; logIndex: number }[] }) => Promise<PrivateRecords>;
export type DeliverReceipt = (input: { transactionHash: Hex; logIndex: number }) => Promise<{ delivered: boolean; repeated?: boolean; reason?: string }>;

/** Records already signed for the first `count` purchases, kept when Load more adds older ones. */
type SignedRecords = { records: PrivateRecords; count: number };

type RecordsState =
  | { kind: "loading-history" }
  | { kind: "ready-history"; purchases: readonly HistoryItem[]; signed?: SignedRecords }
  | { kind: "loading-records"; purchases: readonly HistoryItem[]; signed?: SignedRecords }
  | { kind: "ready"; purchases: readonly HistoryItem[]; records: PrivateRecords }
  | { kind: "error"; message: string };

type ConnectedWallet = Extract<WalletSnapshot, { kind: "connected" }>;

function sameWalletSession(current: WalletSnapshot, expected: ConnectedWallet) {
  return current.kind === "connected"
    && current.revision === expected.revision
    && current.chainId === expected.chainId
    && sameAddress(current.account, expected.account);
}

export function PrivateRecordsPanel({ browser, email, readRecords, deliverReceipt, loading = false }: {
  browser: BrowserService;
  email: string;
  readRecords: ReadPrivateRecords;
  deliverReceipt: DeliverReceipt;
  /** True until the browser has read its deployment configuration. */
  loading?: boolean;
}) {
  const wallet = useWalletSnapshot(browser.wallet);
  const [state, setState] = useState<RecordsState>({ kind: "loading-history" });
  const [delivery, setDelivery] = useState<Record<string, "sending" | "delivered" | "error">>({});
  const [deliveryError, setDeliveryError] = useState("");
  const [continuation, setContinuation] = useState<HistoryContinuation | null>(null);
  const request = useRef(0);
  const mounted = useRef(false);
  const activeWallet = useRef(browser.wallet);
  const recordsInFlight = useRef<{ token: symbol; wallet: ConnectedWallet } | null>(null);
  const deliveryInFlight = useRef(new Map<string, { token: symbol; wallet: ConnectedWallet }>());
  activeWallet.current = browser.wallet;

  async function loadHistory(more = false) {
    if (browser.kind !== "configured" || wallet.kind !== "connected") return;
    const version = ++request.current;
    setState({ kind: "loading-history" });
    try {
      const signed = !more ? undefined : state.kind === "ready" ? { records: state.records, count: state.purchases.length } : state.kind === "ready-history" ? state.signed : undefined;
      const page = await readHistoryPages(browser.service, wallet.account, more ? continuation : null);
      const items = [...more && "purchases" in state ? state.purchases : [], ...page.items.filter((item) => item.event === "PackPurchased")];
      if (version === request.current) {
        setContinuation(page.continuation);
        setState(signed && signed.count === items.length ? { kind: "ready", purchases: items, records: signed.records } : { kind: "ready-history", purchases: items, signed });
      }
    } catch (error) {
      if (version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "Purchase history could not be loaded." });
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setDelivery({});
    setContinuation(null);
    setDeliveryError("");
    recordsInFlight.current = null;
    deliveryInFlight.current.clear();
    if (browser.kind === "configured" && wallet.kind === "connected") void loadHistory();
    else setState({ kind: "loading-history" });
    return () => { request.current += 1; };
    // Wallet revision invalidates private records and their authorization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, wallet]);

  async function loadRecords(purchases: readonly HistoryItem[], signed?: SignedRecords) {
    const expected = browser.wallet.getSnapshot();
    if (expected.kind !== "connected") return;
    const currentOperation = recordsInFlight.current;
    if (currentOperation && sameWalletSession(currentOperation.wallet, expected)) return;
    const token = Symbol("private records request");
    recordsInFlight.current = { token, wallet: expected };
    const version = ++request.current;
    setState({ kind: "loading-records", purchases, signed });
    try {
      // Only purchases without a signed record ask for a signature.
      const fresh = await loadPrivateRecordBatches(purchases.slice(signed?.count ?? 0), readRecords, () => version === request.current);
      const records = signed
        ? { agreements: [...new Map([...signed.records.agreements, ...fresh.agreements].map((item) => [item.raffleId, item])).values()], receipts: [...signed.records.receipts, ...fresh.receipts] }
        : fresh;
      if (version === request.current) setState({ kind: "ready", purchases, records });
    } catch (error) {
      if (version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "Private records could not be loaded." });
    } finally {
      if (recordsInFlight.current?.token === token) recordsInFlight.current = null;
    }
  }

  async function send(transactionHash: Hex, logIndex: number) {
    const expected = browser.wallet.getSnapshot();
    if (expected.kind !== "connected") return;
    const key = `${transactionHash}-${logIndex}`;
    const currentOperation = deliveryInFlight.current.get(key);
    if (currentOperation && sameWalletSession(currentOperation.wallet, expected)) return;
    const token = Symbol("receipt delivery request");
    deliveryInFlight.current.set(key, { token, wallet: expected });
    const isCurrent = () => mounted.current
      && activeWallet.current === browser.wallet
      && deliveryInFlight.current.get(key)?.token === token
      && sameWalletSession(browser.wallet.getSnapshot(), expected);
    setDelivery((current) => ({ ...current, [key]: "sending" }));
    setDeliveryError("");
    try {
      const result = await deliverReceipt({ transactionHash, logIndex });
      if (!result.delivered) throw new Error(result.reason || "Receipt delivery was not acknowledged.");
      if (isCurrent()) setDelivery((current) => ({ ...current, [key]: "delivered" }));
    } catch (error) {
      if (isCurrent()) {
        setDelivery((current) => ({ ...current, [key]: "error" }));
        setDeliveryError(error instanceof Error ? error.message : "Receipt delivery failed.");
      }
    } finally {
      if (deliveryInFlight.current.get(key)?.token === token) deliveryInFlight.current.delete(key);
    }
  }

  if (loading) return <p className="notice" role="status">Loading your purchases…</p>;
  if (browser.kind === "unavailable") return <p className="notice warning" role="status">{browser.reason}</p>;
  const signatures = state.kind === "ready-history" || state.kind === "loading-records" ? Math.ceil((state.purchases.length - (state.signed?.count ?? 0)) / 30) : 0;
  // Signed receipts stay listed while older purchases wait for their signature.
  const shown = state.kind === "ready" ? state
    : (state.kind === "ready-history" || state.kind === "loading-records") && state.signed ? { purchases: state.purchases.slice(0, state.signed.count), records: state.signed.records } : null;
  return (
    <WalletGate wallet={browser.wallet}>
      {state.kind === "loading-history" ? <p className="notice" role="status">Loading your purchases…</p> : null}
      {state.kind === "error" ? <div className="notice error stack" role="alert"><span>{state.message}</span><button className="btn btn-dark" type="button" onClick={() => void loadHistory()}>Retry</button></div> : null}
      {state.kind === "ready-history" && !state.purchases.length ? <div className="well pad stack"><h2>{continuation ? "No purchases found yet" : "No purchases yet"}</h2><Link className="btn btn-dark" href="/">Browse raffles</Link></div> : null}
      {(state.kind === "ready-history" || state.kind === "loading-records") && state.purchases.length ? <div className="well pad stack"><h2>See your receipts</h2><p>Signing is free and doesn’t send a transaction.{signatures > 1 ? ` You’ll sign ${signatures} times.` : ""}</p><button className="btn" type="button" disabled={state.kind === "loading-records"} onClick={() => void loadRecords(state.purchases, state.signed)}>{state.kind === "loading-records" ? "Opening wallet…" : "Sign to see receipts"}</button></div> : null}
      {continuation && state.kind !== "loading-history" ? <div className="stack"><p className="muted" role="status">Older purchases aren’t shown yet.</p><button className="btn btn-dark" type="button" disabled={state.kind === "loading-records"} onClick={() => void loadHistory(true)}>Load more</button></div> : null}
      {shown ? (
        <div className="workflow-grid">
          <section className="pearl pad stack"><h2>Your purchases</h2>{email ? <p className="notice">Receipts go to {email}. <Link href="/profile#email-preferences">Change</Link></p> : <p className="notice warning">Add your email to get receipts. <Link href="/profile#email-preferences">Add email</Link></p>}<ol className="private-record-list">{shown.purchases.map((purchase) => {
            const key = `${purchase.transactionHash}-${purchase.logIndex}`;
            const record = shown.records.receipts.find((item) => item.transactionHash.toLowerCase() === purchase.transactionHash.toLowerCase() && item.logIndex === purchase.logIndex);
            const status = delivery[key] === "delivered" ? "delivered" : record?.status ?? "missing";
            return <li key={key}><div><strong>Raffle #{purchase.raffleId.toString()}</strong><span>{formatUsdcAmount(purchase.principal + purchase.fee)} USDC</span><span>{status === "delivered" ? "Sent" : status === "pending" ? "Pending" : "Not sent"}</span></div><details><summary>Transaction details</summary><p className="hash">{purchase.transactionHash}</p></details>{status !== "delivered" ? <button className="btn btn-dark" type="button" disabled={!email || delivery[key] === "sending"} onClick={() => void send(purchase.transactionHash, purchase.logIndex)}>{delivery[key] === "sending" ? "Sending…" : "Email receipt"}</button> : null}</li>;
          })}</ol>{deliveryError ? <p className="notice error" role="alert">{deliveryError}</p> : null}</section>
          <section className="well pad stack"><h2>Agreements</h2>{!shown.records.agreements.length ? <p>No agreements yet.</p> : <ol className="private-record-list">{shown.records.agreements.map((agreement) => <li key={agreement.raffleId}><strong>Raffle #{agreement.raffleId}</strong><span>{agreement.recorded ? `Recorded${agreement.at ? ` · ${new Date(agreement.at).toLocaleString("en-AU")}` : ""}` : "Not recorded"}</span></li>)}</ol>}</section>
        </div>
      ) : null}
    </WalletGate>
  );
}
