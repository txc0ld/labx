"use client";

import { useCallback, useEffect, useId, useRef, useSyncExternalStore, useState } from "react";
import { formatEther, isHex, type Hex } from "viem";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { Confirmation, PreparedAction, SubmittedAction, WalletSnapshot, WorkflowAction } from "@/lib/chain/types";
import { useTransactionOutcomes } from "./useTransactionOutcomes";
import type { TransactionOutcome } from "@/lib/chain/transaction-outcomes";
import { isWalletRequestRejected } from "@/lib/chain/wallet-errors";

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
  onConfirmed?: (confirmation: Extract<Confirmation, { kind: "confirmed" }>, submitted: SubmittedAction) => void | Promise<void>;
  onCancel?: () => void;
  disabled?: boolean;
  disabledReason?: string;
};

function walletSnapshot(wallet: WalletSessionPort) {
  return wallet.getSnapshot();
}

function errorState(error: unknown): Extract<TransactionState, { kind: "rejected" }> | Extract<TransactionState, { kind: "error" }> {
  const message = error instanceof Error ? error.message : "Unable to continue. Check your wallet and try again.";
  return isWalletRequestRejected(error)
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

function stableValue(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function actionKey(action: WorkflowAction) {
  return stableValue(action);
}

type FlowContext = {
  generation: number;
  service: RaffleService;
  wallet: WalletSessionPort;
  actionKey: string;
  walletRevision: number;
  resumeHash: Hex | undefined;
};

type Operation = { scope: number; id: number };

function actionReview(action: WorkflowAction) {
  if (action.kind !== "approveUsdc" && action.kind !== "buyMembership") return null;
  return (
    <>
      <div><dt>Raffle</dt><dd>#{action.id.toString()}</dd></div>
      <div><dt>Pack ID</dt><dd>{action.packId}</dd></div>
      <div><dt>Quantity</dt><dd>{action.quantity}</dd></div>
    </>
  );
}

export function TransactionFlow({ service, wallet, action, label, formatUsdc, resumeHash, onConfirmed, onCancel, disabled = false, disabledReason }: TransactionFlowProps) {
  const { owner, outcomes } = useTransactionOutcomes(service, wallet);
  const activeOutcome = outcomes.some(item => item.kind === "submitting" || item.kind === "checking" || item.kind === "pending" || item.kind === "recovery" || item.kind === "unverified" || item.kind === "error" && item.submitted !== null);
  const reviewTitleId = useId();
  const subscribe = useCallback((listener: () => void) => wallet.subscribe(listener), [wallet]);
  const getWalletSnapshot = useCallback(() => walletSnapshot(wallet), [wallet]);
  const currentWallet = useSyncExternalStore(subscribe, getWalletSnapshot, getWalletSnapshot);
  const semanticAction = actionKey(action);
  const context = useRef<FlowContext>({ generation: 0, service, wallet, actionKey: semanticAction, walletRevision: currentWallet.revision, resumeHash });
  if (context.current.service !== service || context.current.wallet !== wallet || context.current.actionKey !== semanticAction || context.current.walletRevision !== currentWallet.revision || context.current.resumeHash !== resumeHash) {
    context.current = { generation: context.current.generation + 1, service, wallet, actionKey: semanticAction, walletRevision: currentWallet.revision, resumeHash };
  }
  const scope = context.current.generation;
  const [scopedState, setScopedState] = useState<{ scope: number; value: TransactionState }>({ scope, value: { kind: "idle" } });
  const state = scopedState.scope === scope ? scopedState.value : { kind: "idle" } satisfies TransactionState;
  const operation = useRef<Operation | null>(null);
  const operationSequence = useRef(0);
  const callbacks = useRef({ onConfirmed, onCancel });
  callbacks.current = { onConfirmed, onCancel };

  useEffect(() => () => {
    context.current = { ...context.current, generation: context.current.generation + 1 };
  }, []);

  function isCurrent(expected: FlowContext) {
    const live = context.current;
    return expected.wallet.getSnapshot().revision === expected.walletRevision && live.generation === expected.generation && live.service === expected.service && live.wallet === expected.wallet
      && live.actionKey === expected.actionKey && live.walletRevision === expected.walletRevision && live.resumeHash === expected.resumeHash;
  }

  function setCurrent(expected: FlowContext, value: TransactionState) {
    if (isCurrent(expected)) setScopedState({ scope: expected.generation, value });
  }

  function begin(expected: FlowContext) {
    if (operation.current?.scope === expected.generation) return null;
    const next = { scope: expected.generation, id: ++operationSequence.current };
    operation.current = next;
    return next;
  }

  function end(expected: Operation) {
    if (operation.current?.scope === expected.scope && operation.current.id === expected.id) operation.current = null;
  }

  useEffect(() => {
    const expected = context.current;
    setScopedState({ scope: expected.generation, value: { kind: "idle" } });
    if (currentWallet.kind !== "connected") return;
    let active = true;
    void expected.service.pending({ wallet: expected.wallet }).then(pending => {
      if (!active || !isCurrent(expected)) return;
      setScopedState(current => {
        if (!isCurrent(expected) || current.scope !== expected.generation) return current;
        if (pending) return operation.current?.scope === expected.generation ? current : { scope: expected.generation, value: { kind: "recovery", hash: pending.hash ?? "", nonce: pending.nonce } };
        return current.value.kind === "recovery" ? { scope: expected.generation, value: { kind: "idle" } } : current;
      });
    }).catch(error => {
      if (active && isCurrent(expected) && operation.current?.scope !== expected.generation) setCurrent(expected, errorState(error));
    });
    return () => { active = false; };
    // The numeric scope changes only when service, wallet, session, action or resume identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  async function showError(error: unknown, expected: FlowContext) {
    try {
      const pending = await expected.service.pending({ wallet: expected.wallet });
      if (!isCurrent(expected)) return;
      if (pending) { setCurrent(expected, { kind: "recovery", hash: pending.hash ?? "", nonce: pending.nonce }); return; }
    } catch { /* Retain the original failure when recovery storage or the wallet is unavailable. */ }
    if (isCurrent(expected)) setCurrent(expected, errorState(error));
  }

  async function prepare() {
    if (disabled || activeOutcome) return;
    const expected = context.current;
    const activeOperation = begin(expected);
    if (!activeOperation) return;
    setCurrent(expected, { kind: "preparing" });
    try {
      const prepared = await expected.service.prepare({ action, wallet: expected.wallet });
      setCurrent(expected, { kind: "review", prepared });
    } catch (error) {
      await showError(error, expected);
    } finally {
      end(activeOperation);
    }
  }

  async function applyOutcome(outcome: TransactionOutcome, expected: FlowContext) {
    if (!isCurrent(expected)) return;
    if (outcome.kind === "terminal") {
      const confirmation = outcome.confirmation;
      if (confirmation.kind === "confirmed") {
        setCurrent(expected, { kind: "confirmed", confirmation });
        await callbacks.current.onConfirmed?.(confirmation, outcome.submitted);
      } else setCurrent(expected, { kind: confirmation.kind, confirmation });
    } else if (outcome.kind === "pending" || outcome.kind === "checking") {
      setCurrent(expected, { kind: "pending", submitted: outcome.submitted });
    } else if (outcome.kind === "rejected") {
      setCurrent(expected, { kind: "rejected", message: outcome.message });
    } else if (outcome.kind === "error") {
      await showError(new Error(outcome.message), expected);
    }
  }

  async function waitForConfirmation(submitted: SubmittedAction, expected: FlowContext) {
    await applyOutcome(await owner.confirm(submitted), expected);
  }

  async function submit(prepared: PreparedAction) {
    if (disabled || activeOutcome) return;
    if (!sameWallet(prepared, currentWallet)) {
      setCurrent(context.current, { kind: "error", message: "Wallet or network changed. Review the action again before signing." });
      return;
    }
    const expected = context.current;
    const activeOperation = begin(expected);
    if (!activeOperation) return;
    setCurrent(expected, { kind: "submitting", prepared });
    try {
      await applyOutcome(await owner.submit(prepared, expected.wallet), expected);
    } catch (error) {
      await showError(error, expected);
    } finally {
      end(activeOperation);
    }
  }

  async function checkConfirmation(submitted: SubmittedAction) {
    if (disabled) return;
    const expected = context.current;
    const activeOperation = begin(expected);
    if (!activeOperation) return;
    try { await waitForConfirmation(submitted, expected); }
    finally { end(activeOperation); }
  }

  async function resume(hash: Hex | undefined = resumeHash) {
    if (!hash || disabled) return;
    const expected = context.current;
    const activeOperation = begin(expected);
    if (!activeOperation) return;
    try {
      await applyOutcome(await owner.resume(hash, expected.wallet), expected);
    } catch (error) {
      await showError(error, expected);
    } finally {
      end(activeOperation);
    }
  }

  if (state.kind === "recovery") return <section className="transaction-state notice warning stack" role="status"><strong>Reconcile pending wallet activity</strong><p>This wallet has an unresolved transaction at nonce {state.nonce}. Check the wallet’s activity and confirm its transaction or replacement hash before another action. Reloading does not remove this protection.</p><label>Transaction hash<input value={state.hash} spellCheck={false} onChange={event => setCurrent(context.current, { ...state, hash: event.target.value.trim() })} /></label><button className="btn" type="button" disabled={disabled || !isHex(state.hash, { strict: true }) || state.hash.length !== 66} onClick={() => { if (isHex(state.hash)) void resume(state.hash); }}>Reconcile transaction</button>{disabledReason && disabled ? <p className="notice warning">{disabledReason}</p> : null}<p className="muted">If the wallet has not broadcast it, use the wallet to replace or cancel that nonce. This page cannot safely clear an uncertain send.</p></section>;

  if (state.kind === "idle") {
    return <button className="btn" type="button" disabled={disabled || activeOutcome} title={disabled ? disabledReason : undefined} onClick={() => void prepare()}>{label}</button>;
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
          {actionReview(state.prepared.action)}
          <div><dt>Wallet</dt><dd>{shortAddress(state.prepared.account)}</dd></div>
          <div><dt>Network</dt><dd>Chain {state.prepared.chainId}</dd></div>
          <div><dt>Amount</dt><dd>{formatUsdc(state.prepared.amountUsdc)} USDC</dd></div>
          {state.prepared.value > 0n ? <div><dt>Maximum ETH</dt><dd>{formatEther(state.prepared.value)} ETH</dd></div> : null}
          <div><dt>Recipient</dt><dd className="hash">{state.prepared.recipient}</dd></div>
        </dl>
        {stale ? <p className="notice error" role="alert">Wallet or network changed. Prepare this action again.</p> : null}
        <details><summary>Transaction details</summary><p className="hash">Contract {state.prepared.to}</p></details>
        <div className="btn-row">
          <button className="btn" type="button" disabled={disabled || activeOutcome || stale || state.kind === "submitting"} title={disabled ? disabledReason : undefined} onClick={() => void submit(state.prepared)}>{state.kind === "submitting" ? "Waiting for wallet…" : `Confirm ${label.toLowerCase()}`}</button>
          <button className="text-link" type="button" disabled={state.kind === "submitting"} onClick={() => { setCurrent(context.current, { kind: "idle" }); callbacks.current.onCancel?.(); }}>Cancel</button>
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
        <button className="btn" type="button" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => void checkConfirmation(state.submitted)}>Check confirmation</button>
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
        <button className="btn btn-dark" type="button" onClick={() => setCurrent(context.current, { kind: "idle" })}>Review again</button>
      </div>
    );
  }
  return (
    <div className={`transaction-state notice ${state.kind === "rejected" ? "warning" : "error"} stack`} role={state.kind === "error" ? "alert" : "status"}>
      <strong>{state.kind === "rejected" ? "Wallet request rejected" : "Action unavailable"}</strong>
      <span>{state.message}</span>
      <div className="btn-row">
        <button className="btn btn-dark" type="button" onClick={() => setCurrent(context.current, { kind: "idle" })}>Try again</button>
        {resumeHash ? <button className="text-link" type="button" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => void resume()}>Resume transaction</button> : null}
      </div>
    </div>
  );
}
