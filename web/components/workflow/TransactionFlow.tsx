"use client";

import { useCallback, useEffect, useId, useRef, useSyncExternalStore, useState } from "react";
import { formatEther, isHex, type Hex } from "viem";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { Confirmation, PreparedAction, SubmittedAction, WalletSnapshot, WorkflowAction } from "@/lib/chain/types";

type TransactionState =
  | { kind: "idle" }
  | { kind: "recovery"; hash: string; nonce: number }
  | { kind: "preparing" }
  | { kind: "review"; prepared: PreparedAction }
  | { kind: "submitting"; prepared: PreparedAction }
  | { kind: "pending"; submitted: SubmittedAction }
  | { kind: "rejected"; message: string }
  | { kind: "error"; message: string }
  | { kind: "reverted"; confirmation: Extract<Confirmation, { kind: "reverted" | "replaced" }> }
  | { kind: "replaced"; confirmation: Extract<Confirmation, { kind: "reverted" | "replaced" }> }
  | { kind: "confirmed"; confirmation: Extract<Confirmation, { kind: "confirmed" }> };

export type AmountFormatter = (atomicUsdc: bigint) => string;

export type TransactionFlowProps = {
  service: RaffleService;
  wallet: WalletSessionPort;
  action: WorkflowAction;
  label: string;
  formatUsdc: AmountFormatter;
  resumeHash?: Hex;
  onConfirmed?: (confirmation: Extract<Confirmation, { kind: "confirmed" }>) => void | Promise<void>;
  onCancel?: () => void;
};

function walletSnapshot(wallet: WalletSessionPort) {
  return wallet.getSnapshot();
}

function errorState(error: unknown): Extract<TransactionState, { kind: "rejected" }> | Extract<TransactionState, { kind: "error" }> {
  const message = error instanceof Error ? error.message : "Unable to continue. Check your wallet and try again.";
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return code === 4001 || /reject|denied|cancelled by user/i.test(message)
    ? { kind: "rejected", message: "The wallet request was rejected. No transaction was submitted." }
    : { kind: "error", message };
}

