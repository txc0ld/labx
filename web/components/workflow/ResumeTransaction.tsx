"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { isHex, type Hex } from "viem";
import type { BrowserService } from "@/lib/chain/ports";
import type { OutcomeJournal } from "@/lib/chain/types";
import { transactionMeaning, type TransactionOutcome } from "@/lib/chain/transaction-outcomes";
import { useWalletSnapshot } from "./WalletGate";
import { usePendingSend, useSavedHashCheck, useTransactionOutcomes } from "./useTransactionOutcomes";

export function isTransactionHistory(outcome: TransactionOutcome, journalClear: boolean): boolean {
  return outcome.kind === "terminal" || outcome.kind === "rejected"
    || outcome.kind === "error" && outcome.submitted === null && outcome.id !== "storage-error" && journalClear;
}

/** showWait adds the visible "Confirming your last transaction…" or "Waiting for your last transaction to confirm…" line to a normal wait. Pages whose own transaction controls show the wait turn it off. */
type Props = { browser: BrowserService; onConfirmed?: () => void | Promise<void>; pendingOnly?: boolean; scope?: string; confirmedThroughBlock?: bigint; deferRefresh?: boolean; showWait?: boolean };
export function ResumeTransaction(props: Props) {
  return props.browser.kind === "configured" ? <ConfiguredResume {...props} browser={props.browser} /> : null;
}

