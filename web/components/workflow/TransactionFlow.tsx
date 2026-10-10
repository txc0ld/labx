"use client";

import { useCallback, useEffect, useId, useRef, useSyncExternalStore, useState } from "react";
import { formatEther, isHex, type Address, type Hex } from "viem";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { Confirmation, PreparedAction, SubmittedAction, WalletSnapshot, WorkflowAction } from "@/lib/chain/types";
import { useSavedHashCheck, useTransactionOutcomes } from "./useTransactionOutcomes";
import { sameSubmittedIntent, type TransactionOutcome } from "@/lib/chain/transaction-outcomes";
import { sameAddress } from "@/lib/chain/validation";
import { isWalletRequestRejected } from "@/lib/chain/wallet-errors";
import { lowerFirst } from "./format";

type TransactionState =
  | { kind: "idle" }
  // hash is the editable field; saved is the hash the pending journal held when it was read.
  | { kind: "recovery"; hash: string; nonce: number; saved: Hex | null }
  | { kind: "preparing" }
  | { kind: "review"; prepared: PreparedAction }
  | { kind: "submitting"; prepared: PreparedAction }
  | { kind: "confirming"; submitted: SubmittedAction }
  | { kind: "pending"; submitted: SubmittedAction }
  | { kind: "rejected"; message: string }
  | { kind: "error"; message: string }
  | { kind: "reverted"; confirmation: Extract<Confirmation, { kind: "reverted" | "replaced" }> }
  | { kind: "replaced"; confirmation: Extract<Confirmation, { kind: "reverted" | "replaced" }> }
  | { kind: "receipt"; confirmation: Exclude<Confirmation, { kind: "pending" }> }
  | { kind: "confirmed"; confirmation: Extract<Confirmation, { kind: "confirmed" }> };

export type AmountFormatter = (atomicUsdc: bigint) => string;

export type TransactionFlowProps = {
  service: RaffleService;
  wallet: WalletSessionPort;
  action: WorkflowAction;
  label: string;
  formatUsdc: AmountFormatter;
  resumeHash?: Hex;
  /** direct is true only when the confirmation came straight from this flow's own wallet request, not a later check or recovery. */
  onConfirmed?: (confirmation: Extract<Confirmation, { kind: "confirmed" }>, submitted: SubmittedAction, direct: boolean) => void | Promise<void>;
  onCancel?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  prepareOnMount?: boolean;
  submitOnClick?: boolean;
  /** Sends once on mount as if the button was pressed. Only for a step the person's own click just started. */
  submitOnMount?: boolean;
  /** Awaited before the error shows when preparing that automatic send fails, often because the raffle already moved on, so the page can re-read it and show the step that fits now. */
  onUnavailable?: () => void | Promise<void>;
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

function networkName(chainId: number) {
  return chainId === 11155111 ? "Ethereum Sepolia" : chainId === 31337 ? "Isolated local chain" : `Chain ${chainId}`;
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
  mountRevision: number;
  service: RaffleService;
  wallet: WalletSessionPort;
  actionKey: string;
  walletRevision: number;
  resumeHash: Hex | undefined;
};

type Operation = { scope: number; id: number };

// Calls that only change raffle state. Their prepared recipient is the contract default, not a payee, so the review names the called contract.
const CONTRACT_CALL_KINDS = new Set<WorkflowAction["kind"]>(["createDraft", "updateDraft", "approveRaffle", "revokeRaffleApproval", "open", "close", "snapshot", "requestRandomness", "reveal", "settle", "cancel", "abortDrawing"]);

// Seller steps that pay nobody but the seller. The wallet shows the exact call, so like List they
// skip the website review. Buyer payments always keep it.
const SUBMIT_ON_CLICK_KINDS = new Set<WorkflowAction["kind"]>(["open", "close", "snapshot", "requestRandomness", "reveal", "settle", "cancel", "abortDrawing", "reclaimPrize", "claimProceeds"]);

// Plain rows people can check before the wallet opens. Full addresses, chain ID and pack index stay in Transaction details.
function reviewRows(prepared: PreparedAction, raffle: Address, formatUsdc: AmountFormatter) {
  const party = (value: Address) => sameAddress(value, raffle) ? `LABx raffle ${shortAddress(value)}`
    : sameAddress(value, prepared.account) ? `Your wallet ${shortAddress(value)}` : shortAddress(value);
  const amount = `${formatUsdc(prepared.amountUsdc)} USDC`;
  const kind = prepared.action.kind;
  const rows: [string, string][] = [["Wallet", shortAddress(prepared.account)], ["Network", networkName(prepared.chainId)]];
  if (kind === "approveUsdc") rows.push(["Approval", `Lets ${party(prepared.recipient)} take up to ${amount}`]);
  else if (kind === "approvePrize") rows.push(["Approval", `Lets ${party(prepared.recipient)} take this NFT`]);
  else {
    if (prepared.amountUsdc > 0n) rows.push([kind === "buyMembership" ? "Total" : "Amount", amount]);
    if (prepared.value > 0n) rows.push(["Maximum ETH", `${formatEther(prepared.value)} ETH`]);
    if (CONTRACT_CALL_KINDS.has(kind)) rows.push(["Contract", party(prepared.to)]);
    else rows.push([kind === "buyMembership" ? "Paid to" : "Recipient", party(prepared.recipient)]);
  }
  return rows.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>);
}