function sameWallet(prepared: PreparedAction, snapshot: WalletSnapshot) {
  return snapshot.kind === "connected"
    && snapshot.account.toLowerCase() === prepared.account.toLowerCase()
    && snapshot.chainId === prepared.chainId
    && snapshot.revision === prepared.walletRevision;
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function TransactionFlow({ service, wallet, action, label, formatUsdc, resumeHash, onConfirmed, onCancel }: TransactionFlowProps) {
  const reviewTitleId = useId();
  const subscribe = useCallback((listener: () => void) => wallet.subscribe(listener), [wallet]);
  const getWalletSnapshot = useCallback(() => walletSnapshot(wallet), [wallet]);
  const currentWallet = useSyncExternalStore(subscribe, getWalletSnapshot, getWalletSnapshot);
  const [state, setState] = useState<TransactionState>({ kind: "idle" });
  const inFlight = useRef(false);

  useEffect(() => {
    setState((current) => current.kind === "review" || current.kind === "submitting"
      ? { kind: "error", message: "Wallet or network changed. Review the action again before signing." }
      : current);
  }, [currentWallet.revision]);

  async function showError(error: unknown) {
    try {
      const pending = await service.pending({ wallet });
      if (pending) { setState({ kind: "recovery", hash: pending.hash ?? "", nonce: pending.nonce }); return; }
    } catch { /* Retain the original failure when recovery storage or the wallet is unavailable. */ }
    setState(errorState(error));
  }
  useEffect(() => {
    let active = true;
    if (currentWallet.kind === "connected") void service.pending({ wallet }).then(pending => {
      if (active && pending) setState({ kind: "recovery", hash: pending.hash ?? "", nonce: pending.nonce });
    }).catch(error => { if (active) setState(errorState(error)); });
    return () => { active = false; };
  }, [service, wallet, currentWallet]);

  async function prepare() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: "preparing" });
    try {
      const prepared = await service.prepare({ action, wallet });
      setState({ kind: "review", prepared });
    } catch (error) {
      await showError(error);
    } finally {
      inFlight.current = false;
    }
  }

  async function waitForConfirmation(submitted: SubmittedAction) {
    try {
      const confirmation = await service.confirm({ transaction: submitted });
      if (confirmation.kind === "pending") {
        setState({ kind: "pending", submitted });
        return;
      }
      if (confirmation.kind === "confirmed") {
        setState({ kind: "confirmed", confirmation });
        await onConfirmed?.(confirmation);
        return;
      }
      if (confirmation.kind === "reverted") setState({ kind: "reverted", confirmation });
      else setState({ kind: "replaced", confirmation });
    } catch (error) {
      await showError(error);
    }
  }

  async function submit(prepared: PreparedAction) {
    if (inFlight.current) return;
    if (!sameWallet(prepared, currentWallet)) {
      setState({ kind: "error", message: "Wallet or network changed. Review the action again before signing." });
      return;
    }
    inFlight.current = true;
    setState({ kind: "submitting", prepared });
    try {
      const submitted = await service.submit({ prepared, wallet });
      setState({ kind: "pending", submitted });
      await waitForConfirmation(submitted);
    } catch (error) {
      await showError(error);
    } finally {
      inFlight.current = false;
    }
  }

  async function checkConfirmation(submitted: SubmittedAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    try { await waitForConfirmation(submitted); }
    finally { inFlight.current = false; }
  }

  async function resume(hash: Hex | undefined = resumeHash) {
    if (!hash || inFlight.current) return;
    inFlight.current = true;
    try {
      const submitted = await service.resume({ hash, wallet });
      setState({ kind: "pending", submitted });
      await waitForConfirmation(submitted);
    } catch (error) {
      await showError(error);
    } finally {
      inFlight.current = false;
    }
  }

  if (state.kind === "recovery") return <section className="transaction-state notice warning stack" role="status"><strong>Reconcile pending wallet activity</strong><p>This wallet has an unresolved transaction at nonce {state.nonce}. Check the wallet’s activity and confirm its transaction or replacement hash before another action. Reloading does not remove this protection.</p><label>Transaction hash<input value={state.hash} spellCheck={false} onChange={event => setState({ ...state, hash: event.target.value.trim() })} /></label><button className="btn" type="button" disabled={!isHex(state.hash, { strict: true }) || state.hash.length !== 66} onClick={() => { if (isHex(state.hash)) void resume(state.hash); }}>Reconcile transaction</button><p className="muted">If the wallet has not broadcast it, use the wallet to replace or cancel that nonce. This page cannot safely clear an uncertain send.</p></section>;

  if (state.kind === "idle") {
    return <button className="btn" type="button" onClick={() => void prepare()}>{label}</button>;
  }
  if (state.kind === "preparing") {
    return <button className="btn" type="button" disabled>Preparing review…</button>;
  }
  if (state.kind === "review" || state.kind === "submitting") {
    const stale = !sameWallet(state.prepared, currentWallet);
    return (
      <section className="transaction-review stack" aria-labelledby={reviewTitleId}>
        <div><p className="kicker">Review transaction</p><h3 id={reviewTitleId}>{state.prepared.title}</h3></div>
        <dl className="review-list">
          <div><dt>Wallet</dt><dd>{shortAddress(state.prepared.account)}</dd></div>
          <div><dt>Network</dt><dd>Chain {state.prepared.chainId}</dd></div>
          <div><dt>Amount</dt><dd>{formatUsdc(state.prepared.amountUsdc)} USDC</dd></div>
          {state.prepared.value > 0n ? <div><dt>Maximum ETH</dt><dd>{formatEther(state.prepared.value)} ETH</dd></div> : null}
          <div><dt>Recipient</dt><dd className="hash">{state.prepared.recipient}</dd></div>
        </dl>
        {stale ? <p className="notice error" role="alert">Wallet or network changed. Prepare this action again.</p> : null}
        <details><summary>Transaction details</summary><p className="hash">Contract {state.prepared.to}</p></details>
        <div className="btn-row">
          <button className="btn" type="button" disabled={stale || state.kind === "submitting"} onClick={() => void submit(state.prepared)}>{state.kind === "submitting" ? "Waiting for wallet…" : `Confirm ${label.toLowerCase()}`}</button>
          <button className="text-link" type="button" disabled={state.kind === "submitting"} onClick={() => { setState({ kind: "idle" }); onCancel?.(); }}>Cancel</button>
        </div>
      </section>
    );
  }
  if (state.kind === "pending") {
    return (
      <div className="transaction-state stack" role="status">
        <strong>Transaction submitted</strong>
        <p>Confirmation is still pending. The hash alone is not success.</p>
        <p className="hash">{state.submitted.hash}</p>
        <button className="btn" type="button" onClick={() => void checkConfirmation(state.submitted)}>Check confirmation</button>
      </div>
    );
  }
  if (state.kind === "confirmed") {
    return <div className="transaction-state notice ok stack" role="status"><strong>Confirmed</strong><span>Confirmed in block {state.confirmation.blockNumber.toString()}.</span><p className="hash">{state.confirmation.hash}</p></div>;
  }
  if (state.kind === "reverted" || state.kind === "replaced") {
    return (
      <div className="transaction-state notice error stack" role="alert">
        <strong>{state.kind === "reverted" ? "Transaction reverted" : "Transaction replaced"}</strong>
        <span>{state.confirmation.reason}</span>
        <button className="btn btn-dark" type="button" onClick={() => setState({ kind: "idle" })}>Review again</button>
      </div>
    );
  }
  return (
    <div className={`transaction-state notice ${state.kind === "rejected" ? "warning" : "error"} stack`} role={state.kind === "error" ? "alert" : "status"}>
      <strong>{state.kind === "rejected" ? "Wallet request rejected" : "Action unavailable"}</strong>
      <span>{state.message}</span>
      <div className="btn-row">
        <button className="btn btn-dark" type="button" onClick={() => setState({ kind: "idle" })}>Try again</button>
        {resumeHash ? <button className="text-link" type="button" onClick={() => void resume()}>Resume transaction</button> : null}
      </div>
    </div>
  );
}