function ConfiguredResume({ browser, onConfirmed, pendingOnly = false, scope = "wallet", confirmedThroughBlock, deferRefresh = false, showWait = true }: Props & { browser: Extract<BrowserService, { kind: "configured" }> }) {
  const wallet = useWalletSnapshot(browser.wallet);
  const { owner, outcomes } = useTransactionOutcomes(browser.service, browser.wallet);
  const [hash, setHash] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<OutcomeJournal | null>(null);
  const [clearJournal, setClearJournal] = useState<{ service: typeof browser.service; wallet: typeof browser.wallet; revision: number; activity: string } | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<number | null>(null);
  const callback = useRef(onConfirmed);
  callback.current = onConfirmed;
  const inputId = useId();
  const editedHash = useRef(false);
  const journalActivity = outcomes.filter(item => item.kind === "submitting" || item.kind === "checking" || item.kind === "pending").map(item => `${item.id}:${item.kind}`).join("|");
  const connected = wallet.kind === "connected" && wallet.chainId === browser.service.manifest.chainId;
  const savedCheck = useSavedHashCheck(browser.service, browser.wallet, pending?.hash ?? null);
  // This tab's own wallet request is open: its result settles the record, so the chain check waits.
  const ownRequestOpen = outcomes.some(item => item.kind === "submitting");
  const pendingSend = usePendingSend(browser.service, browser.wallet, ownRequestOpen ? null : pending);

  useEffect(() => {
    const version = ++generation.current;
    inFlight.current = null; editedHash.current = false;
    setChecking(false); setError(""); setHash(""); setPending(null);
    return () => { if (generation.current === version) generation.current++; };
  }, [browser.service, browser.wallet, wallet]);

  useEffect(() => {
    setClearJournal(null);
    if (!connected) return;
    let active = true;
    const version = generation.current;
    void browser.service.pending({ wallet: browser.wallet }).then(value => {
      if (active && version === generation.current) {
        setPending(value);
        if (!value) setClearJournal({ service: browser.service, wallet: browser.wallet, revision: wallet.revision, activity: journalActivity });
        if (value?.hash && !editedHash.current) setHash(value.hash);
      }
    }).catch(reason => {
      if (active && version === generation.current) setError(reason instanceof Error ? reason.message : "Pending wallet activity could not be read.");
    });
    return () => { active = false; };
  }, [browser.service, browser.wallet, connected, wallet, journalActivity, checking, savedCheck, pendingSend.status]);

  // A send at the record's nonce was mined and the record cleared: the page reads the chain again.
  useEffect(() => {
    if (pendingSend.status !== "spent" || deferRefresh || !callback.current) return;
    const version = generation.current;
    void Promise.resolve(callback.current()).catch(reason => {
      if (version === generation.current) setError(reason instanceof Error ? reason.message : "Refresh the current state before another action.");
    });
  }, [pendingSend.status, deferRefresh]);

  useEffect(() => {
    if (!connected || wallet.kind !== "connected" || !callback.current || deferRefresh) return;
    const confirmed = outcomes.filter(item => item.kind === "terminal" && item.confirmation.receipt.status === "success" && transactionMeaning(browser.service, item.submitted) !== null && (confirmedThroughBlock === undefined || item.confirmation.receipt.blockNumber > confirmedThroughBlock));
    const unseen = confirmed.filter(item => owner.claimRefresh(`${scope}:${wallet.account.toLowerCase()}:${wallet.revision}:${item.id}`));
    if (!unseen.length) return;
    const version = generation.current;
    void Promise.resolve(callback.current()).catch(reason => {
      if (version === generation.current) setError(reason instanceof Error ? reason.message : "Confirmed transaction retained. Refresh the current state before another action.");
    });
  }, [browser.service, connected, outcomes, owner, scope, wallet, confirmedThroughBlock, deferRefresh]);

  async function check(transactionHash: Hex) {
    if (!connected || inFlight.current !== null) return;
    const version = generation.current;
    inFlight.current = version; setChecking(true); setError("");
    try {
      const result = await owner.resume(transactionHash, browser.wallet);
      if (version === generation.current && (result.kind === "unverified" || result.kind === "error")) setError(result.message);
    }
    catch (reason) {
      if (version === generation.current) setError(reason instanceof Error ? reason.message : "The transaction could not be checked.");
    } finally {
      if (version === generation.current) { inFlight.current = null; setChecking(false); }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!isHex(hash, { strict: true }) || hash.length !== 66) { setError("Enter a complete transaction hash."); return; }
    void check(hash);
  }
  async function dismiss(outcome: TransactionOutcome) {
    const version = generation.current;
    try { await owner.acknowledge(outcome, browser.wallet); }
    catch (reason) { if (version === generation.current) setError(reason instanceof Error ? reason.message : "The receipt could not be acknowledged."); }
  }

  function renderOutcome(outcome: TransactionOutcome) {
    const submitted = "submitted" in outcome ? outcome.submitted : null;
    const meaning = submitted ? transactionMeaning(browser.service, submitted) : null;
    const transactionHash = submitted?.hash ?? ("hash" in outcome ? outcome.hash : null);
    return <div key={outcome.id} className={`transaction-outcome notice stack ${outcome.kind === "terminal" && outcome.confirmation.receipt.status === "success" ? "ok" : "warning"}`} role="status">
      <strong>{outcome.kind === "submitting" ? "Waiting for wallet" : outcome.kind === "terminal" ? meaning?.purchase && outcome.confirmation.receipt.status === "success" ? `Purchase confirmed for raffle #${meaning.raffleId}` : outcome.confirmation.kind === "confirmed" ? "Transaction confirmed" : outcome.confirmation.kind === "reverted" ? "Transaction reverted" : "Transaction replaced" : outcome.kind === "rejected" ? "Wallet request rejected" : outcome.kind === "error" || outcome.kind === "unverified" || outcome.kind === "overflow" ? "Transaction needs attention" : outcome.kind === "recovery" ? "Saved transaction needs verification" : "Transaction submitted"}</strong>
      {meaning && !meaning.purchase ? <span>Raffle #{meaning.raffleId.toString()} · {meaning.action}</span> : null}
      {outcome.kind === "terminal" ? outcome.confirmation.kind === "confirmed" ? <span>Confirmed in block {outcome.confirmation.blockNumber.toString()}.</span> : <span>{outcome.confirmation.reason}</span> : (outcome.kind === "error" || outcome.kind === "rejected" || outcome.kind === "unverified" || outcome.kind === "overflow") ? <span>{outcome.message}</span> : outcome.kind === "submitting" ? <span>The original wallet request is in progress. Its result stays available here through refreshes.</span> : <span>A saved or submitted hash is not proof of success.</span>}
      {outcome.kind === "terminal" && meaning?.purchase && outcome.confirmation.receipt.status === "success" ? <Link className="text-link" href={`/piece/${meaning.raffleId}`}>View purchase receipt</Link> : null}
      {transactionHash ? <p className="hash">{transactionHash}</p> : null}
      {transactionHash && outcome.kind !== "terminal" ? <button className="btn" type="button" disabled={checking || outcome.kind === "checking"} onClick={() => void check(transactionHash)}>Check confirmation</button> : null}
      {outcome.kind === "terminal" && !(meaning?.purchase && outcome.confirmation.receipt.status === "success") ? <button className="text-link" type="button" onClick={() => void dismiss(outcome)}>Dismiss receipt</button> : null}
    </div>;
  }

  const journalClear = clearJournal?.service === browser.service && clearJournal.wallet === browser.wallet && clearJournal.revision === wallet.revision && clearJournal.activity === journalActivity;
  const history = outcomes.filter(outcome => isTransactionHistory(outcome, journalClear));
  const unresolved = outcomes.filter(outcome => !isTransactionHistory(outcome, journalClear));
  // A normal wait: this tab's wallet request is open, or the saved hash is being checked automatically. Its outcome
  // rows and the manual form stay one click away instead of filling the page.
  const normalWait = pending !== null && !error && (pending.hash ? savedCheck !== null && savedCheck !== "attention" : unresolved.some(outcome => outcome.kind === "submitting"));
  const waiting = (outcome: TransactionOutcome) => normalWait && (outcome.kind === "submitting"
    || pending?.hash != null && outcomeTransactionHash(outcome)?.toLowerCase() === pending.hash.toLowerCase());
  if (!connected || pendingOnly && !pending && outcomes.length === 0 && !error) return null;
  const form = (heading: ReactNode) => <form className="well pad stack" onSubmit={submit}>
    {heading}
    <label htmlFor={inputId}>Transaction hash<input id={inputId} spellCheck={false} autoComplete="off" value={hash} onChange={event => { editedHash.current = true; setHash(event.target.value.trim()); }} placeholder="0x…" /></label>
    <button className="btn btn-dark" type="submit" disabled={checking}>{checking ? "Checking confirmation…" : "Check transaction"}</button>
  </form>;
  const progress = (text: string) => <p className="transaction-progress" role="status"><span className="transaction-spinner" aria-hidden="true" />{text}</p>;
  const rejectFirst = <p>If your wallet still shows a request from LABx, reject it first.</p>;
  let panel: ReactNode = null;
  if (normalWait) {
    // A normal wait: this tab's wallet request is open, or the saved hash is being checked automatically. Its outcome
    // rows and the manual form stay one click away instead of filling the page.
    panel = <>{showWait ? progress("Confirming your last transaction…") : null}<details className="workflow-details"><summary>Transaction details</summary><div className="stack">{unresolved.filter(waiting).map(renderOutcome)}{form(null)}</div></details></>;
  } else if (pending && pending.hash === null) {
    // No hash was saved: the chain decides. Only when it cannot be read does the manual form appear, behind Details.
    panel = pendingSend.status === "unsent"
      ? <div className="well pad stack" role="status"><h2>Your wallet didn’t send your last transaction.</h2><button className="btn btn-dark" type="button" onClick={() => void pendingSend.continueUnsent()}>Continue</button><details><summary>Details</summary>{rejectFirst}</details></div>
      : pendingSend.status === "unknown"
        ? <div className="stack">{progress("Can’t reach the network to check your last transaction. Trying again…")}<details className="workflow-details"><summary>Details</summary><div className="stack">{form(null)}{rejectFirst}</div></details></div>
        : showWait ? progress(pendingSend.status === "waiting" ? "Waiting for your last transaction to confirm…" : "Checking your last transaction…") : null;
  } else if (pending && pending.hash) {
    const saved = pending.hash;
    panel = <div className="well pad stack" role="status"><h2>Your last transaction hasn’t settled yet.</h2><button className="btn btn-dark" type="button" disabled={checking} onClick={() => void check(saved)}>{checking ? "Checking confirmation…" : "Check again"}</button><details><summary>Details</summary><div className="stack">{form(null)}<p>Unresolved transaction at nonce {pending.nonce}. Its saved hash is filled in above.</p></div></details></div>;
  } else if (!pendingOnly) {
    panel = form(<div><h2>Resume after reload</h2><p>Use a transaction hash from this connected wallet to check its on-chain result. A submitted hash is not treated as success.</p></div>);
  }
  return (
    <section className="stack resume-transaction" aria-label="Wallet transaction outcomes">
      {unresolved.filter(outcome => !waiting(outcome)).map(renderOutcome)}
      {history.length ? <details className="workflow-details"><summary>Activity ({history.length})</summary><div className="stack">{history.map(renderOutcome)}</div></details> : null}
      {panel}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  );
}

function outcomeTransactionHash(outcome: TransactionOutcome) {
  return "submitted" in outcome ? outcome.submitted?.hash ?? null : "hash" in outcome ? outcome.hash : null;
}
