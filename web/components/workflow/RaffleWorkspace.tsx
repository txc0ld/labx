"use client";

import { useActionTrust } from "./useActionTrust";
import { MembershipPackCard } from "@/components/ui/squishy-card-component";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { decodeFunctionData, formatEther, zeroAddress, type Hex } from "viem";
import { raffleAbi } from "@/lib/chain/abi";
import type { BrowserService, RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import { FEE_DENOMINATOR, sellerAccounting } from "@/lib/chain/fees";
import type { ActionAvailability, AccountRaffleState, Confirmation, MembershipQuote, RaffleSnapshot, SubmittedAction, WorkflowAction } from "@/lib/chain/types";
import { cancelGuidance, cancelReclaimsPrize, drawBlocker, RECLAIM_GUIDANCE, runnerLateTimes, sellerNextStep, sellerOwnsRaffle, sellerPortalActions, sellerSecondaryActions, sellerStepText, type SellerActionAvailability, type SellerActionKind } from "@/lib/chain/seller-actions";
import { isWalletRequestRejected } from "@/lib/chain/wallet-errors";
import { drawRunnerEnabled } from "@/lib/draw-runner/enabled";
import { sameAddress } from "@/lib/chain/validation";
import type { ReserveRecord } from "@/lib/reserve";
import { CompleteCreate } from "./CompleteCreate";
import { SellerDraftForm, type SaveCommitment } from "./SellerDraftForm";
import { TransactionFlow } from "./TransactionFlow";
import { catalogAvailability, formatUsdcAmount, fromPriceLabel, networkName, shortAddress } from "./format";
import { LocalTime } from "./LocalTime";
import { useWalletSnapshot, WalletGate } from "./WalletGate";
import { transactionMeaning } from "@/lib/chain/transaction-outcomes";
import { useTransactionOutcomes } from "./useTransactionOutcomes";
import { ResumeTransaction } from "./ResumeTransaction";
import { DrawProgress } from "./DrawProgress";
import { RaffleArtwork } from "./RaffleArtwork";
import { SellerActivity } from "./SellerActivity";
import checkout from "./BuyerCheckout.module.css";

export type AvailabilityReader = (snapshot: RaffleSnapshot, account: AccountRaffleState | null, trustReason?: string | null) => readonly ActionAvailability[];
export type RecoverCommitment = (commit: Hex) => Promise<ReserveRecord>;
export type RecordAgreement = (raffleId: bigint) => Promise<void>;
export type RaffleWorkspaceMode = "public" | "seller";

/** How often a waiting raffle page re-reads the contract while visible. */
const POLL_MS = 15_000;
/** Seconds before the sales deadline when re-reading starts. */
const DEADLINE_POLL_WINDOW = 15n * 60n;

function formatBps(bps: number) {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  return `${whole}${fraction ? `.${fraction.toString().padStart(2, "0").replace(/0+$/, "")}` : ""}%`;
}

function plural(count: bigint | number, one: string, many: string) {
  return `${count.toString()} ${count.toString() === "1" ? one : many}`;
}

function explorerAddress(chainId: number, value: string) {
  return chainId === 11155111 ? `https://sepolia.etherscan.io/address/${value}` : null;
}

function explorerToken(chainId: number, value: string, tokenId: bigint) {
  return chainId === 11155111 ? `https://sepolia.etherscan.io/token/${value}?a=${tokenId.toString()}` : null;
}

function admissionCopy(snapshot: RaffleSnapshot) {
  switch (snapshot.admission.status) {
    case "pending": return "Waiting for LABx review";
    case "changed": return "Changed since LABx review";
    case "approved": return "Approved for this exact draft";
    case "opened": return "Approved when listed";
    case "not-opened": return "No approval recorded when listed";
    default: {
      const exhaustive: never = snapshot.admission;
      return exhaustive;
    }
  }
}

/** Everything a waiting page shows except the block itself, so a background re-read that changes none of it is not applied. The deadlines include the times a step LABx runs goes back to the seller. */
function viewKey(snapshot: RaffleSnapshot, revealSeenAt: bigint | undefined) {
  const { block, ...rest } = snapshot;
  const r = snapshot.raffle;
  const reached = [r.salesEnd, r.salesEnd + snapshot.drawStartGrace, r.vrfRequestedAt + snapshot.randomnessGrace, r.drawnAt + snapshot.revealGrace, ...runnerLateTimes(snapshot, revealSeenAt)].map(deadline => block.timestamp >= deadline);
  return JSON.stringify([rest, reached], (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}

type WorkspaceScope =
  | { kind: "configured"; service: RaffleService; wallet: WalletSessionPort; id: bigint }
  | { kind: "unavailable"; wallet: WalletSessionPort; reason: string; id: bigint };

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "unavailable" | "legacy" | "mismatch" | "missing" | "error"; message: string; scope: WorkspaceScope }
  | { kind: "ready"; snapshot: RaffleSnapshot; scope: Extract<WorkspaceScope, { kind: "configured" }>; refresh: { kind: "idle" | "loading" } | { kind: "error"; message: string } };

function workspaceScope(browser: BrowserService, id: bigint): WorkspaceScope {
  return browser.kind === "configured"
    ? { kind: "configured", service: browser.service, wallet: browser.wallet, id }
    : { kind: "unavailable", wallet: browser.wallet, reason: browser.reason, id };
}

function sameWorkspace(left: WorkspaceScope, right: WorkspaceScope) {
  if (left.kind !== right.kind || left.wallet !== right.wallet || left.id !== right.id) return false;
  return left.kind === "configured" && right.kind === "configured"
    ? left.service === right.service
    : left.kind === "unavailable" && right.kind === "unavailable" && left.reason === right.reason;
}

export function RaffleWorkspace({ browser, id, termsHash, availableActions, saveCommitment, recoverCommitment, recordAgreement, mode = "public" }: {
  browser: BrowserService;
  id: bigint;
  termsHash: Hex;
  availableActions: AvailabilityReader;
  saveCommitment?: SaveCommitment;
  recoverCommitment?: RecoverCommitment;
  recordAgreement?: RecordAgreement;
  mode?: RaffleWorkspaceMode;
}) {
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  // The block time this page first showed raffle `id` with its draw confirmed. LABx's finish step is not late until 30 minutes after
  // it. Kept only in memory, so a reload starts the 30 minutes again; Run it yourself stays available meanwhile.
  const [revealSeen, setRevealSeen] = useState<{ id: bigint; at: bigint } | null>(null);
  const seenAt = revealSeen?.id === id ? revealSeen.at : undefined;
  const request = useRef(0);
  const currentScope = useRef(workspaceScope(browser, id));
  currentScope.current = workspaceScope(browser, id);

  async function refresh() {
    const observedScope = workspaceScope(browser, id);
    if (!sameWorkspace(observedScope, currentScope.current)) return;
    if (browser.kind === "unavailable") {
      setState({ kind: "unavailable", message: browser.reason, scope: observedScope });
      return;
    }
    const scope: Extract<WorkspaceScope, { kind: "configured" }> = { kind: "configured", service: browser.service, wallet: browser.wallet, id };
    const version = ++request.current;
    setState((current) => current.kind === "ready" && sameWorkspace(current.scope, scope)
      ? { ...current, refresh: { kind: "loading" } }
      : { kind: "loading" });
    try {
      const deployment = await browser.service.attest();
      if (version !== request.current || !sameWorkspace(scope, currentScope.current)) return;
      if (deployment.kind !== "verified") {
        setState((current) => current.kind === "ready" && sameWorkspace(current.scope, scope)
          ? { ...current, refresh: { kind: "error", message: deployment.reason } }
          : { kind: deployment.kind, message: deployment.reason, scope });
        return;
      }
      const snapshot = await browser.service.readRaffle({ id });
      if (version === request.current && sameWorkspace(scope, currentScope.current)) setState({ kind: "ready", snapshot, scope, refresh: { kind: "idle" } });
    } catch (error) {
      if (version !== request.current || !sameWorkspace(scope, currentScope.current)) return;
      const message = error instanceof Error ? error.message : "The raffle could not be loaded.";
      setState((current) => current.kind === "ready" && sameWorkspace(current.scope, scope)
        ? { ...current, refresh: { kind: "error", message } }
        : { kind: /not found|does not exist|unknown raffle/i.test(message) ? "missing" : "error", message, scope });
    }
  }

  /** Read-only background re-read. It never pauses controls, never claims a refresh version, applies only a changed view while canApply() holds, and leaves errors to Refresh. */
  async function poll(canApply: () => boolean) {
    if (browser.kind !== "configured") return;
    const scope: Extract<WorkspaceScope, { kind: "configured" }> = { kind: "configured", service: browser.service, wallet: browser.wallet, id };
    if (!sameWorkspace(scope, currentScope.current)) return;
    const version = request.current;
    try {
      const deployment = await browser.service.attest();
      if (deployment.kind !== "verified") return;
      const snapshot = await browser.service.readRaffle({ id });
      if (version !== request.current || !sameWorkspace(scope, currentScope.current) || !canApply()) return;
      setState((current) => current.kind === "ready" && current.refresh.kind === "idle" && sameWorkspace(current.scope, scope) && viewKey(current.snapshot, seenAt) !== viewKey(snapshot, seenAt)
        ? { ...current, snapshot }
        : current);
    } catch { /* The visible state stays as it was; the next tick or Refresh tries again. */ }
  }

  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
    // A new runtime or route ID invalidates the previous authoritative read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser.kind, browser.wallet, browser.kind === "configured" ? browser.service : browser.reason, id]);

  const scopedState = state.kind !== "loading" && sameWorkspace(state.scope, currentScope.current) ? state : { kind: "loading" } satisfies WorkspaceState;
  if (scopedState.kind === "loading") return <section className="section state-section"><div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading raffle</strong></div></div></section>;
  if (scopedState.kind !== "ready") {
    return (
      <section className="section stack missing-state">
        <h1 className="page-title">{scopedState.kind === "missing" ? "This raffle was not found." : scopedState.kind === "legacy" ? "Legacy raffle detected." : "Raffle unavailable."}</h1>
        <p className="notice warning" role={scopedState.kind === "error" ? "alert" : "status"}>{scopedState.message}</p>
        <p>Nothing can be bought or claimed until the raffle loads.</p>
        <div className="btn-row"><Link className="btn" href="/">Back to explore</Link><button className="btn btn-dark" type="button" onClick={() => void refresh()}>Try again</button></div>
      </section>
    );
  }

  if (browser.kind !== "configured") return null;
  const revealed = scopedState.snapshot.raffle.revealed;
  if (revealed && seenAt === undefined) setRevealSeen({ id, at: scopedState.snapshot.block.timestamp });
  return <LoadedRaffle browser={browser} snapshot={scopedState.snapshot} revealSeenAt={revealed ? seenAt ?? scopedState.snapshot.block.timestamp : undefined} termsHash={termsHash} availableActions={availableActions} saveCommitment={saveCommitment} recoverCommitment={recoverCommitment} recordAgreement={recordAgreement} refresh={refresh} poll={poll} refreshState={scopedState.refresh} mode={mode} />;
}

function LoadedRaffle({ browser, snapshot, revealSeenAt, termsHash, availableActions, saveCommitment, recoverCommitment, recordAgreement, refresh, poll, refreshState, mode }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  /** Block time this page first showed the draw confirmed, or undefined before it is confirmed. */
  revealSeenAt: bigint | undefined;
  termsHash: Hex;
  availableActions: AvailabilityReader;
  saveCommitment?: SaveCommitment;
  recoverCommitment?: RecoverCommitment;
  recordAgreement?: RecordAgreement;
  refresh: () => Promise<void>;
  poll: (canApply: () => boolean) => Promise<void>;
  refreshState: Extract<WorkspaceState, { kind: "ready" }>["refresh"];
  mode: RaffleWorkspaceMode;
}) {
  const walletSnapshot = useWalletSnapshot(browser.wallet);
  const [account, setAccount] = useState<AccountRaffleState | null>(null);
  const [accountState, setAccountState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [accountError, setAccountError] = useState("");
  const accountRequest = useRef(0);
  const pieceRef = useRef<HTMLElement>(null);
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const { outcomes } = useTransactionOutcomes(browser.service, browser.wallet);

  useEffect(() => {
    const version = ++accountRequest.current;
    setAccount(null);
    setAccountError("");
    const ownsRaffle = walletSnapshot.kind === "connected" && sellerOwnsRaffle(walletSnapshot.account, snapshot);
    if (walletSnapshot.kind !== "connected" || walletSnapshot.chainId !== browser.service.manifest.chainId || mode === "seller" && !ownsRaffle) {
      setAccountState("idle");
      return;
    }
    setAccountState("loading");
    void browser.service.readAccount({ id: snapshot.id, account: walletSnapshot.account, block: snapshot.block }).then((next) => {
      if (version === accountRequest.current) { setAccount(next); setAccountState("ready"); }
    }).catch((error: unknown) => {
      if (version === accountRequest.current) {
        setAccountError(error instanceof Error ? error.message : "Account state could not be loaded.");
        setAccountState("error");
      }
    });
    return () => { accountRequest.current += 1; };
  }, [browser.service, browser.service.manifest.chainId, mode, snapshot, walletSnapshot]);

  const currentAccount = account && account.snapshot.id === snapshot.id && account.snapshot.block.hash === snapshot.block.hash
    && walletSnapshot.kind === "connected" && account.account.toLowerCase() === walletSnapshot.account.toLowerCase() ? account : null;
  const trustReason = useActionTrust(browser.service, snapshot);
  const rawAvailability = availableActions(snapshot, currentAccount, trustReason);
  const availability = mode === "seller" ? sellerPortalActions(rawAvailability) : rawAvailability;
  const r = snapshot.raffle, now = snapshot.block.timestamp;
  const phase = Number(r.phase);
  const seller = walletSnapshot.kind === "connected" && sellerOwnsRaffle(walletSnapshot.account, snapshot);
  const reload = async () => { await refresh(); };
  // A chained seller step whose fresh check failed re-reads the raffle, so a raffle that moved on shows its next step and an
  // unchanged one keeps the error and its Try again.
  const recheck = () => poll(() => true);
  const writesEnabled = refreshState.kind === "idle";
  const writeDisabledReason = refreshState.kind === "loading"
    ? "Wait for the raffle to finish updating."
    : refreshState.kind === "error" ? "Refresh the raffle before your next step." : undefined;
  const availabilityStatus = catalogAvailability(snapshot);

  // Re-read silently only while the page can change by itself and nothing on the main path can be done: while the draw result is
  // pending, while LABx runs the seller's next draw step, and in the last 15 minutes before the sales deadline.
  // pollFrom is the chain time re-reading starts.
  const pollFrom = phase === 3 && now < r.vrfRequestedAt + snapshot.randomnessGrace
    || mode === "seller" && drawRunnerEnabled() && sellerNextStep(snapshot, sellerPortalActions(availability), true, revealSeenAt).kind === "automatic" ? now
    : phase === 1 && now < r.salesEnd && (mode === "seller" || !availabilityStatus.purchasable && publicRecoveryActions(snapshot, availability, currentAccount).length === 0) ? r.salesEnd - DEADLINE_POLL_WINDOW
    : null;
  // The page's block time stands still between reads, so the wait until pollFrom is timed from this read.
  const pollDelaySeconds = pollFrom !== null && pollFrom > now ? Number(pollFrom - now) : 0;
  const walletBusy = outcomes.some(item => item.kind === "submitting" || item.kind === "checking" || item.kind === "pending" || item.kind === "recovery" || item.kind === "unverified" || item.kind === "overflow");
  const shouldPoll = pollFrom !== null && refreshState.kind === "idle" && !walletBusy;
  useEffect(() => {
    if (!shouldPoll) return;
    const start = Date.now();
    let inFlight = false;
    // A review, a submission or confirmation, a wallet request about to start or in flight (aria-busy) or a chained seller step keeps
    // the page still, so a re-read never remounts a control mid-sequence. A read that started before the control got busy is dropped.
    const busy = () => !!pieceRef.current?.querySelector(".transaction-review, .transaction-state, [aria-busy=true]");
    const timer = window.setInterval(() => {
      if (Date.now() - start < pollDelaySeconds * 1000) return;
      if (inFlight || document.visibilityState !== "visible" || busy()) return;
      inFlight = true;
      void pollRef.current(() => !busy()).finally(() => { inFlight = false; });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [shouldPoll, pollDelaySeconds, now]);

  if (mode === "seller" && walletSnapshot.kind === "connected" && walletSnapshot.chainId !== browser.service.manifest.chainId) {
    return <section className="section stack missing-state"><h1 className="page-title">Switch your wallet to {networkName(browser.service.manifest.chainId)}.</h1><p className="lede">Seller controls stay hidden on other networks.</p><Link className="btn btn-dark" href="/seller">Back to seller studio</Link></section>;
  }
  if (mode === "seller" && walletSnapshot.kind !== "connected") {
    return <section className="section stack missing-state"><h1 className="page-title">Connect the wallet that created this raffle.</h1><WalletGate wallet={browser.wallet}><span /></WalletGate></section>;
  }
  if (mode === "seller" && !seller) {
    return <section className="section stack missing-state"><h1 className="page-title">This raffle belongs to another wallet.</h1><p className="lede">Switch to the wallet that created this raffle.</p><Link className="btn btn-dark" href="/seller">Back to your raffles</Link></section>;
  }

  const fromPrice = mode === "public" && availabilityStatus.purchasable ? fromPriceLabel(snapshot) : null;
  const chainId = browser.service.manifest.chainId;
  const editDraft = mode === "seller" && seller && phase === 0 && saveCommitment && writesEnabled
    ? <SellerDraftForm service={browser.service} wallet={browser.wallet} saveCommitment={saveCommitment} existing={snapshot} onConfirmed={reload} />
    : null;

  return (
    <>
      <div className="detail-path"><Link href={mode === "seller" ? "/seller" : "/"} className="detail-back"><span aria-hidden="true">←</span> {mode === "seller" ? "Back to studio" : "Back to explore"}</Link><button className="text-link" type="button" disabled={refreshState.kind === "loading"} onClick={() => void refresh()}>{refreshState.kind === "loading" ? "Updating…" : "Refresh"}</button></div>
      {refreshState.kind === "loading" ? <p className="notice" role="status">Updating the raffle. Actions are paused for a moment.</p> : null}
      {refreshState.kind === "error" ? <p className="notice error" role="alert">Couldn’t update the raffle: {refreshState.message} Actions stay paused until it loads. <button className="text-link" type="button" onClick={() => void refresh()}>Try again</button></p> : null}
      {trustReason ? <p className="notice warning" role="status">{trustReason} Existing recovery and receipt controls remain available.</p> : null}
      <ResumeTransaction browser={browser} pendingOnly showWait={false} scope={`raffle-${snapshot.id}`} confirmedThroughBlock={snapshot.block.number} onConfirmed={refresh} />
      <section ref={pieceRef} className={`section piece-layout piece-console chain-piece${mode === "seller" ? " seller-piece" : ""}`}>
        <div className="piece-visual chain-piece-visual">
          <div className="piece-visual-topline"><span>Raffle</span><span>#{snapshot.id.toString()}</span></div>
          <RaffleArtwork service={browser.service} snapshot={snapshot} showDescription />
        </div>
        <div className="purchase-console">
          <header className="purchase-header">
            <div className="purchase-eyebrow">{mode === "public" ? <p className="piece-seller">Seller {shortAddress(r.seller)}</p> : null}<span className="piece-status">{availabilityStatus.label}</span></div>
            <h1 className="page-title">{r.title}</h1>
            <p className="piece-deadline">{phase >= 2 || now >= r.salesEnd ? "Sales ended" : "Sales end"} <LocalTime at={r.salesEnd} /> · {r.escrowed ? "Prize locked" : "Prize not locked yet"}</p>
            {fromPrice ? <p className="piece-price">{fromPrice}</p> : null}
            <div className="piece-links"><Link className="guide-link" href="/fairness">Draw protections</Link>{mode === "seller" && phase >= 1 ? <Link className="guide-link" href={`/piece/${snapshot.id.toString()}`}>View public page</Link> : null}</div>
          </header>
          {accountState === "loading" ? <p className="notice" role="status">Loading your account state…</p> : null}
          {accountState === "error" ? <p className="notice error" role="alert">{accountError}</p> : null}
          {mode === "seller"
            ? <SellerActions browser={browser} snapshot={snapshot} revealSeenAt={revealSeenAt} account={currentAccount} availability={availability} recoverCommitment={recoverCommitment} onConfirmed={reload} onUnavailable={recheck} reloadFailed={refreshState.kind === "error" || accountState === "error"} writesEnabled={writesEnabled} writeDisabledReason={writeDisabledReason} editDraft={editDraft} />
            : <BuyerActions browser={browser} snapshot={snapshot} account={currentAccount} availability={availability} termsHash={termsHash} recordAgreement={recordAgreement} onConfirmed={reload} writesEnabled={writesEnabled} writeDisabledReason={writeDisabledReason} updating={refreshState.kind === "loading" || accountState === "loading"} />}
          {mode === "seller" && phase >= 1 ? <SellerProgress snapshot={snapshot} /> : null}
          {mode === "seller" && phase >= 1 ? <details className="workflow-details"><summary>Earnings</summary><SellerEarnings snapshot={snapshot} /></details> : null}
          {phase >= 1 ? <DrawProgress service={browser.service} snapshot={snapshot} /> : null}
          {mode === "seller" && phase >= 1 ? <details className="workflow-details"><summary>Sales and payouts</summary><SellerActivity service={browser.service} id={snapshot.id} refreshKey={snapshot.block.hash} /></details> : null}
          <details className="workflow-details"><summary>Contract and review details</summary><dl className="review-list">
            <div><dt>Seller</dt><dd className="hash">{r.seller}</dd></div>
            <div><dt>Prize</dt><dd>{r.escrowed ? "Locked in the raffle contract" : "Not locked yet"}</dd></div>
            <div><dt>LABx review</dt><dd>{admissionCopy(snapshot)}. This records review of the exact prize and draw-funding use; it is not proof of authenticity or future transferability.</dd></div>
            <div><dt>Processing fee</dt><dd>{formatBps(snapshot.policy.buyerFeeBps)} or {formatUsdcAmount(snapshot.policy.minBuyerFeeUsdc)} USDC per purchase, whichever is more. Not refunded, including on cancellation.</dd></div>
            <div><dt>Seller fee</dt><dd>{formatBps(snapshot.policy.sellerFeeBps)} of sales, charged only when the raffle finishes</dd></div>
            <div><dt>Network</dt><dd>{chainId === 11155111 ? "Ethereum Sepolia" : "Isolated local chain"} ({chainId})</dd></div>
            <div><dt>Raffle contract</dt><dd className="hash">{explorerAddress(chainId, browser.service.manifest.address) ? <a href={explorerAddress(chainId, browser.service.manifest.address) ?? undefined} target="_blank" rel="noreferrer">{browser.service.manifest.address} ↗</a> : browser.service.manifest.address}</dd></div>
            <div><dt>Collection contract</dt><dd className="hash">{explorerAddress(chainId, r.nft) ? <a href={explorerAddress(chainId, r.nft) ?? undefined} target="_blank" rel="noreferrer">{r.nft} ↗</a> : r.nft}</dd></div>
            <div><dt>Token</dt><dd>{explorerToken(chainId, r.nft, r.tokenId) ? <a href={explorerToken(chainId, r.nft, r.tokenId) ?? undefined} target="_blank" rel="noreferrer">#{r.tokenId.toString()} on explorer ↗</a> : `#${r.tokenId.toString()}`}</dd></div>
            <div><dt>Treasury</dt><dd className="hash">{snapshot.policy.treasury}</dd></div>
            <div><dt>State block</dt><dd>{snapshot.block.number.toString()}</dd></div>
          </dl></details>
        </div>
      </section>
    </>
  );
}

/** Seller's main-path progress: four steps and what sold. */
function SellerProgress({ snapshot }: { snapshot: RaffleSnapshot }) {
  const r = snapshot.raffle, phase = Number(r.phase);
  const steps: { key: string; label: ReactNode; done: boolean }[] = [
    { key: "listed", label: "Listed", done: phase >= 1 },
    { key: "closed", label: <>{phase >= 2 ? "Sales closed" : "Sales close"} <LocalTime at={r.salesEnd} short /></>, done: phase >= 2 },
    ...(phase === 6
      ? [{ key: "cancelled", label: "Cancelled", done: true }]
      : [{ key: "drawn", label: "Winner drawn", done: phase >= 4 }, { key: "paid", label: "Paid", done: phase === 5 && r.principalEscrow === 0n }])
  ];
  const current = steps.findIndex(step => !step.done);
  const sold = snapshot.packs.filter(pack => pack.sold > 0);
  return (
    <section className="seller-progress stack" aria-label="Raffle progress">
      <ol className="raffle-timeline">{steps.map((step, index) => <li key={step.key} data-state={step.done ? "done" : index === current ? "current" : "upcoming"} aria-current={index === current ? "step" : undefined}><span className="raffle-timeline-dot" aria-hidden="true">{step.done ? "✓" : ""}</span><span>{step.label}</span>{step.done ? <span className="sr"> (done)</span> : null}</li>)}</ol>
      <ul className="seller-sales">{sold.length
        ? sold.map((pack, index) => <li key={`${index}-${pack.name}`}><span>{pack.sold} × {pack.name} sold</span><strong>{formatUsdcAmount(pack.priceUsdc * BigInt(pack.sold))} USDC</strong></li>)
        : <li><span>No sales yet</span></li>}</ul>
    </section>
  );
}

/** Three plain numbers for the seller; refunds only for a cancelled raffle. */
function SellerEarnings({ snapshot }: { snapshot: RaffleSnapshot }) {
  const accounting = sellerAccounting(snapshot);
  const phase = Number(snapshot.raffle.phase);
  if (phase === 6) {
    return <dl className="review-list"><div><dt>Sales</dt><dd>{formatUsdcAmount(accounting.grossPrincipal)} USDC</dd></div><div><dt>Refunded to buyers</dt><dd>{formatUsdcAmount(accounting.refundedPrincipal)} USDC</dd></div><div><dt>Owed to buyers</dt><dd>{formatUsdcAmount(accounting.refundLiability)} USDC</dd></div></dl>;
  }
  const share = phase === 5 ? accounting.netProceeds : accounting.grossPrincipal - accounting.grossPrincipal * BigInt(snapshot.policy.sellerFeeBps) / FEE_DENOMINATOR;
  return (
    <dl className="review-list">
      <div><dt>Sales</dt><dd>{formatUsdcAmount(accounting.grossPrincipal)} USDC</dd></div>
      <div><dt>Your share after the {formatBps(snapshot.policy.sellerFeeBps)} fee</dt><dd>{formatUsdcAmount(share)} USDC{phase === 5 ? "" : " if the raffle completes"}</dd></div>
      {phase === 5 ? accounting.claimableProceeds > 0n
        ? <div><dt>Ready to claim</dt><dd>{formatUsdcAmount(accounting.claimableProceeds)} USDC</dd></div>
        : <div><dt>Paid to you</dt><dd>{formatUsdcAmount(accounting.paidProceeds)} USDC</dd></div> : null}
    </dl>
  );
}

const RECOVERY_KINDS = ["claimPrize", "refund", "reclaimPrize", "abortDrawing", "settle", "cancel", "close", "snapshot", "requestRandomness", "claimFee"] as const;
type RecoveryAvailability = ActionAvailability & { kind: typeof RECOVERY_KINDS[number] };
/** Steps anyone may run that pay the caller nothing. Buyers find them in a closed disclosure. */
const HELP_KINDS = new Set<RecoveryAvailability["kind"]>(["settle", "close", "snapshot", "requestRandomness", "claimFee"]);

/** Enabled public recovery actions in priority order. Draw steps disappear once no draw can happen. While a draw is still possible, the seller cancels from the seller page, so only the operator sees sales-phase cancellation here. */
function publicRecoveryActions(snapshot: RaffleSnapshot, availability: readonly ActionAvailability[], account: AccountRaffleState | null): readonly RecoveryAvailability[] {
  const blocked = drawBlocker(snapshot) !== null;
  const sellerCancelOnSellerPage = !blocked && (snapshot.raffle.phase === 1 || snapshot.raffle.phase === 2) && !!account && sellerOwnsRaffle(account.account, snapshot);
  return RECOVERY_KINDS.flatMap(kind => {
    const item = availability.find(candidate => candidate.kind === kind && candidate.enabled);
    if (!item || blocked && (kind === "close" || kind === "snapshot" || kind === "requestRandomness") || kind === "cancel" && sellerCancelOnSellerPage) return [];
    return [{ ...item, kind }];
  });
}

function recoveryGuidance(snapshot: RaffleSnapshot, kind: RecoveryAvailability["kind"], account: AccountRaffleState | null) {
  const blocker = drawBlocker(snapshot);
  const fees = snapshot.lotCount > 0n ? " Processing fees are not refunded." : "";
  if (kind === "cancel" && blocker) return `${cancelGuidance(snapshot, blocker, !!account && sellerOwnsRaffle(account.account, snapshot))}${fees}`;
  if (kind === "cancel" && snapshot.lotCount === 0n && (snapshot.raffle.phase === 1 || snapshot.raffle.phase === 2)) return "No memberships have been sold. Cancelling ends sales now so the seller can reclaim the NFT.";
  if (kind === "cancel" && snapshot.raffle.phase === 0) return "Cancels this draft before it is listed.";
  if (kind === "cancel") return `Enable refunds so buyers get their membership price back.${fees}`;
  if (kind === "abortDrawing") return `The draw didn’t return a result in time. Enable refunds so buyers get their membership price back.${fees}`;
  if (kind === "reclaimPrize") return RECLAIM_GUIDANCE;
  return "";
}

function recoveryAction(snapshot: RaffleSnapshot, kind: RecoveryAvailability["kind"]): WorkflowAction {
  return kind === "snapshot" ? { kind: "snapshot", id: snapshot.id, maxSteps: 100n } : { kind, id: snapshot.id };
}

/** Heading, sentence and button label for a buyer-facing action card. */
function buyerActionCopy(snapshot: RaffleSnapshot, item: RecoveryAvailability, account: AccountRaffleState | null) {
  if (item.kind === "claimPrize") return { title: `You won ${snapshot.raffle.title}`, text: "Claim your NFT to move it to your wallet.", label: "Claim your NFT" };
  if (item.kind === "refund" && account) {
    return { title: "This raffle was cancelled", text: `Claim ${formatUsdcAmount(account.principal)} USDC back. The ${formatUsdcAmount(account.fee)} USDC processing fee is not refunded.`, label: `Claim ${formatUsdcAmount(account.principal)} USDC refund` };
  }
  return { title: item.label, text: recoveryGuidance(snapshot, item.kind, account), label: item.label };
}

/** What a buyer or visitor is told when the page has nothing for them to do. */
function buyerStatus(snapshot: RaffleSnapshot, account: AccountRaffleState | null, wallet: string | null) {
  const r = snapshot.raffle;
  const blocker = drawBlocker(snapshot);
  const won = wallet !== null && r.winner !== zeroAddress && sameAddress(wallet, r.winner);
  const bought = account !== null && (account.principal > 0n || account.fee > 0n);
  const winner = won ? "you" : shortAddress(r.winner);
  switch (Number(r.phase)) {
    case 0: return { title: "Not listed yet", text: "Memberships aren’t on sale yet." };
    case 1:
      if (snapshot.block.timestamp >= r.salesEnd) return { title: "Sales have ended", text: blocker ?? "The draw runs next." };
      return { title: "Sales are paused", text: "LABx has paused new sales for now." };
    case 2: return { title: "Sales closed", text: blocker ?? "The draw runs next." };
    case 3: return { title: "Drawing a winner", text: "This usually takes a few minutes. This page updates on its own." };
    case 4: return won
      ? { title: `You won ${r.title}`, text: "You can claim it when the raffle finishes." }
      : { title: bought ? "Not this time" : "Winner drawn", text: `Winner: ${winner}. The raffle finishes next.` };
    case 5: return won
      ? { title: `You won ${r.title}`, text: r.escrowed ? "Your NFT is ready to claim." : "The NFT is in your wallet." }
      : { title: bought ? "Not this time" : "This raffle is complete", text: `The draw is complete. Winner: ${winner}.` };
    case 6: return { title: "This raffle was cancelled", text: bought ? "Your refund has been claimed. The processing fee is not refunded." : "Memberships are no longer on sale." };
    default: return { title: "Raffle state unavailable", text: "Refresh to load the raffle." };
  }
}

/** "3 × Gold, 30 bonus entries." for a confirmed purchase of this raffle, read from the submitted call. */
function purchaseRecap(snapshot: RaffleSnapshot, submitted: SubmittedAction) {
  try {
    const decoded = decodeFunctionData({ abi: raffleAbi, data: submitted.data });
    if (decoded.functionName !== "buyPack" && decoded.functionName !== "buyPackWithEth") return null;
    const pack = snapshot.packs[Number(decoded.args[1])];
    const quantity = BigInt(decoded.args[2]);
    if (!pack) return null;
    return `${quantity} × ${pack.name}, ${plural(BigInt(pack.bonusEntries) * quantity, "bonus entry", "bonus entries")}.`;
  } catch { return null; }
}

type Consent = { order: string | null; account: string | null; terms: boolean; rules: boolean; age: boolean };
const NO_CONSENT: Consent = { order: null, account: null, terms: false, rules: false, age: false };

function BuyerActions({ browser, snapshot, account, availability, termsHash, recordAgreement, onConfirmed, writesEnabled, writeDisabledReason, updating }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  account: AccountRaffleState | null;
  availability: readonly ActionAvailability[];
  termsHash: Hex;
  recordAgreement?: RecordAgreement;
  onConfirmed: () => Promise<void>;
  writesEnabled: boolean;
  writeDisabledReason?: string;
  /** The raffle or this wallet's account is being re-read. */
  updating: boolean;
}) {
  const [packId, setPackId] = useState(() => Math.max(0, snapshot.packs.findIndex((pack) => pack.active && pack.sold < pack.maxSupply)));
  const [quantity, setQuantity] = useState(1);
  const [payment, setPayment] = useState<"usdc" | "eth">("usdc");
  const [consent, setConsent] = useState<Consent>(NO_CONSENT);
  const [consentNotice, setConsentNotice] = useState("");
  const [agreementState, setAgreementState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [agreementError, setAgreementError] = useState("");
  const agreementInFlight = useRef<{ generation: number; id: number } | null>(null);
  const agreementSequence = useRef(0);
  const agreementGeneration = useRef(0);
  const [quote, setQuote] = useState<MembershipQuote | null>(null);
  const [quoteState, setQuoteState] = useState<"idle" | "loading" | "error">("idle");
  const [quoteError, setQuoteError] = useState("");
  const quoteRequest = useRef(0);
  const buyerWallet = useWalletSnapshot(browser.wallet);
  const buyerAccount = buyerWallet.kind === "connected" ? buyerWallet.account.toLowerCase() : null;
  const selected = snapshot.packs[packId];
  const phase = Number(snapshot.raffle.phase);
  const salesOpen = phase === 1 && snapshot.block.timestamp < snapshot.raffle.salesEnd && !snapshot.paused;
  const quantityValid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 20;
  const { owner, outcomes } = useTransactionOutcomes(browser.service, browser.wallet);
  const purchaseOutcome = [...outcomes].reverse().find(outcome => outcome.kind === "terminal" && outcome.confirmation.receipt.status === "success"
    && transactionMeaning(browser.service, outcome.submitted)?.purchase && transactionMeaning(browser.service, outcome.submitted)?.raffleId === snapshot.id);
  const purchaseConfirmation = purchaseOutcome?.kind === "terminal" && purchaseOutcome.confirmation.receipt.status === "success" ? purchaseOutcome.confirmation.receipt : null;
  const canBuyAgain = purchaseConfirmation !== null && writesEnabled && account !== null && quote !== null
    && snapshot.block.number >= purchaseConfirmation.blockNumber && account.snapshot.block.number >= purchaseConfirmation.blockNumber
    && quote.block.number >= purchaseConfirmation.blockNumber && salesOpen;
  const purchasesEnded = phase >= 2 || snapshot.block.timestamp >= snapshot.raffle.salesEnd
    || snapshot.packs.length > 0 && snapshot.packs.every(pack => pack.sold >= pack.maxSupply);
  const canArchivePurchase = purchaseConfirmation !== null && purchasesEnded && writesEnabled && account !== null
    && snapshot.block.number >= purchaseConfirmation.blockNumber && account.snapshot.block.number >= purchaseConfirmation.blockNumber;
  const [selectionNotice, setSelectionNotice] = useState("");
  const [receiptError, setReceiptError] = useState("");

  useEffect(() => {
    if (selected?.active && selected.sold < selected.maxSupply) return;
    const fallback = snapshot.packs.findIndex((pack) => pack.active && pack.sold < pack.maxSupply);
    if (fallback >= 0 && fallback !== packId) {
      setSelectionNotice(`The selected pack is no longer available. ${snapshot.packs[fallback].name} is now selected. Check the new total and tick the boxes again.`);
      setPackId(fallback);
    }
  }, [packId, selected, snapshot.packs]);

  useEffect(() => {
    const version = ++quoteRequest.current;
    setQuote(null);
    agreementGeneration.current += 1;
    setAgreementState("idle");
    setAgreementError("");
    if (!selected || !quantityValid || !selected.active || selected.sold >= selected.maxSupply || !salesOpen) {
      setQuoteState("idle");
      return;
    }
    setQuoteState("loading");
    setQuoteError("");
    void browser.service.quoteMembership({ id: snapshot.id, packId, quantity }).then((next) => {
      if (version === quoteRequest.current) { setQuote(next); setQuoteState("idle"); }
    }).catch((error: unknown) => {
      if (version === quoteRequest.current) { setQuoteError(error instanceof Error ? error.message : "A current quote is unavailable."); setQuoteState("error"); }
    });
    return () => { quoteRequest.current += 1; agreementGeneration.current += 1; };
  }, [browser.service, buyerWallet.revision, packId, quantity, quantityValid, salesOpen, selected, snapshot.id]);

  // The three ticks belong to one order (pack, quantity, total, terms, payment) and one account.
  // They survive refreshes and Buy again while those stay the same; a real change clears them and says why.
  const order = quote && selected ? `${packId}:${quantity}:${quote.totalUsdc}:${termsHash.toLowerCase()}:${payment}` : null;
  useEffect(() => {
    if (!consent.terms && !consent.rules && !consent.age) return;
    const accountChanged = buyerAccount !== null && consent.account !== null && consent.account !== buyerAccount;
    const orderChanged = order !== null && consent.order !== null && consent.order !== order;
    if (accountChanged || orderChanged) {
      setConsent(NO_CONSENT);
      setConsentNotice(accountChanged ? "You switched wallets, so tick the boxes again." : "Your order changed, so tick the boxes again.");
    } else if (consent.order === null && order !== null || consent.account === null && buyerAccount !== null) {
      setConsent({ ...consent, order: consent.order ?? order, account: consent.account ?? buyerAccount });
    }
  }, [consent, order, buyerAccount]);
  const consentCurrent = order !== null && consent.order === order && (consent.account === null || consent.account === buyerAccount);
  const tick = (field: "terms" | "rules" | "age", checked: boolean) => {
    setConsentNotice("");
    setConsent(current => ({ ...current, [field]: checked, order: current.order ?? order, account: current.account ?? buyerAccount }));
  };

  const byKind = (kind: WorkflowAction["kind"]) => availability.find((item) => item.kind === kind);
  const termsMatch = snapshot.policy.termsHash.toLowerCase() === termsHash.toLowerCase();
  const allAgreed = consentCurrent && consent.terms && consent.rules && consent.age;
  const needsApproval = quote !== null && account !== null && account.usdcAllowance < quote.totalUsdc;
  const insufficientUsdc = payment === "usdc" && quote !== null && account !== null && account.usdcBalance < quote.totalUsdc;
  const approval = byKind("approveUsdc");
  const purchase = byKind("buyMembership");
  const selectedPayment = payment === "usdc"
    ? { kind: "usdc" as const }
    : quote?.eth.kind === "available"
      ? { kind: "eth" as const, maxEth: quote.eth.maxEth, slippageBps: quote.eth.slippageBps, deadline: quote.eth.deadline }
      : null;
  const purchaseAction: WorkflowAction | null = quote && selected && allAgreed && termsMatch && selectedPayment
    ? {
        kind: "buyMembership", id: snapshot.id, packId, quantity, acceptedTerms: termsHash,
        agreements: { terms: true, rules: true, age: true },
        payment: selectedPayment
      }
    : null;
  const recovery = publicRecoveryActions(snapshot, availability, account);
  const mainActions = recovery.filter(item => !HELP_KINDS.has(item.kind));
  const helpActions = recovery.filter(item => HELP_KINDS.has(item.kind));
  const total = quote ? formatUsdcAmount(quote.totalUsdc) : null;
  const steps = account && quote && termsMatch && !insufficientUsdc ? [
    ...(payment === "usdc" ? [{ label: needsApproval ? `Approve ${total} USDC` : `${total} USDC approved`, done: !needsApproval }] : []),
    { label: agreementState === "saved" ? "Agreement signed" : "Tick the boxes and sign the agreement", done: agreementState === "saved" },
    { label: "Purchase membership", done: false }
  ] : null;
  const currentStep = steps?.findIndex(step => !step.done) ?? -1;

  async function recordReviewedAgreement() {
    if (!recordAgreement || !writesEnabled) return;
    const generation = agreementGeneration.current;
    if (agreementInFlight.current?.generation === generation) return;
    const active = { generation, id: ++agreementSequence.current };
    agreementInFlight.current = active;
    setAgreementState("saving");
    setAgreementError("");
    try {
      await recordAgreement(snapshot.id);
      if (generation === agreementGeneration.current) setAgreementState("saved");
    } catch (error) {
      if (generation === agreementGeneration.current) {
        setAgreementError(error instanceof Error ? error.message : "Agreement storage was not acknowledged.");
        setAgreementState("error");
      }
    } finally {
      if (agreementInFlight.current?.generation === active.generation && agreementInFlight.current.id === active.id) agreementInFlight.current = null;
    }
  }

  async function buyAgain() {
    if ((!canBuyAgain && !canArchivePurchase) || !purchaseOutcome) return;
    const expected = browser.wallet.getSnapshot(), version = agreementGeneration.current;
    try {
      await owner.acknowledge(purchaseOutcome, browser.wallet);
      if (browser.wallet.getSnapshot().revision !== expected.revision || agreementGeneration.current !== version) return;
      // Ticks stay for an unchanged order; the agreement is signed again for every purchase.
      setAgreementState("idle");
      agreementGeneration.current += 1;
      setReceiptError("");
    } catch (error) { if (browser.wallet.getSnapshot().revision === expected.revision && agreementGeneration.current === version) setReceiptError(error instanceof Error ? error.message : "The receipt could not be acknowledged."); }
  }

  const status = !salesOpen && mainActions.length === 0 ? buyerStatus(snapshot, account, buyerAccount) : null;
  return (
    <div className="stack buyer-flow">
      {purchaseConfirmation && phase === 1 ? <div className="transaction-state notice ok stack" role="status"><strong>You’re in</strong><span>{purchaseOutcome?.kind === "terminal" ? purchaseRecap(snapshot, purchaseOutcome.submitted) ?? "Your purchase is confirmed." : "Your purchase is confirmed."} The draw runs after <LocalTime at={snapshot.raffle.salesEnd} />.</span><details><summary>Transaction details</summary><p>Confirmed in block {purchaseConfirmation.blockNumber.toString()}.</p><p className="hash">{purchaseConfirmation.hash}</p></details>{purchasesEnded ? <button className="text-link" type="button" disabled={!canArchivePurchase} onClick={buyAgain}>Dismiss</button> : salesOpen ? <><button className="btn" type="button" disabled={!canBuyAgain} onClick={buyAgain}>Buy again</button>{!canBuyAgain && (updating || quoteState === "loading") ? <p>Updating… Buy again will be ready in a moment.</p> : null}</> : null}{receiptError ? <p role="alert">{receiptError}</p> : null}</div> : null}
      {salesOpen && !purchaseConfirmation ? (
        <>
          {selectionNotice ? <p className="notice warning" role="status">{selectionNotice}</p> : null}
          <section className="pack-selector" aria-labelledby="pack-title">
            <div className="console-section-heading"><h2 id="pack-title">Choose membership</h2></div>
            <div className="chain-pack-grid" role="radiogroup" aria-label="Membership packs">
              {snapshot.packs.map((pack, index) => {
                const remaining = Math.max(0, Number(pack.maxSupply) - Number(pack.sold));
                return <MembershipPackCard key={`${index}-${pack.name}`} name={pack.name} price={formatUsdcAmount(pack.priceUsdc)} bonusEntries={pack.bonusEntries} remaining={remaining} value={String(index)} selected={index === packId} disabled={!pack.active || remaining === 0} onSelect={() => setPackId(index)} />;
              })}
            </div>
            <p className="pack-fee-note">Plus a processing fee of {formatBps(snapshot.policy.buyerFeeBps)} or {formatUsdcAmount(snapshot.policy.minBuyerFeeUsdc)} USDC per purchase, whichever is more. Not refunded.</p>
          </section>
          <section className={checkout.panel} aria-labelledby="order-title">
          <h2 id="order-title" className={checkout.heading}>Your membership</h2>
          <div className={checkout.quantity}>
            <label htmlFor="membership-qty">Quantity</label>
            <input id="membership-qty" inputMode="numeric" type="number" min={1} max={20} step={1} aria-describedby={`membership-qty-help${quantityValid ? "" : " membership-qty-error"}`} aria-invalid={!quantityValid} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} />
            <p id="membership-qty-help">1–20 per purchase, subject to availability.</p>
          </div>
          <div className={`order-total ${checkout.summary}`} aria-live="polite" aria-atomic="true">
            {quote ? <dl className={checkout.breakdown}>
              <div><dt>Memberships</dt><dd>{formatUsdcAmount(quote.principal)} USDC</dd></div>
              <div><dt>Processing fee <span>Not refunded</span></dt><dd>{formatUsdcAmount(quote.fee)} USDC</dd></div>
              <div className={checkout.total}><dt>Total</dt><dd>{total} <small>USDC</small></dd></div>
            </dl> : <p>{quoteState === "loading" ? "Updating total…" : "Choose an available membership."}</p>}
            {quote ? <p className={checkout.entries}>{plural(quote.bonusEntries, "bonus entry", "bonus entries")} included</p> : null}
          </div>
          {!quantityValid ? <p id="membership-qty-error" className="notice error" role="alert">Quantity must be a whole number from 1 to 20.</p> : null}
          {quoteState === "error" ? <p className="notice error" role="alert">{quoteError}</p> : null}
          {payment === "eth" && quote?.eth.kind === "unavailable" ? <div className="notice warning stack" role="status"><p>ETH payment is no longer available for this quote. Choose USDC and review the total again.</p><button className="btn" type="button" onClick={() => { setPayment("usdc"); setConsent(NO_CONSENT); setAgreementState("idle"); agreementGeneration.current += 1; }}>Use USDC</button></div> : null}
          {quote?.eth.kind === "available" ? <><fieldset className="payment-choice"><legend>Payment</legend><label><input type="radio" name="payment" checked={payment === "usdc"} onChange={() => setPayment("usdc")} /> USDC</label><label><input type="radio" name="payment" checked={payment === "eth"} onChange={() => setPayment("eth")} /> ETH quote</label></fieldset>{payment === "eth" ? <dl className="review-list"><div><dt>Current quote</dt><dd>{formatEther(quote.eth.requiredEth)} ETH</dd></div><div><dt>Maximum sent</dt><dd>{formatEther(quote.eth.maxEth)} ETH</dd></div><div><dt>Slippage cap</dt><dd>{quote.eth.slippageBps / 100}%</dd></div><div><dt>Expires</dt><dd><LocalTime at={quote.eth.deadline} /></dd></div></dl> : null}</> : null}
          {!termsMatch ? <p className="notice error" role="alert">The raffle’s published terms do not match this website version. Purchasing is blocked.</p> : (
            <fieldset className={`agreements ${checkout.agreements}`}>
              <legend>Before you buy</legend>
              <label><input type="checkbox" checked={consent.terms} onChange={(event) => tick("terms", event.target.checked)} /><span>I agree to the <Link href="/legal">membership terms</Link>.</span></label>
              <label><input type="checkbox" checked={consent.rules} onChange={(event) => tick("rules", event.target.checked)} /><span>I agree to the <Link href="/rules">draw rules</Link>.</span></label>
              <label><input type="checkbox" checked={consent.age} onChange={(event) => tick("age", event.target.checked)} /><span>I confirm I am at least 18.</span></label>
            </fieldset>
          )}
          {consentNotice ? <p className="notice" role="status">{consentNotice}</p> : null}
          {steps ? <ol className={checkout.steps} aria-label="Purchase steps">{steps.map((step, index) => <li key={step.label} data-state={step.done ? "done" : index === currentStep ? "current" : "upcoming"} aria-current={index === currentStep ? "step" : undefined}><span aria-hidden="true">{step.done ? "✓" : index + 1}</span><span>{step.label}</span>{step.done ? <span className="sr"> (done)</span> : null}</li>)}</ol> : null}
          <div className={`${checkout.action} checkout-bar`}>
          {total && selected ? <p className={checkout.barTotal}><span>{selected.name} × {quantity}</span><strong>{total} USDC</strong></p> : null}
          <WalletGate wallet={browser.wallet} goal="buy">
            {!account ? <p className="notice" role="status">Checking your USDC balance…</p> : !quote ? <p className="notice" role="status">{quoteState === "loading" ? "Updating total…" : "Choose an available membership."}</p> : insufficientUsdc ? <p className="notice warning" role="status">Not enough USDC. You need {total} USDC.</p> : needsApproval && payment === "usdc" ? (
              approval?.enabled ? <TransactionFlow key={`approve-${packId}-${quantity}-${quote.totalUsdc}`} service={browser.service} wallet={browser.wallet} action={{ kind: "approveUsdc", id: snapshot.id, packId, quantity }} label={`Approve ${total} USDC`} formatUsdc={formatUsdcAmount} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /> : <p className="notice warning" role="status">{approval?.reason || "USDC approval is not available."}</p>
            ) : !allAgreed ? <p className="notice warning" role="status">Tick the three boxes to continue.</p>
              : agreementState !== "saved" ? <div className="stack"><button className="btn" type="button" disabled={!recordAgreement || agreementState === "saving" || !writesEnabled} title={!writesEnabled ? writeDisabledReason : undefined} onClick={() => void recordReviewedAgreement()}>{agreementState === "saving" ? "Waiting for signature…" : "Sign agreement"}</button>{!recordAgreement ? <p className="notice warning" role="status">Purchases are unavailable right now.</p> : null}{agreementState === "error" ? <p className="notice error" role="alert">{agreementError}</p> : null}</div>
                : purchaseAction && purchase?.enabled ? <TransactionFlow key={`buy-${packId}-${quantity}-${payment}`} service={browser.service} wallet={browser.wallet} action={purchaseAction} label="Purchase membership" formatUsdc={formatUsdcAmount} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /> : <p className="notice warning" role="status">{purchase?.reason || "Purchase is not available."}</p>}
          </WalletGate>
          </div>
          </section>
        </>
      ) : null}
      {status ? <section className="workflow-next stack" role="status"><h2>{status.title}</h2><p>{status.text}</p></section> : null}
      {!salesOpen && buyerWallet.kind === "disconnected" ? <WalletGate wallet={browser.wallet}><span /></WalletGate> : null}
      {mainActions.map(item => {
        const copy = buyerActionCopy(snapshot, item, account);
        return <section key={item.kind} className="workflow-next stack"><div><h2>{copy.title}</h2>{copy.text ? <p>{copy.text}</p> : null}</div><TransactionFlow service={browser.service} wallet={browser.wallet} action={recoveryAction(snapshot, item.kind)} label={copy.label} formatUsdc={formatUsdcAmount} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /></section>;
      })}
      {account && account.principal > 0n && phase !== 6 ? <div className="account-balance"><span>Membership price paid</span><strong>{formatUsdcAmount(account.principal)} USDC</strong><small>{phase <= 3 ? `Plus the ${formatUsdcAmount(account.fee)} USDC processing fee. If this raffle is cancelled, you get ${formatUsdcAmount(account.principal)} USDC back. The processing fee is not refunded.` : `Plus the ${formatUsdcAmount(account.fee)} USDC processing fee.`}</small></div> : null}
      {helpActions.length ? <details className="workflow-details help-finish"><summary>Other actions</summary><div className="stack"><p>Optional. Anyone can run these steps for a network fee. They pay you nothing.</p>{helpActions.map(item => <TransactionFlow key={item.kind} service={browser.service} wallet={browser.wallet} action={recoveryAction(snapshot, item.kind)} label={item.label} formatUsdc={formatUsdcAmount} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} />)}</div></details> : null}
    </div>
  );
}

/** State-only seller calls: no amount leaves the seller's wallet, so they can go straight to the wallet like List. */
const STATE_ONLY_KINDS = new Set<SellerActionKind>(["close", "snapshot", "requestRandomness", "settle", "cancel", "abortDrawing", "reclaimPrize", "claimProceeds"]);

/** The one fact a seller can check on a step's card before the wallet opens. */
function sellerActionFact(snapshot: RaffleSnapshot, kind: SellerActionKind) {
  const r = snapshot.raffle;
  switch (kind) {
    case "snapshot": return `${plural(snapshot.lotCount, "purchase", "purchases")} to count.`;
    case "requestRandomness": return `${plural(r.snapshotTotal, "entry is", "entries are")} in the draw.`;
    case "settle": return `Your share after the ${formatBps(snapshot.policy.sellerFeeBps)} fee: ${formatUsdcAmount(snapshot.accounting.grossPrincipal - snapshot.accounting.grossPrincipal * BigInt(snapshot.policy.sellerFeeBps) / FEE_DENOMINATOR)} USDC.`;
    case "claimProceeds": return `Sends ${formatUsdcAmount(r.principalEscrow)} USDC to ${shortAddress(r.seller)}.`;
    case "reclaimPrize": return `Returns NFT #${r.tokenId.toString()} to ${shortAddress(r.seller)}.`;
    case "cancel": return snapshot.lotCount > 0n ? "Processing fees are not refunded." : "";
    case "abortDrawing": return "Processing fees are not refunded.";
    default: return "";
  }
}

function SellerActions({ browser, snapshot, revealSeenAt, account, availability, recoverCommitment, onConfirmed, onUnavailable, reloadFailed, writesEnabled, writeDisabledReason, editDraft }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  revealSeenAt: bigint | undefined;
  account: AccountRaffleState | null;
  availability: readonly ActionAvailability[];
  recoverCommitment?: RecoverCommitment;
  onConfirmed: () => Promise<void>;
  onUnavailable: () => Promise<void>;
  /** The last read of the raffle or of this wallet's account failed. */
  reloadFailed: boolean;
  writesEnabled: boolean;
  writeDisabledReason?: string;
  editDraft: ReactNode;
}) {
  const wallet = useWalletSnapshot(browser.wallet);
  // The cancellation this page just confirmed, so Reclaim NFT can follow it once. Kept only in memory: a reload never resumes it.
  // from is the raffle state shown when it confirmed, and revision the wallet session that confirmed it.
  const [reclaimAfter, setReclaimAfter] = useState<{ id: bigint; block: bigint; from: RaffleSnapshot; revision: number } | null>(null);
  const loaded = account !== null;
  useEffect(() => {
    // The reload after the cancellation decides once. Its first loaded state at or after the cancellation starts Reclaim NFT.
    // A failed raffle or account read, an older state or a wallet change ends the sequence, so no later refresh or Try again starts it.
    if (reclaimAfter && (reloadFailed || wallet.revision !== reclaimAfter.revision || loaded && (snapshot !== reclaimAfter.from || snapshot.block.number >= reclaimAfter.block))) setReclaimAfter(null);
  }, [reclaimAfter, reloadFailed, wallet.revision, loaded, snapshot]);
  if (!account) return <WalletGate wallet={browser.wallet}><p className="notice" role="status">Loading seller controls…</p></WalletGate>;
  const sellerAvailability = sellerPortalActions(availability);
  const next = sellerNextStep(snapshot, sellerAvailability, drawRunnerEnabled(), revealSeenAt);
  const primary = next.kind === "action" ? next.action : null;
  const reclaimNow = primary?.kind === "reclaimPrize" && reclaimAfter !== null && reclaimAfter.id === snapshot.id && reclaimAfter.revision === wallet.revision
    && !reloadFailed && snapshot.block.number >= reclaimAfter.block;
  const secondary = sellerSecondaryActions(snapshot, sellerAvailability, next);
  const control = (item: SellerActionAvailability) => <SellerActionControl key={item.kind} browser={browser} snapshot={snapshot} availability={item} recoverCommitment={recoverCommitment} onConfirmed={onConfirmed} onUnavailable={onUnavailable} writesEnabled={writesEnabled} writeDisabledReason={writeDisabledReason} />;
  const paid = Number(snapshot.raffle.phase) === 5 && snapshot.raffle.principalEscrow === 0n ? sellerAccounting(snapshot).paidProceeds : null;
  return (
    // aria-busy holds the page's background re-read until Reclaim NFT has started after its cancellation.
    <div className="stack" aria-busy={reclaimAfter !== null || undefined}>
      {primary ? <SellerActionControl key={primary.kind} primary description={next.kind === "action" ? next.message : undefined} browser={browser} snapshot={snapshot} availability={primary} recoverCommitment={recoverCommitment} onConfirmed={onConfirmed} onUnavailable={onUnavailable} onCancelled={block => setReclaimAfter({ id: snapshot.id, block, from: snapshot, revision: wallet.revision })} submitOnMount={reclaimNow} writesEnabled={writesEnabled} writeDisabledReason={writeDisabledReason} />
        : next.kind === "automatic" ? <><section className="workflow-next stack" role="status"><h2>{next.title}</h2><p>{next.message}</p></section><details className="workflow-details"><summary>Run it yourself</summary>{control(next.action)}</details></>
        : next.kind === "waiting" ? <section className="workflow-next stack" role="status"><h2>{next.title}</h2><p>{next.message}</p>{paid !== null ? <p className="workflow-fact">Paid to you: {formatUsdcAmount(paid)} USDC</p> : null}</section> : null}
      {editDraft || secondary.length ? <div className="seller-more">
        {editDraft ? <details className="workflow-details"><summary>Edit draft</summary>{editDraft}</details> : null}
        {Number(snapshot.raffle.phase) === 0
          ? secondary.map(item => <details key={item.kind} className="workflow-details"><summary>{item.label}</summary>{control(item)}</details>)
          : secondary.length ? <details className="workflow-details"><summary>Advanced ({secondary.length})</summary><div className="stack">{secondary.map(control)}</div></details> : null}
      </div> : null}
    </div>
  );
}

function SellerActionControl({ browser, snapshot, availability, recoverCommitment, onConfirmed, onUnavailable, onCancelled, submitOnMount = false, writesEnabled, writeDisabledReason, primary = false, description }: {
  primary?: boolean;
  description?: string;
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  availability: SellerActionAvailability;
  recoverCommitment?: RecoverCommitment;
  onConfirmed: () => Promise<void>;
  /** Re-reads the raffle when a step sent on its own finds it can no longer run. */
  onUnavailable: () => Promise<void>;
  /** Called with the block of a cancellation confirmed straight from its own click, when Reclaim NFT should follow. */
  onCancelled?: (block: bigint) => void;
  /** Send this step once on mount: the seller's click on the previous step asked for it. */
  submitOnMount?: boolean;
  writesEnabled: boolean;
  writeDisabledReason?: string;
}) {
  const [recovered, setRecovered] = useState<ReserveRecord | null>(null);
  const [preflight, setPreflight] = useState<"idle" | "loading" | "error">("idle");
  const [preflightError, setPreflightError] = useState("");
  const preflightInFlight = useRef(false);

  async function recoverSavedCommitment() {
    if (!recoverCommitment || preflightInFlight.current) return;
    preflightInFlight.current = true;
    setPreflight("loading");
    setPreflightError("");
    try {
      const value = await recoverCommitment(snapshot.raffle.reserveCommit);
      if (value.commit.toLowerCase() !== snapshot.raffle.reserveCommit.toLowerCase()) throw new Error("The saved draw setup does not match this raffle.");
      setRecovered(value);
      setPreflight("idle");
    } catch (error) {
      setPreflightError(isWalletRequestRejected(error) ? "Cancelled in your wallet. Nothing was sent." : error instanceof Error ? error.message : "The draw setup could not be loaded.");
      setPreflight("error");
    } finally { preflightInFlight.current = false; }
  }

  if (primary && (availability.kind === "approvePrize" || availability.kind === "escrow")) return <CompleteCreate service={browser.service} wallet={browser.wallet} snapshot={snapshot} disabled={!writesEnabled} onConfirmed={onConfirmed} />;
  if (availability.kind === "open") return <OpeningPolicyControl browser={browser} snapshot={snapshot} onConfirmed={onConfirmed} writesEnabled={writesEnabled && primary} writeDisabledReason={writeDisabledReason} />;
  if (availability.kind === "reveal") {
    if (!recoverCommitment) return <p className="notice warning" role="status">Draw setup recovery is not configured, so the draw cannot be confirmed here.</p>;
    const heading = <div><h2>{availability.label}</h2><p>{sellerStepText(snapshot, "reveal")}</p></div>;
    if (!recovered) return <section className="workflow-next stack">{heading}<button className="btn" type="button" aria-busy={preflight === "loading" || undefined} disabled={preflight === "loading" || !writesEnabled} title={!writesEnabled ? writeDisabledReason : undefined} onClick={() => void recoverSavedCommitment()}>{preflight === "loading" ? "Waiting for signature…" : availability.label}</button>{preflight === "error" ? <p className="notice error" role="alert">{preflightError}</p> : null}</section>;
    // One click: the signature above loaded the draw setup, so the confirmation goes straight to the wallet once. A retry needs a click.
    return <section className="workflow-next stack">{heading}<TransactionFlow service={browser.service} wallet={browser.wallet} action={{ kind: "reveal", id: snapshot.id, publicHash: recovered.publicHash, privateHash: recovered.privateHash, salt: recovered.salt }} label={availability.label} submitOnClick submitOnMount formatUsdc={formatUsdcAmount} onConfirmed={onConfirmed} onUnavailable={onUnavailable} disabled={!writesEnabled} disabledReason={writeDisabledReason} /></section>;
  }
  if (availability.kind === "updateDraft") return null;
  const action: WorkflowAction = availability.kind === "snapshot"
    ? { kind: "snapshot", id: snapshot.id, maxSteps: 100n }
    : { kind: availability.kind, id: snapshot.id };
  const label = availability.kind === "claimProceeds" ? `Claim ${formatUsdcAmount(snapshot.raffle.principalEscrow)} USDC` : availability.label;
  const fact = sellerActionFact(snapshot, availability.kind);
  // Reclaim NFT follows only a cancellation whose own click confirmed it. A rejection, revert or later check ends the sequence.
  const reclaimNext = availability.kind === "cancel" && cancelReclaimsPrize(snapshot) ? onCancelled : undefined;
  const confirmed = reclaimNext
    ? async (confirmation: Extract<Confirmation, { kind: "confirmed" }>, _submitted: SubmittedAction, direct: boolean) => { if (direct) reclaimNext(confirmation.blockNumber); await onConfirmed(); }
    : onConfirmed;
  return <section className="workflow-next stack"><div><h2>{label}</h2><p>{availability.reason || description || sellerStepText(snapshot, availability.kind)}</p>{fact ? <p className="workflow-fact">{fact}</p> : null}</div><TransactionFlow service={browser.service} wallet={browser.wallet} action={action} submitOnClick={STATE_ONLY_KINDS.has(availability.kind)} submitOnMount={submitOnMount} onUnavailable={onUnavailable} prepareOnMount={primary && (action.kind === "approvePrize" || action.kind === "escrow")} label={label} formatUsdc={formatUsdcAmount} onConfirmed={confirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /></section>;
}

function OpeningPolicyControl({ browser, snapshot, onConfirmed, writesEnabled, writeDisabledReason }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  onConfirmed: () => Promise<void>;
  writesEnabled: boolean;
  writeDisabledReason?: string;
}) {
  const wallet = useWalletSnapshot(browser.wallet);
  const [retry, setRetry] = useState(0);
  const identity = `${snapshot.id}:${snapshot.block.hash}:${snapshot.admission.reviewHash}:${wallet.revision}:${writesEnabled}:${retry}`;
  const context = useRef({ service: browser.service, wallet: browser.wallet, identity, generation: 0 });
  if (context.current.service !== browser.service || context.current.wallet !== browser.wallet || context.current.identity !== identity) {
    context.current = { service: browser.service, wallet: browser.wallet, identity, generation: context.current.generation + 1 };
  }
  const scope = context.current.generation;
  type PolicyState = { scope: number } & (
    | { kind: "loading" }
    | { kind: "ready"; policy: Awaited<ReturnType<RaffleService["openingPolicy"]>> }
    | { kind: "error"; message: string }
  );
  const [state, setState] = useState<PolicyState>({ scope, kind: "loading" });
  useEffect(() => {
    const expected = context.current;
    let active = true;
    setState({ scope: expected.generation, kind: "loading" });
    if (!writesEnabled || wallet.kind !== "connected" || wallet.chainId !== browser.service.manifest.chainId) return;
    const isCurrent = () => active && context.current === expected && browser.wallet.getSnapshot().revision === wallet.revision;
    void browser.service.openingPolicy().then(policy => {
      if (isCurrent()) setState({ scope: expected.generation, kind: "ready", policy });
    }).catch(error => {
      if (isCurrent()) setState({ scope: expected.generation, kind: "error", message: error instanceof Error ? error.message : "Listing fees could not be loaded." });
    });
    return () => { active = false; };
    // Scope includes the deployment service, raffle snapshot, session and explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  if (state.scope !== scope || state.kind !== "ready") return <section className="workflow-next stack"><h2>List your raffle</h2>{state.scope === scope && state.kind === "error" ? <><p className="notice error" role="alert">{state.message}</p><button className="btn" type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></> : <p role="status">{writesEnabled ? "Loading…" : writeDisabledReason || "Loading…"}</p>}</section>;
  const { policy } = state;
  return <section className="workflow-next stack"><div><h2>List your raffle</h2><p>Buyers can join as soon as it’s listed. Fees are fixed from here: buyers pay {formatBps(policy.policy.buyerFeeBps)} or {formatUsdcAmount(policy.policy.minBuyerFeeUsdc)} USDC per purchase, whichever is more; you pay {formatBps(policy.policy.sellerFeeBps)} of sales when the raffle completes.</p></div><TransactionFlow service={browser.service} wallet={browser.wallet} submitOnClick action={{ kind: "open", id: snapshot.id, expectedPolicyHash: policy.hash }} label="List" formatUsdc={formatUsdcAmount} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /><details className="workflow-details"><summary>Listing details</summary><dl className="review-list"><div><dt>Treasury</dt><dd className="hash">{policy.policy.treasury}</dd></div><div><dt>Coordinator</dt><dd className="hash">{policy.policy.coordinator}</dd></div><div><dt>Terms</dt><dd className="hash">{policy.policy.termsHash}</dd></div><div><dt>Payment</dt><dd>{policy.policy.nativePayment ? "Native VRF billing" : "LINK VRF billing"}</dd></div><div><dt>State block</dt><dd>{policy.block.number.toString()}</dd></div></dl><button className="text-link" type="button" onClick={() => setRetry(value => value + 1)}>Refresh policy review</button></details></section>;
}