function confirmLabel(action: WorkflowAction, label: string) {
  return action.kind === "approveUsdc" ? "Confirm approval" : action.kind === "buyMembership" ? "Confirm purchase" : `Confirm ${lowerFirst(label)}`;
}

export function TransactionFlow({ service, wallet, action, label, formatUsdc, resumeHash, onConfirmed, onCancel, onUnavailable, disabled = false, disabledReason, prepareOnMount = false, submitOnClick = false, submitOnMount = false }: TransactionFlowProps) {
  const { owner, outcomes } = useTransactionOutcomes(service, wallet);
  const activeOutcome = outcomes.some(item => item.kind === "overflow" || item.kind === "submitting" || item.kind === "checking" || item.kind === "pending" || item.kind === "recovery" || item.kind === "unverified" || item.kind === "error" && (item.submitted !== null || item.id === "storage-error"));
  const reviewTitleId = useId();
  const subscribe = useCallback((listener: () => void) => wallet.subscribe(listener), [wallet]);
  const getWalletSnapshot = useCallback(() => walletSnapshot(wallet), [wallet]);
  const currentWallet = useSyncExternalStore(subscribe, getWalletSnapshot, getWalletSnapshot);
  const semanticAction = actionKey(action);
  const context = useRef<FlowContext>({ generation: 0, mountRevision: 0, service, wallet, actionKey: semanticAction, walletRevision: currentWallet.revision, resumeHash });
  if (context.current.service !== service || context.current.wallet !== wallet || context.current.actionKey !== semanticAction || context.current.walletRevision !== currentWallet.revision || context.current.resumeHash !== resumeHash) {
    context.current = { generation: context.current.generation + 1, mountRevision: context.current.mountRevision, service, wallet, actionKey: semanticAction, walletRevision: currentWallet.revision, resumeHash };
  }
  const scope = context.current.generation;
  const [scopedState, setScopedState] = useState<{ scope: number; value: TransactionState }>({ scope, value: { kind: "idle" } });
  const state = scopedState.scope === scope ? scopedState.value : { kind: "idle" } satisfies TransactionState;
  const savedCheck = useSavedHashCheck(service, wallet, state.kind === "recovery" ? state.saved : state.kind === "pending" ? state.submitted.hash : null);
  const recoveryTerminal = state.kind === "recovery" && currentWallet.kind === "connected"
    ? outcomes.find(item => item.kind === "terminal" && item.account.toLowerCase() === currentWallet.account.toLowerCase()
      && item.confirmation.receipt.nonce === state.nonce)
    : undefined;
  const operation = useRef<Operation | null>(null);
  const operationSequence = useRef(0);
  const mounted = useRef(false);
  const attemptedScope = useRef<number | null>(null);
  const [clearJournalScope, setClearJournalScope] = useState<number | null>(null);
  const ownSubmission = useRef<{ scope: number; submitted: SubmittedAction } | null>(null);
  // Read once at mount, and spent on the first decision: a later prop, scope or journal change never sends on its own.
  const [autoSubmit] = useState(submitOnMount);
  const autoSubmitSpent = useRef(false);
  const callbacks = useRef({ onConfirmed, onCancel, onUnavailable });
  callbacks.current = { onConfirmed, onCancel, onUnavailable };
  const reviewButtons = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      context.current = { ...context.current, mountRevision: context.current.mountRevision + 1 };
    };
  }, []);

  function isCurrent(expected: FlowContext) {
    const live = context.current;
    return mounted.current && live.mountRevision === expected.mountRevision && expected.wallet.getSnapshot().revision === expected.walletRevision && live.generation === expected.generation && live.service === expected.service && live.wallet === expected.wallet
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
    setClearJournalScope(null);
    if (currentWallet.kind !== "connected") return;
    let active = true;
    void expected.service.pending({ wallet: expected.wallet }).then(pending => {
      if (!active || !isCurrent(expected)) return;
      if (!pending) setClearJournalScope(expected.generation);
      setScopedState(current => {
        if (!isCurrent(expected) || current.scope !== expected.generation) return current;
        if (pending) return operation.current?.scope === expected.generation ? current : { scope: expected.generation, value: { kind: "recovery", hash: pending.hash ?? "", nonce: pending.nonce, saved: pending.hash } };
        return current.value.kind === "recovery" ? { scope: expected.generation, value: { kind: "idle" } } : current;
      });
    }).catch(error => {
      if (active && isCurrent(expected) && operation.current?.scope !== expected.generation) setCurrent(expected, errorState(error));
    });
    return () => { active = false; };
    // The numeric scope changes only when service, wallet, session, action or resume identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    if (state.kind !== "recovery" || !recoveryTerminal && savedCheck !== "settled") return;
    const expected = context.current, recovery = state;
    let active = true;
    void expected.service.pending({ wallet: expected.wallet }).then(pending => {
      if (!active || !isCurrent(expected)) return;
      if (pending) {
        // The journal now holds another transaction: follow its saved hash, and keep any hash the person typed.
        if (pending.hash !== recovery.saved) setScopedState(current => {
          if (!active || !isCurrent(expected) || current.scope !== expected.generation
            || current.value !== recovery || operation.current?.scope === expected.generation) return current;
          const typed = recovery.hash !== (recovery.saved ?? "");
          return { scope: expected.generation, value: { ...recovery, hash: typed ? recovery.hash : pending.hash ?? "", nonce: pending.nonce, saved: pending.hash } };
        });
        return;
      }
      setClearJournalScope(expected.generation);
      setScopedState(current => {
        if (!active || !isCurrent(expected) || current.scope !== expected.generation
          || current.value !== recovery || operation.current?.scope === expected.generation) return current;
        return { scope: expected.generation, value: { kind: "idle" } };
      });
    }).catch(() => { /* Keep recovery available when the current journal cannot be read. */ });
    return () => { active = false; };
    // Terminal outcomes and a settled automatic check prompt a fresh journal read, never action confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, state, recoveryTerminal, savedCheck]);

  // A check elsewhere on the page, or the automatic one, settled this flow's own slow send: run the same check the
  // Check again button runs, so the result still passes the ownership and intent rules in applyOutcome.
  const ownSendSettled = state.kind === "pending" && outcomes.some(item => item.kind === "terminal" && owner.belongsToSubmission(state.submitted, item));
  useEffect(() => {
    if (state.kind === "pending" && ownSendSettled && !disabled) void checkConfirmation(state.submitted);
    // checkConfirmation claims the scope before its first await, so a repeated render cannot start a second check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownSendSettled, disabled]);

  async function showError(error: unknown, expected: FlowContext) {
    try {
      const pending = await expected.service.pending({ wallet: expected.wallet });
      if (!isCurrent(expected)) return;
      if (pending) { setCurrent(expected, { kind: "recovery", hash: pending.hash ?? "", nonce: pending.nonce, saved: pending.hash }); return; }
    } catch { /* Retain the original failure when recovery storage or the wallet is unavailable. */ }
    if (isCurrent(expected)) setCurrent(expected, errorState(error));
  }

  async function prepare(fromClick = false, automatic = false) {
    if (disabled || activeOutcome) return;
    const expected = context.current;
    const session = expected.wallet.getSnapshot();
    if (session.kind !== "connected" || session.chainId !== expected.service.manifest.chainId) return;
    const activeOperation = begin(expected);
    if (!activeOperation) return;
    attemptedScope.current = expected.generation;
    setCurrent(expected, { kind: "preparing" });
    try {
      const pending = await expected.service.pending({ wallet: expected.wallet });
      if (!isCurrent(expected)) return;
      if (pending) {
        setCurrent(expected, { kind: "recovery", hash: pending.hash ?? "", nonce: pending.nonce, saved: pending.hash });
        return;
      }
      const prepared = await expected.service.prepare({ action, wallet: expected.wallet }).catch(async (error: unknown) => {
        // Nothing reached the wallet. A re-read may replace this flow; if it is still shown, the error below explains.
        if (automatic) await callbacks.current.onUnavailable?.();
        throw error;
      });
      if (!isCurrent(expected)) return;
      if (fromClick && submitOnClick && SUBMIT_ON_CLICK_KINDS.has(action.kind)) {
        setCurrent(expected, { kind: "submitting", prepared });
        await applyOutcome(await owner.submit(prepared, expected.wallet, submitted => {
          if (!isCurrent(expected)) return;
          ownSubmission.current = { scope: expected.generation, submitted };
          setCurrent(expected, { kind: "confirming", submitted });
        }, () => { if (!isCurrent(expected)) throw new Error("This action is no longer active."); }), expected, true);
      } else setCurrent(expected, { kind: "review", prepared });
    } catch (error) {
      await showError(error, expected);
    } finally {
      end(activeOperation);
    }
  }

  useEffect(() => {
    if (!prepareOnMount || disabled || activeOutcome || state.kind !== "idle" || clearJournalScope !== scope
      || attemptedScope.current === scope || currentWallet.kind !== "connected" || currentWallet.chainId !== service.manifest.chainId) return;
    void prepare();
    // prepare claims the semantic scope before its first await. Retries stay explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepareOnMount, disabled, activeOutcome, state.kind, clearJournalScope, scope, currentWallet, service]);

  useEffect(() => {
    if (!autoSubmit || autoSubmitSpent.current) return;
    // A saved transaction that needs a check, or an unreadable journal, ends the automatic send. The button stays.
    if (state.kind === "recovery" || state.kind === "error") { autoSubmitSpent.current = true; return; }
    if (state.kind !== "idle" || clearJournalScope !== scope || disabled || activeOutcome) return;
    autoSubmitSpent.current = true;
    void prepare(true, true);
    // prepare re-reads the journal and checks the wallet and network before anything reaches the wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmit, state.kind, clearJournalScope, scope, disabled, activeOutcome]);

  // A review can open below the screen edge, most often on a phone: bring Confirm and Back into view once.
  useEffect(() => {
    if (state.kind === "review") reviewButtons.current?.scrollIntoView({ block: "nearest" });
  }, [state.kind]);

  async function applyOutcome(outcome: TransactionOutcome, expected: FlowContext, direct = false) {
    if (!isCurrent(expected)) return;
    if (outcome.kind === "terminal") {
      const confirmation = outcome.confirmation;
      const owned = ownSubmission.current?.scope === expected.generation ? ownSubmission.current.submitted : null;
      if (!owned || !owner.belongsToSubmission(owned, outcome) || !sameSubmittedIntent(owned, outcome.submitted)) {
        setCurrent(expected, { kind: "receipt", confirmation });
      } else if (confirmation.kind === "confirmed") {
        setCurrent(expected, { kind: "confirmed", confirmation });
        await callbacks.current.onConfirmed?.(confirmation, outcome.submitted, direct);
      } else setCurrent(expected, { kind: confirmation.kind, confirmation });
    } else if (outcome.kind === "pending" || outcome.kind === "checking") {
      setCurrent(expected, { kind: "pending", submitted: outcome.submitted });
    } else if (outcome.kind === "rejected") {
      setCurrent(expected, { kind: "rejected", message: outcome.message });
    } else if (outcome.kind === "error" || outcome.kind === "unverified") {
      await showError(new Error(outcome.message), expected);
    }
  }

  async function waitForConfirmation(submitted: SubmittedAction, expected: FlowContext) {
    const outcome = await owner.resume(submitted.hash, expected.wallet);
    if (outcome.kind === "terminal" && !sameSubmittedIntent(submitted, outcome.submitted)) {
      setCurrent(expected, { kind: "replaced", confirmation: { kind: "replaced", hash: outcome.submitted.hash, receipt: outcome.confirmation.receipt, reason: "The wallet replaced this transaction with a different action." } });
      return;
    }
    await applyOutcome(outcome, expected);
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
      await applyOutcome(await owner.submit(prepared, expected.wallet, submitted => {
        if (!isCurrent(expected)) return;
        ownSubmission.current = { scope: expected.generation, submitted };
        setCurrent(expected, { kind: "confirming", submitted });
      }), expected, true);
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
    catch (error) { await showError(error, expected); }
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

  if (state.kind === "recovery") {
    const recovery = state;
    const form = <>
      <label>Transaction hash<input value={recovery.hash} spellCheck={false} onChange={event => setCurrent(context.current, { ...recovery, hash: event.target.value.trim() })} /></label>
      <button className="btn" type="button" disabled={disabled || !isHex(recovery.hash, { strict: true }) || recovery.hash.length !== 66} onClick={() => { if (isHex(recovery.hash)) void resume(recovery.hash); }}>Check transaction</button>
      {disabledReason && disabled ? <p className="notice warning">{disabledReason}</p> : null}
    </>;
    const technical = <p className="muted">Unresolved transaction at nonce {recovery.nonce}. If the wallet has not broadcast it, use the wallet to replace or cancel that nonce. Reloading does not remove this protection, and this page cannot safely clear an uncertain send.</p>;
    // A saved hash is checked automatically; the manual form waits behind Details until something needs a person.
    if (recovery.saved && savedCheck !== null && savedCheck !== "attention") return (
      <section className="transaction-state stack" role="status">
        <button className="btn" type="button" disabled>Finishing your last step…</button>
        <details><summary>Details</summary><div className="stack">{form}{technical}</div></details>
      </section>
    );
    return (
      <section className="transaction-state notice warning stack" role="status">
        <strong>Your last transaction needs a check</strong>
        <p>Open your wallet’s activity. When it shows that transaction as done, failed or replaced, paste its hash here and check it. New actions stay paused until then.</p>
        {form}
        <details><summary>Details</summary>{technical}</details>
      </section>
    );
  }

  // aria-busy marks a wallet request that is about to start or in flight, which also holds the raffle page's background re-read.
  if (state.kind === "idle") {
    return <button className="btn" type="button" aria-busy={autoSubmit && !autoSubmitSpent.current || undefined} disabled={disabled || activeOutcome} title={disabled ? disabledReason : undefined} onClick={() => void prepare(true)}>{label}</button>;
  }
  if (state.kind === "preparing") {
    return <button className="btn" type="button" aria-busy="true" disabled>{submitOnClick ? "Preparing…" : "Preparing review…"}</button>;
  }
  if (state.kind === "submitting" && submitOnClick) {
    return <button className="btn" type="button" aria-busy="true" disabled>Waiting for wallet…</button>;
  }
  if (state.kind === "review" || state.kind === "submitting") {
    const stale = !sameWallet(state.prepared, currentWallet);
    const prepared = state.prepared, action = prepared.action;
    return (
      <section className="transaction-review stack" aria-labelledby={reviewTitleId}>
        <div><p className="kicker">Review transaction</p><h3 id={reviewTitleId}>{prepared.title}</h3></div>
        <dl className="review-list">{reviewRows(prepared, service.manifest.address, formatUsdc)}</dl>
        {stale ? <p className="notice error" role="alert">Wallet or network changed. Prepare this action again.</p> : null}
        <details>
          <summary>Transaction details</summary>
          <p className="hash">Contract {prepared.to}</p>
          {sameAddress(prepared.recipient, prepared.to) ? null : <p className="hash">{action.kind === "approveUsdc" || action.kind === "approvePrize" ? "Approved address" : "Recipient"} {prepared.recipient}</p>}
          {action.kind === "approveUsdc" || action.kind === "buyMembership" ? <p>Raffle #{action.id.toString()} · Pack ID {action.packId} · Quantity {action.quantity}</p> : null}
          <p>Chain ID {prepared.chainId}</p>
        </details>
        <div className="btn-row" ref={reviewButtons}>
          <button className="btn" type="button" disabled={disabled || activeOutcome || stale || state.kind === "submitting"} title={disabled ? disabledReason : undefined} onClick={() => void submit(prepared)}>{state.kind === "submitting" ? "Waiting for wallet…" : confirmLabel(action, label)}</button>
          <button className="text-link" type="button" disabled={state.kind === "submitting"} onClick={() => { setCurrent(context.current, { kind: "idle" }); callbacks.current.onCancel?.(); }}>Back</button>
        </div>
      </section>
    );
  }
  if (state.kind === "confirming" || state.kind === "pending") {
    const submitted = state.submitted;
    const details = <details><summary>Details</summary><p className="hash">{submitted.hash}</p></details>;
    if (state.kind === "pending" && savedCheck === "attention") return (
      <div className="transaction-state notice warning stack" role="status">
        <strong>Your transaction needs a check</strong>
        <p>Check again to see its result. New actions stay paused until then.</p>
        <button className="btn" type="button" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => void checkConfirmation(submitted)}>Check again</button>
        {details}
      </div>
    );
    return (
      <div className="transaction-state stack" role="status">
        <button className="btn" type="button" disabled>Confirming…</button>
        <p className="transaction-progress"><span className="transaction-spinner" aria-hidden="true" />{state.kind === "confirming" ? "Confirming on the network… usually under 30 seconds" : "Still confirming on the network. This can take a few minutes when it is busy."}</p>
        {state.kind === "pending" ? <button className="text-link" type="button" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => void checkConfirmation(submitted)}>Check again</button> : null}
        {details}
      </div>
    );
  }
  if (state.kind === "receipt") {
    const receipt = state.confirmation.receipt;
    return <div className="transaction-state notice stack" role="status"><strong>Earlier transaction found</strong><span>{receipt.status === "success" ? "It succeeded" : "It failed"} in block {receipt.blockNumber.toString()}, but it did not {lowerFirst(label)}.</span><details><summary>Transaction details</summary><p className="hash">{state.confirmation.hash}</p></details><button className="btn" type="button" disabled={disabled || activeOutcome} onClick={() => { ownSubmission.current = null; setCurrent(context.current, { kind: "idle" }); }}>Review this action</button></div>;
  }
  if (state.kind === "confirmed") {
    return <div className="transaction-state notice ok stack" role="status"><strong>Done.</strong><details><summary>Transaction details</summary><p>Confirmed in block {state.confirmation.blockNumber.toString()}.</p><p className="hash">{state.confirmation.hash}</p></details></div>;
  }
  if (state.kind === "reverted" || state.kind === "replaced") {
    return (
      <div className="transaction-state notice error stack" role="alert">
        <strong>{state.kind === "reverted" ? "Transaction failed. The raffle did not change." : "Your wallet replaced this transaction"}</strong>
        {state.kind === "replaced" ? <span>This action did not run.</span> : null}
        <details><summary>Transaction details</summary><p className="hash">{state.confirmation.hash}</p></details>
        <button className="btn btn-dark" type="button" onClick={() => setCurrent(context.current, { kind: "idle" })}>Review again</button>
      </div>
    );
  }
  return (
    <div className={`transaction-state notice ${state.kind === "rejected" ? "warning" : "error"} stack`} role={state.kind === "error" ? "alert" : "status"}>
      <strong>{state.kind === "rejected" ? "Cancelled in your wallet. Nothing was sent." : "Action unavailable"}</strong>
      {state.kind === "rejected" ? null : <span>{state.message}</span>}
      <div className="btn-row">
        <button className="btn btn-dark" type="button" onClick={() => setCurrent(context.current, { kind: "idle" })}>Try again</button>
        {resumeHash ? <button className="text-link" type="button" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => void resume()}>Resume transaction</button> : null}
      </div>
    </div>
  );
}
