"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { isHex, type Hex } from "viem";
import type { BrowserService } from "@/lib/chain/ports";
import { transactionMeaning, type TransactionOutcome } from "@/lib/chain/transaction-outcomes";
import { useWalletSnapshot } from "./WalletGate";
import { useTransactionOutcomes } from "./useTransactionOutcomes";

type Props = { browser: BrowserService; onConfirmed?: () => void | Promise<void>; pendingOnly?: boolean; scope?: string };
export function ResumeTransaction(props: Props) {
  return props.browser.kind === "configured" ? <ConfiguredResume {...props} browser={props.browser} /> : null;
}

function ConfiguredResume({ browser, onConfirmed, pendingOnly = false, scope = "wallet" }: Props & { browser: Extract<BrowserService, { kind: "configured" }> }) {
  const wallet = useWalletSnapshot(browser.wallet);
  const { owner, outcomes } = useTransactionOutcomes(browser.service, browser.wallet);
  const [hash, setHash] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<{ hash: Hex | null; nonce: number } | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<number | null>(null);
  const callback = useRef(onConfirmed);
  callback.current = onConfirmed;
  const inputId = useId();
  const connected = wallet.kind === "connected" && wallet.chainId === browser.service.manifest.chainId;

  useEffect(() => {
    const version = ++generation.current;
    inFlight.current = null;
    setChecking(false); setError(""); setHash(""); setPending(null);
    return () => { if (generation.current === version) generation.current++; };
  }, [browser.service, browser.wallet, wallet]);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    const version = generation.current;
    void browser.service.pending({ wallet: browser.wallet }).then(value => {
      if (active && version === generation.current) { setPending(value); if (value?.hash) setHash(value.hash); }
    }).catch(reason => {
      if (active && version === generation.current) setError(reason instanceof Error ? reason.message : "Pending wallet activity could not be read.");
    });
    return () => { active = false; };
  }, [browser.service, browser.wallet, connected, wallet, outcomes]);

  useEffect(() => {
    if (!connected || wallet.kind !== "connected" || !callback.current) return;
    const confirmed = outcomes.filter(item => item.kind === "terminal" && item.confirmation.receipt.status === "success");
    const unseen = confirmed.filter(item => owner.claimRefresh(`${scope}:${wallet.account.toLowerCase()}:${wallet.revision}:${item.id}`));
    if (!unseen.length) return;
    const version = generation.current;
    void Promise.resolve(callback.current()).catch(reason => {
      if (version === generation.current) setError(reason instanceof Error ? reason.message : "Confirmed transaction retained. Refresh the current state before another action.");
    });
  }, [connected, outcomes, owner, scope, wallet]);

  async function check(transactionHash: Hex) {
    if (!connected || inFlight.current !== null) return;
    const version = generation.current;
    inFlight.current = version; setChecking(true); setError("");
    try { await owner.resume(transactionHash, browser.wallet); }
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
  function dismiss(outcome: TransactionOutcome) {
    try { owner.acknowledge(outcome); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The receipt could not be acknowledged."); }
  }

  if (!connected || pendingOnly && !pending && outcomes.length === 0 && !error) return null;
  return (
    <section className="stack resume-transaction" aria-label="Wallet transaction outcomes">
      {outcomes.map(outcome => {
        const submitted = "submitted" in outcome ? outcome.submitted : null;
        const meaning = submitted ? transactionMeaning(browser.service, submitted) : null;
        const transactionHash = submitted?.hash ?? ("hash" in outcome ? outcome.hash : null);
        return <div key={outcome.id} className={`transaction-outcome notice stack ${outcome.kind === "terminal" && outcome.confirmation.receipt.status === "success" ? "ok" : "warning"}`} role="status">
          <strong>{outcome.kind === "submitting" ? "Waiting for wallet" : outcome.kind === "terminal" ? meaning?.purchase && outcome.confirmation.receipt.status === "success" ? `Purchase confirmed for raffle #${meaning.raffleId}` : outcome.confirmation.kind === "confirmed" ? "Transaction confirmed" : outcome.confirmation.kind === "reverted" ? "Transaction reverted" : "Transaction replaced" : outcome.kind === "rejected" ? "Wallet request rejected" : outcome.kind === "error" || outcome.kind === "unverified" ? "Transaction needs attention" : outcome.kind === "recovery" ? "Saved transaction needs verification" : "Transaction submitted"}</strong>
          {meaning && !meaning.purchase ? <span>Raffle #{meaning.raffleId.toString()} · {meaning.action}</span> : null}
          {outcome.kind === "terminal" ? outcome.confirmation.kind === "confirmed" ? <span>Confirmed in block {outcome.confirmation.blockNumber.toString()}.</span> : <span>{outcome.confirmation.reason}</span> : (outcome.kind === "error" || outcome.kind === "rejected" || outcome.kind === "unverified") ? <span>{outcome.message}</span> : outcome.kind === "submitting" ? <span>The original wallet request is in progress. Its result stays available here through refreshes.</span> : <span>A saved or submitted hash is not proof of success.</span>}
          {transactionHash ? <p className="hash">{transactionHash}</p> : null}
          {transactionHash && outcome.kind !== "terminal" ? <button className="btn" type="button" disabled={checking || outcome.kind === "checking"} onClick={() => void check(transactionHash)}>Check confirmation</button> : null}
          {outcome.kind === "terminal" && !(meaning?.purchase && outcome.confirmation.receipt.status === "success") ? <button className="text-link" type="button" onClick={() => dismiss(outcome)}>Dismiss receipt</button> : null}
        </div>;
      })}
      {pending || !pendingOnly ? <form className="well pad stack" onSubmit={submit}>
        <div><h2>{pending ? "Pending wallet activity" : "Resume after reload"}</h2><p>Use a transaction hash from this connected wallet to check its on-chain result. A submitted hash is not treated as success.</p></div>
        {pending ? <p className="notice warning" role="status">Reconcile this wallet’s unresolved transaction at nonce {pending.nonce} before submitting another action. {pending.hash ? "Its saved hash is filled in below." : "Check wallet activity for the actual transaction or a same-nonce replacement/cancellation hash."}</p> : null}
        <label htmlFor={inputId}>Transaction hash<input id={inputId} spellCheck={false} autoComplete="off" value={hash} onChange={event => setHash(event.target.value.trim())} placeholder="0x…" /></label>
        <button className="btn btn-dark" type="submit" disabled={checking}>{checking ? "Checking confirmation…" : "Check transaction"}</button>
      </form> : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  );
}
