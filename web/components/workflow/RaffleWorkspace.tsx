"use client";

import { useActionTrust } from "./useActionTrust";
import { MembershipPackCard } from "@/components/ui/squishy-card-component";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatEther, type Hex } from "viem";
import type { BrowserService, RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import { sellerAccounting } from "@/lib/chain/fees";
import type { ActionAvailability, AccountRaffleState, MembershipQuote, RaffleSnapshot, WorkflowAction } from "@/lib/chain/types";
import { cancelGuidance, drawBlocker, RECLAIM_GUIDANCE, sellerNextStep, sellerOwnsRaffle, sellerPortalActions, sellerSecondaryActions, type SellerActionAvailability } from "@/lib/chain/seller-actions";
import type { ReserveRecord } from "@/lib/reserve";
import { CompleteCreate } from "./CompleteCreate";
import { SellerDraftForm, type SaveCommitment } from "./SellerDraftForm";
import { TransactionFlow } from "./TransactionFlow";
import { catalogAvailability, formatDate, formatUsdc, shortAddress } from "./format";
import { useWalletSnapshot, WalletGate } from "./WalletGate";
import { transactionMeaning } from "@/lib/chain/transaction-outcomes";
import { useTransactionOutcomes } from "./useTransactionOutcomes";
import { ResumeTransaction } from "./ResumeTransaction";
import { DrawProgress } from "./DrawProgress";
import { RaffleArtwork } from "./RaffleArtwork";
import { SellerActivity } from "./SellerActivity";
import styles from "./SellerPortal.module.css";
import checkout from "./BuyerCheckout.module.css";

export type AvailabilityReader = (snapshot: RaffleSnapshot, account: AccountRaffleState | null, trustReason?: string | null) => readonly ActionAvailability[];
export type RecoverCommitment = (commit: Hex) => Promise<ReserveRecord>;
export type RecordAgreement = (raffleId: bigint) => Promise<void>;
export type RaffleWorkspaceMode = "public" | "seller";

function formatBps(bps: number) {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  return `${whole}${fraction ? `.${fraction.toString().padStart(2, "0").replace(/0+$/, "")}` : ""}%`;
}

function formatFeeUsdc(value: bigint) {
  const formatted = formatUsdc(value);
  if (!formatted.includes(".")) return `${formatted}.00`;
  const decimals = formatted.length - formatted.indexOf(".") - 1;
  return decimals === 1 ? `${formatted}0` : formatted;
}

function explorerAddress(chainId: number, value: string) {
  return chainId === 11155111 ? `https://sepolia.etherscan.io/address/${value}` : null;
}

function explorerToken(chainId: number, value: string, tokenId: bigint) {
  return chainId === 11155111 ? `https://sepolia.etherscan.io/token/${value}?a=${tokenId.toString()}` : null;
}

function admissionCopy(snapshot: RaffleSnapshot) {
  switch (snapshot.admission.status) {
    case "pending": return "Pending owner review";
    case "changed": return "Changed since owner review";
    case "approved": return "Approved for this exact draft";
    case "opened": return "Approved at opening";
    case "not-opened": return "No approval recorded at opening";
    default: {
      const exhaustive: never = snapshot.admission;
      return exhaustive;
    }
  }
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

  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
    // A new runtime or route ID invalidates the previous authoritative read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser.kind, browser.wallet, browser.kind === "configured" ? browser.service : browser.reason, id]);

  const scopedState = state.kind !== "loading" && sameWorkspace(state.scope, currentScope.current) ? state : { kind: "loading" } satisfies WorkspaceState;
  if (scopedState.kind === "loading") return <section className="section state-section"><div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading raffle</strong><p>Reading the verified contract state.</p></div></div></section>;
  if (scopedState.kind !== "ready") {
    return (
      <section className="section stack missing-state">
        <h1 className="page-title">{scopedState.kind === "missing" ? "This raffle was not found." : scopedState.kind === "legacy" ? "Legacy raffle detected." : "Raffle unavailable."}</h1>
        <p className="notice warning" role={scopedState.kind === "error" ? "alert" : "status"}>{scopedState.message}</p>
        <p>No purchase or claim is available without a verified current deployment.</p>
        <div className="btn-row"><Link className="btn" href="/">Back to explore</Link><button className="btn btn-dark" type="button" onClick={() => void refresh()}>Retry</button></div>
      </section>
    );
  }

  if (browser.kind !== "configured") return null;
  return <LoadedRaffle browser={browser} snapshot={scopedState.snapshot} termsHash={termsHash} availableActions={availableActions} saveCommitment={saveCommitment} recoverCommitment={recoverCommitment} recordAgreement={recordAgreement} refresh={refresh} refreshState={scopedState.refresh} mode={mode} />;
}

function LoadedRaffle({ browser, snapshot, termsHash, availableActions, saveCommitment, recoverCommitment, recordAgreement, refresh, refreshState, mode }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  termsHash: Hex;
  availableActions: AvailabilityReader;
  saveCommitment?: SaveCommitment;
  recoverCommitment?: RecoverCommitment;
  recordAgreement?: RecordAgreement;
  refresh: () => Promise<void>;
  refreshState: Extract<WorkspaceState, { kind: "ready" }>["refresh"];
  mode: RaffleWorkspaceMode;
}) {
  const walletSnapshot = useWalletSnapshot(browser.wallet);
  const [account, setAccount] = useState<AccountRaffleState | null>(null);
  const [accountState, setAccountState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [accountError, setAccountError] = useState("");
  const accountRequest = useRef(0);

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
  const phase = Number(snapshot.raffle.phase);
  const seller = walletSnapshot.kind === "connected" && sellerOwnsRaffle(walletSnapshot.account, snapshot);
  const reload = async () => { await refresh(); };
  const writesEnabled = refreshState.kind === "idle";
  const writeDisabledReason = refreshState.kind === "loading"
    ? "Wait for the current contract state to finish refreshing."
    : refreshState.kind === "error" ? "Refresh the current contract state before submitting another action." : undefined;

  if (mode === "seller" && walletSnapshot.kind === "connected" && walletSnapshot.chainId !== browser.service.manifest.chainId) {
    return <section className="section stack missing-state"><p className="kicker">Seller studio</p><h1 className="page-title">Switch to the verified network.</h1><p className="lede">This management workspace requires chain {browser.service.manifest.chainId}. Seller details and controls remain hidden while your wallet is on chain {walletSnapshot.chainId}.</p><Link className="btn btn-dark" href="/seller">Back to seller studio</Link></section>;
  }
  if (mode === "seller" && walletSnapshot.kind !== "connected") {
    return <section className="section stack missing-state"><h1 className="page-title">Connect the seller wallet.</h1><p className="lede">Seller controls appear only for the raffle owner on the verified network.</p><WalletGate wallet={browser.wallet}><span /></WalletGate></section>;
  }
  if (mode === "seller" && !seller) {
    return <section className="section stack missing-state"><p className="kicker">Seller studio</p><h1 className="page-title">This raffle belongs to another wallet.</h1><p className="lede">Switch to the raffle’s seller wallet to view its management workspace. Operator, buyer and winner roles do not grant seller access.</p><Link className="btn btn-dark" href="/seller">Back to your raffles</Link></section>;
  }

  const drawDetails = <><DrawProgress service={browser.service} snapshot={snapshot} />{mode === "seller" ? <SellerActivity service={browser.service} id={snapshot.id} /> : null}</>;

  return (
    <>
      <div className="detail-path"><Link href={mode === "seller" ? "/seller" : "/"} className="detail-back"><span aria-hidden="true">←</span> {mode === "seller" ? "Back to studio" : "Back to explore"}</Link><button className="text-link" type="button" disabled={refreshState.kind === "loading"} onClick={() => void refresh()}>{refreshState.kind === "loading" ? "Refreshing state…" : "Refresh state"}</button></div>
      {refreshState.kind === "loading" ? <p className="notice" role="status">Refreshing verified contract state. Transaction controls are paused.</p> : null}
      {refreshState.kind === "error" ? <p className="notice error" role="alert">Refresh failed: {refreshState.message} Transaction controls remain paused. <button className="text-link" type="button" onClick={() => void refresh()}>Retry refresh</button></p> : null}
      {trustReason ? <p className="notice warning" role="status">{trustReason} Existing recovery and receipt controls remain available.</p> : null}
      <ResumeTransaction browser={browser} pendingOnly scope={`raffle-${snapshot.id}`} confirmedThroughBlock={snapshot.block.number} onConfirmed={refresh} />
      <section className="section piece-layout piece-console chain-piece">
        <div className="piece-visual chain-piece-visual">
          <div className="piece-visual-topline"><span>Verified on-chain raffle</span><span>#{snapshot.id.toString()}</span></div>
          <RaffleArtwork service={browser.service} snapshot={snapshot} showDescription />
          <div className="piece-visual-caption"><span className="piece-escrow-status">{snapshot.raffle.escrowed ? "Escrow verified" : "Not escrowed"}</span></div>
        </div>
        <div className="purchase-console">
          <header className="purchase-header">
            <div className="purchase-eyebrow"><p className="kicker">Seller {shortAddress(snapshot.raffle.seller)}</p><span className="piece-status">{catalogAvailability(snapshot).label}</span></div>
            <h1 className="page-title">{snapshot.raffle.title}</h1>
            <p className="piece-deadline">Sales deadline {formatDate(snapshot.raffle.salesEnd)} UTC · {snapshot.lotCount.toString()} recorded lots</p>
            {mode === "public" ? <p className="notice" role="status"><strong>LABx review:</strong> {admissionCopy(snapshot)}. This records review of the exact prize and draw-funding use; it is not proof of authenticity or future transferability.</p> : null}
            <Link className="guide-link" href="/fairness">Draw protections <span aria-hidden="true">↗</span></Link>
          </header>
          {accountState === "loading" ? <p className="notice" role="status">Loading your account state…</p> : null}
          {accountState === "error" ? <p className="notice error" role="alert">{accountError}</p> : null}
          {mode === "seller"
            ? <SellerActions browser={browser} snapshot={snapshot} account={currentAccount} availability={availability} recoverCommitment={recoverCommitment} onConfirmed={reload} writesEnabled={writesEnabled} writeDisabledReason={writeDisabledReason} />
            : <BuyerActions browser={browser} snapshot={snapshot} account={currentAccount} availability={availability} termsHash={termsHash} recordAgreement={recordAgreement} onConfirmed={reload} writesEnabled={writesEnabled} writeDisabledReason={writeDisabledReason} />}
          {mode === "seller" ? <details className="workflow-details"><summary>Revenue and obligations</summary><SellerFinancialSummary snapshot={snapshot} /></details> : null}
          {mode === "public" ? <RecoveryAlternatives browser={browser} snapshot={snapshot} availability={availability} onConfirmed={reload} writesEnabled={writesEnabled} writeDisabledReason={writeDisabledReason} /> : null}
          {mode === "seller" && seller && phase === 0 && saveCommitment && writesEnabled ? <details className="workflow-details"><summary>Edit draft</summary><SellerDraftForm service={browser.service} wallet={browser.wallet} saveCommitment={saveCommitment} existing={snapshot} onConfirmed={reload} /></details> : null}
          <details className="workflow-details"><summary>Contract and review details</summary><dl className="review-list"><div><dt>Chain</dt><dd>{browser.service.manifest.chainId === 11155111 ? "Ethereum Sepolia" : "Isolated local chain"} ({browser.service.manifest.chainId})</dd></div><div><dt>Raffle contract</dt><dd className="hash">{explorerAddress(browser.service.manifest.chainId, browser.service.manifest.address) ? <a href={explorerAddress(browser.service.manifest.chainId, browser.service.manifest.address) ?? undefined} target="_blank" rel="noreferrer">{browser.service.manifest.address} ↗</a> : browser.service.manifest.address}</dd></div><div><dt>Collection contract</dt><dd className="hash">{explorerAddress(browser.service.manifest.chainId, snapshot.raffle.nft) ? <a href={explorerAddress(browser.service.manifest.chainId, snapshot.raffle.nft) ?? undefined} target="_blank" rel="noreferrer">{snapshot.raffle.nft} ↗</a> : snapshot.raffle.nft}</dd></div><div><dt>Token</dt><dd>{explorerToken(browser.service.manifest.chainId, snapshot.raffle.nft, snapshot.raffle.tokenId) ? <a href={explorerToken(browser.service.manifest.chainId, snapshot.raffle.nft, snapshot.raffle.tokenId) ?? undefined} target="_blank" rel="noreferrer">#{snapshot.raffle.tokenId.toString()} on explorer ↗</a> : `#${snapshot.raffle.tokenId.toString()}`}</dd></div><div><dt>LABx review</dt><dd>{admissionCopy(snapshot)}</dd></div><div><dt>Processing fee</dt><dd>Greater of {formatUsdc(snapshot.policy.minBuyerFeeUsdc)} USDC or {formatBps(snapshot.policy.buyerFeeBps)} per purchase call; nonrefundable after success</dd></div><div><dt>Seller commission</dt><dd>{formatBps(snapshot.policy.sellerFeeBps)} at settlement only</dd></div><div><dt>Treasury</dt><dd className="hash">{snapshot.policy.treasury}</dd></div><div><dt>State block</dt><dd>{snapshot.block.number.toString()}</dd></div></dl></details>
        </div>
      </section>
      {mode === "seller" && phase === 0 ? <details className="workflow-details"><summary>Draw details and activity</summary>{drawDetails}</details> : drawDetails}
    </>
  );
}

function SellerFinancialSummary({ snapshot }: { snapshot: RaffleSnapshot }) {
  const accounting = sellerAccounting(snapshot);
  return (
    <section className={styles.detailRevenue} aria-labelledby="raffle-revenue-title">
      <div><p className="kicker">Raffle accounting</p><h2 id="raffle-revenue-title">Revenue and obligations</h2></div>
      <dl>
        <div><dt>Gross pack sales</dt><dd>{formatUsdc(accounting.grossPrincipal)} USDC</dd></div>
        <div><dt>Earned net revenue</dt><dd>{formatUsdc(accounting.netProceeds)} USDC</dd></div>
        <div><dt>Already claimed</dt><dd>{formatUsdc(accounting.paidProceeds)} USDC</dd></div>
        <div><dt>Ready to claim</dt><dd>{formatUsdc(accounting.claimableProceeds)} USDC</dd></div>
        <div><dt>Pending principal</dt><dd>{formatUsdc(accounting.pendingPrincipal)} USDC</dd></div>
        <div><dt>Refund liability</dt><dd>{formatUsdc(accounting.refundLiability)} USDC</dd></div>
        <div><dt>Processing fees paid</dt><dd>{formatUsdc(accounting.buyerFees)} USDC</dd></div>
        <div><dt>Protocol fee escrow</dt><dd>{formatUsdc(snapshot.raffle.feeEscrow)} USDC</dd></div>
      </dl>
      <p>Gross sales include cancelled sales. Pending principal is not earned revenue. Successful purchase processing fees are retained for the pinned treasury and excluded from seller revenue. Cancellation adds no seller commission.</p>
    </section>
  );
}

const RECOVERY_KINDS = ["claimPrize", "refund", "reclaimPrize", "abortDrawing", "settle", "cancel", "close", "snapshot", "requestRandomness", "claimFee"] as const;
type RecoveryAvailability = ActionAvailability & { kind: typeof RECOVERY_KINDS[number] };

/** Enabled public recovery actions in priority order. Sales-phase cancellation only appears once no draw can happen; draw steps disappear then. */
function publicRecoveryActions(snapshot: RaffleSnapshot, availability: readonly ActionAvailability[]): readonly RecoveryAvailability[] {
  const blocked = drawBlocker(snapshot) !== null;
  const salesPhase = snapshot.raffle.phase === 1 || snapshot.raffle.phase === 2;
  return RECOVERY_KINDS.flatMap(kind => {
    const item = availability.find(candidate => candidate.kind === kind && candidate.enabled);
    if (!item || blocked && (kind === "close" || kind === "snapshot" || kind === "requestRandomness") || kind === "cancel" && salesPhase && !blocked) return [];
    return [{ ...item, kind }];
  });
}

function recoveryGuidance(snapshot: RaffleSnapshot, kind: RecoveryAvailability["kind"]) {
  const blocker = drawBlocker(snapshot);
  if (kind === "cancel" && blocker) return cancelGuidance(snapshot, blocker);
  if (kind === "reclaimPrize") return RECLAIM_GUIDANCE;
  if (kind === "claimFee") return "Anyone can send protocol fees to the pinned treasury; they are never paid to the caller.";
  return "The contract currently permits this action.";
}

function BuyerActions({ browser, snapshot, account, availability, termsHash, recordAgreement, onConfirmed, writesEnabled, writeDisabledReason }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  account: AccountRaffleState | null;
  availability: readonly ActionAvailability[];
  termsHash: Hex;
  recordAgreement?: RecordAgreement;
  onConfirmed: () => Promise<void>;
  writesEnabled: boolean;
  writeDisabledReason?: string;
}) {
  const [packId, setPackId] = useState(() => Math.max(0, snapshot.packs.findIndex((pack) => pack.active && pack.sold < pack.maxSupply)));
  const [quantity, setQuantity] = useState(1);
  const [payment, setPayment] = useState<"usdc" | "eth">("usdc");
  const [agreements, setAgreements] = useState({ terms: false, rules: false, age: false });
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
  const selected = snapshot.packs[packId];
  const salesOpen = Number(snapshot.raffle.phase) === 1 && snapshot.block.timestamp < snapshot.raffle.salesEnd && !snapshot.paused;
  const quantityValid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 20;
  const { owner, outcomes } = useTransactionOutcomes(browser.service, browser.wallet);
  const purchaseOutcome = [...outcomes].reverse().find(outcome => outcome.kind === "terminal" && outcome.confirmation.receipt.status === "success"
    && transactionMeaning(browser.service, outcome.submitted)?.purchase && transactionMeaning(browser.service, outcome.submitted)?.raffleId === snapshot.id);
  const purchaseConfirmation = purchaseOutcome?.kind === "terminal" && purchaseOutcome.confirmation.receipt.status === "success" ? purchaseOutcome.confirmation.receipt : null;
  const canBuyAgain = purchaseConfirmation !== null && writesEnabled && account !== null && quote !== null
    && snapshot.block.number >= purchaseConfirmation.blockNumber && account.snapshot.block.number >= purchaseConfirmation.blockNumber
    && quote.block.number >= purchaseConfirmation.blockNumber && salesOpen;
  const purchasesEnded = Number(snapshot.raffle.phase) >= 2 || snapshot.block.timestamp >= snapshot.raffle.salesEnd
    || snapshot.packs.length > 0 && snapshot.packs.every(pack => pack.sold >= pack.maxSupply);
  const canArchivePurchase = purchaseConfirmation !== null && purchasesEnded && writesEnabled && account !== null
    && snapshot.block.number >= purchaseConfirmation.blockNumber && account.snapshot.block.number >= purchaseConfirmation.blockNumber;
  const [selectionNotice, setSelectionNotice] = useState("");
  const [receiptError, setReceiptError] = useState("");

  useEffect(() => {
    if (selected?.active && selected.sold < selected.maxSupply) return;
    const fallback = snapshot.packs.findIndex((pack) => pack.active && pack.sold < pack.maxSupply);
    if (fallback >= 0 && fallback !== packId) {
      setSelectionNotice(`The selected pack is no longer available. ${snapshot.packs[fallback].name} is now selected. Review its price and give consent again.`);
      setPackId(fallback);
    }
  }, [packId, selected, snapshot.packs]);

  useEffect(() => {
    const version = ++quoteRequest.current;
    setQuote(null);
    agreementGeneration.current += 1;
    setAgreements({ terms: false, rules: false, age: false });
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

  const byKind = (kind: WorkflowAction["kind"]) => availability.find((item) => item.kind === kind);
  const termsMatch = snapshot.policy.termsHash.toLowerCase() === termsHash.toLowerCase();
  const allAgreed = agreements.terms && agreements.rules && agreements.age;
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
  const nextRecovery = publicRecoveryActions(snapshot, availability)[0];
  const recoveryAction: WorkflowAction | null = nextRecovery
    ? nextRecovery.kind === "snapshot"
      ? { kind: "snapshot", id: snapshot.id, maxSteps: 100n }
      : { kind: nextRecovery.kind, id: snapshot.id }
    : null;

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
      setAgreements({ terms: false, rules: false, age: false });
      setAgreementState("idle");
      agreementGeneration.current += 1;
      setReceiptError("");
    } catch (error) { if (browser.wallet.getSnapshot().revision === expected.revision && agreementGeneration.current === version) setReceiptError(error instanceof Error ? error.message : "The receipt could not be acknowledged."); }
  }

  return (
    <div className="stack buyer-flow">
      {purchaseConfirmation ? <div className="transaction-state notice ok stack" role="status"><strong>Purchase confirmed</strong><span>Confirmed in block {purchaseConfirmation.blockNumber.toString()}.</span><p className="hash">{purchaseConfirmation.hash}</p>{purchasesEnded ? <button className="btn" type="button" disabled={!canArchivePurchase} onClick={buyAgain}>Acknowledge purchase receipt</button> : salesOpen ? <><button className="btn" type="button" disabled={!canBuyAgain} onClick={buyAgain}>Buy again</button>{!canBuyAgain ? <p>Refresh the raffle, balance and quote before starting another purchase.</p> : null}</> : null}{receiptError ? <p role="alert">{receiptError}</p> : null}</div> : null}
      {salesOpen && !purchaseConfirmation ? (
        <>
          {selectionNotice ? <p className="notice warning" role="status">{selectionNotice}</p> : null}
          <section className="pack-selector" aria-labelledby="pack-title">
            <div className="console-section-heading"><h2 id="pack-title">Choose membership</h2><span>Bonus entries included</span></div>
            <div className="chain-pack-grid" role="radiogroup" aria-label="Membership packs">
              {snapshot.packs.map((pack, index) => {
                const remaining = Math.max(0, Number(pack.maxSupply) - Number(pack.sold));
                return <MembershipPackCard key={`${index}-${pack.name}`} name={pack.name} price={formatUsdc(pack.priceUsdc)} bonusEntries={pack.bonusEntries} remaining={remaining} feeLabel={` Processing fee: greater of ${formatFeeUsdc(snapshot.policy.minBuyerFeeUsdc)} USDC or ${formatBps(snapshot.policy.buyerFeeBps)} per purchase call`} value={String(index)} selected={index === packId} disabled={!pack.active || remaining === 0} onSelect={() => setPackId(index)} />;
              })}
            </div>
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
              <div><dt>Memberships</dt><dd>{formatUsdc(quote.principal)} USDC</dd></div>
              <div><dt>Processing fee <span>Nonrefundable</span></dt><dd>{formatUsdc(quote.fee)} USDC</dd></div>
              <div className={checkout.total}><dt>Total</dt><dd>{formatUsdc(quote.totalUsdc)} <small>USDC</small></dd></div>
            </dl> : <p>{quoteState === "loading" ? "Refreshing quote…" : "Choose an available membership."}</p>}
            {quote ? <p className={checkout.entries}>{quote.bonusEntries.toString()} bonus entries included</p> : null}
          </div>
          {!quantityValid ? <p id="membership-qty-error" className="notice error" role="alert">Quantity must be a whole number from 1 to 20.</p> : null}
          {quoteState === "error" ? <p className="notice error" role="alert">{quoteError}</p> : null}
          {payment === "eth" && quote?.eth.kind === "unavailable" ? <div className="notice warning stack" role="status"><p>ETH payment is no longer available for this quote. Choose USDC and review the total again.</p><button className="btn" type="button" onClick={() => { setPayment("usdc"); setAgreements({ terms: false, rules: false, age: false }); setAgreementState("idle"); agreementGeneration.current += 1; }}>Use USDC</button></div> : null}
          {quote?.eth.kind === "available" ? <><fieldset className="payment-choice"><legend>Payment</legend><label><input type="radio" name="payment" checked={payment === "usdc"} onChange={() => setPayment("usdc")} /> USDC</label><label><input type="radio" name="payment" checked={payment === "eth"} onChange={() => setPayment("eth")} /> ETH quote</label></fieldset>{payment === "eth" ? <dl className="review-list"><div><dt>Current quote</dt><dd>{formatEther(quote.eth.requiredEth)} ETH</dd></div><div><dt>Maximum sent</dt><dd>{formatEther(quote.eth.maxEth)} ETH</dd></div><div><dt>Slippage cap</dt><dd>{quote.eth.slippageBps / 100}%</dd></div><div><dt>Expires</dt><dd>{formatDate(quote.eth.deadline)} UTC</dd></div></dl> : null}</> : <div className={checkout.payment}><span>{payment === "eth" ? "ETH quote unavailable" : "Pay with USDC"}</span>{quote?.eth.kind === "unavailable" ? <details><summary>About payment</summary><p>ETH payment unavailable: {quote.eth.reason}</p></details> : null}</div>}
          {!termsMatch ? <p className="notice error" role="alert">The raffle’s published terms do not match this website version. Purchasing is blocked.</p> : (
            <fieldset className={`agreements ${checkout.agreements}`}>
              <legend>Before you continue</legend>
              <label><input type="checkbox" checked={agreements.terms} onChange={(event) => setAgreements((value) => ({ ...value, terms: event.target.checked }))} /><span>I agree to the <Link href="/legal">membership terms</Link>.</span></label>
              <label><input type="checkbox" checked={agreements.rules} onChange={(event) => setAgreements((value) => ({ ...value, rules: event.target.checked }))} /><span>I agree to the <Link href="/rules">draw rules</Link>.</span></label>
              <label><input type="checkbox" checked={agreements.age} onChange={(event) => setAgreements((value) => ({ ...value, age: event.target.checked }))} /><span>I confirm I am at least 18.</span></label>
            </fieldset>
          )}
          <div className={checkout.action}>
          <WalletGate wallet={browser.wallet}>
            {!account ? <p className="notice" role="status">Loading balance and allowance…</p> : insufficientUsdc ? <p className="notice warning" role="status">This wallet does not have enough USDC for the reviewed total.</p> : needsApproval && payment === "usdc" ? (
              approval?.enabled && quote ? <TransactionFlow key={`approve-${packId}-${quantity}-${quote.totalUsdc}`} service={browser.service} wallet={browser.wallet} action={{ kind: "approveUsdc", id: snapshot.id, packId, quantity }} label="Approve exact USDC" formatUsdc={formatUsdc} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /> : <p className="notice warning" role="status">{approval?.reason || "USDC approval is not available."}</p>
            ) : !allAgreed ? <p className="notice warning" role="status">Review and accept all three confirmations to continue.</p>
              : agreementState !== "saved" ? <div className="stack"><button className="btn" type="button" disabled={!recordAgreement || agreementState === "saving" || !writesEnabled} title={!writesEnabled ? writeDisabledReason : undefined} onClick={() => void recordReviewedAgreement()}>{agreementState === "saving" ? "Recording agreement…" : "Sign and record agreement"}</button>{!recordAgreement ? <p className="notice warning" role="status">Agreement storage is not configured. Purchasing is unavailable.</p> : null}{agreementState === "error" ? <p className="notice error" role="alert">{agreementError}</p> : null}</div>
                : purchaseAction && purchase?.enabled ? <TransactionFlow key={`buy-${packId}-${quantity}-${payment}`} service={browser.service} wallet={browser.wallet} action={purchaseAction} label="Purchase membership" formatUsdc={formatUsdc} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /> : <p className="notice warning" role="status">{purchase?.reason || "Purchase is not available."}</p>}
          </WalletGate>
          </div>
          </section>
        </>
      ) : !salesOpen ? <p className="notice" role="status">{Number(snapshot.raffle.phase) === 1 && snapshot.block.timestamp >= snapshot.raffle.salesEnd ? "Membership sales ended at the published deadline." : `Membership sales are not open${snapshot.paused && Number(snapshot.raffle.phase) === 1 ? " because admissions are paused" : ""}.`}</p> : null}
      {!salesOpen && buyerWallet.kind === "disconnected" ? <WalletGate wallet={browser.wallet}><span /></WalletGate> : null}
      {account && (account.principal > 0n || account.fee > 0n) ? <div className="account-balance"><span>Your refundable principal</span><strong>{formatUsdc(account.principal)} USDC</strong><small>{formatUsdc(account.fee)} USDC processing fee paid to date remains historical and nonrefundable. Cancellation refunds principal only.</small></div> : null}
      {nextRecovery && recoveryAction ? <section className="workflow-next stack"><div><p className="kicker">Available now</p><h2>{nextRecovery.label}</h2><p>{nextRecovery.reason || recoveryGuidance(snapshot, nextRecovery.kind)}</p></div><TransactionFlow service={browser.service} wallet={browser.wallet} action={recoveryAction} label={nextRecovery.label} formatUsdc={formatUsdc} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /></section> : null}
    </div>
  );
}

function SellerActions({ browser, snapshot, account, availability, recoverCommitment, onConfirmed, writesEnabled, writeDisabledReason }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  account: AccountRaffleState | null;
  availability: readonly ActionAvailability[];
  recoverCommitment?: RecoverCommitment;
  onConfirmed: () => Promise<void>;
  writesEnabled: boolean;
  writeDisabledReason?: string;
}) {
  if (!account) return <WalletGate wallet={browser.wallet}><p className="notice" role="status">Loading seller controls…</p></WalletGate>;
  const sellerAvailability = sellerPortalActions(availability);
  const next = sellerNextStep(snapshot, sellerAvailability);
  const primary = next.kind === "action" ? next.action : null;
  const secondary = sellerSecondaryActions(snapshot, sellerAvailability, next);
  return (
    <div className="stack">
      {primary ? <SellerActionControl key={primary.kind} primary description={next.kind === "action" ? next.message : undefined} browser={browser} snapshot={snapshot} availability={primary} recoverCommitment={recoverCommitment} onConfirmed={onConfirmed} writesEnabled={writesEnabled} writeDisabledReason={writeDisabledReason} /> : next.kind === "waiting" ? <section className="workflow-next stack" role="status"><h2>{next.title}</h2><p>{next.message}</p></section> : null}
      {secondary.length ? <details className="workflow-details"><summary>Advanced ({secondary.length})</summary><div className="stack">{secondary.map((item) => <SellerActionControl key={item.kind} browser={browser} snapshot={snapshot} availability={item} recoverCommitment={recoverCommitment} onConfirmed={onConfirmed} writesEnabled={writesEnabled} writeDisabledReason={writeDisabledReason} />)}</div></details> : null}
    </div>
  );
}

function SellerActionControl({ browser, snapshot, availability, recoverCommitment, onConfirmed, writesEnabled, writeDisabledReason, primary = false, description }: {
  primary?: boolean;
  description?: string;
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  availability: SellerActionAvailability;
  recoverCommitment?: RecoverCommitment;
  onConfirmed: () => Promise<void>;
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
      if (value.commit.toLowerCase() !== snapshot.raffle.reserveCommit.toLowerCase()) throw new Error("Recovered commitment does not match this raffle.");
      setRecovered(value);
      setPreflight("idle");
    } catch (error) {
      setPreflightError(error instanceof Error ? error.message : "Commitment could not be recovered.");
      setPreflight("error");
    } finally { preflightInFlight.current = false; }
  }

  if (primary && (availability.kind === "approvePrize" || availability.kind === "escrow")) return <CompleteCreate service={browser.service} wallet={browser.wallet} snapshot={snapshot} disabled={!writesEnabled} onConfirmed={onConfirmed} />;
  if (availability.kind === "open") return <OpeningPolicyControl browser={browser} snapshot={snapshot} onConfirmed={onConfirmed} writesEnabled={writesEnabled && primary} writeDisabledReason={writeDisabledReason} />;
  if (availability.kind === "reveal") {
    if (!recoverCommitment) return <p className="notice warning" role="status">Commitment recovery is not configured. Reveal is unavailable.</p>;
    if (!recovered) return <section className="workflow-next stack"><div><p className="kicker">Seller action</p><h2>Recover commitment</h2><p>A wallet signature retrieves the private hashes for this raffle. Nothing is revealed until you separately review the transaction.</p></div><button className="btn" type="button" disabled={preflight === "loading" || !writesEnabled} title={!writesEnabled ? writeDisabledReason : undefined} onClick={() => void recoverSavedCommitment()}>{preflight === "loading" ? "Opening wallet…" : "Sign to recover commitment"}</button>{preflight === "error" ? <p className="notice error" role="alert">{preflightError}</p> : null}</section>;
    return <section className="workflow-next stack"><div><p className="kicker">Commitment recovered</p><h2>Reveal commitment</h2><p>The review below submits the saved public and private hashes and salt. The original private value stays off-chain.</p></div><TransactionFlow service={browser.service} wallet={browser.wallet} action={{ kind: "reveal", id: snapshot.id, publicHash: recovered.publicHash, privateHash: recovered.privateHash, salt: recovered.salt }} label="Reveal commitment" formatUsdc={formatUsdc} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /></section>;
  }
  if (availability.kind === "updateDraft") return null;
  const action: WorkflowAction = availability.kind === "snapshot"
    ? { kind: "snapshot", id: snapshot.id, maxSteps: 100n }
    : { kind: availability.kind, id: snapshot.id };
  return <section className="workflow-next stack"><div><p className="kicker">Seller action</p><h2>{availability.label}</h2><p>{availability.reason || description || "Review the prepared transaction before opening your wallet."}</p></div><TransactionFlow service={browser.service} wallet={browser.wallet} action={action} prepareOnMount={primary && (action.kind === "approvePrize" || action.kind === "escrow")} label={availability.label} formatUsdc={formatUsdc} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /></section>;
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
      if (isCurrent()) setState({ scope: expected.generation, kind: "error", message: error instanceof Error ? error.message : "Opening policy could not be loaded." });
    });
    return () => { active = false; };
    // Scope includes the deployment service, raffle snapshot, session and explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  if (state.scope !== scope || state.kind !== "ready") return <section className="workflow-next stack"><h2>List your raffle</h2>{state.scope === scope && state.kind === "error" ? <><p className="notice error" role="alert">{state.message}</p><button className="btn" type="button" onClick={() => setRetry(value => value + 1)}>Retry opening policy</button></> : <p role="status">{writesEnabled ? "Loading opening policy…" : writeDisabledReason || "Waiting for verified seller state…"}</p>}</section>;
  const { policy } = state;
  return <section className="workflow-next stack"><div><h2>List your raffle</h2><p>Make memberships available to buyers. These fees are fixed once you list.</p></div><dl className="review-list"><div><dt>LABx approval</dt><dd>{admissionCopy(snapshot)}</dd></div><div><dt>Processing fee</dt><dd>Greater of {formatUsdc(policy.policy.minBuyerFeeUsdc)} USDC or {formatBps(policy.policy.buyerFeeBps)} per purchase call; retained after a successful purchase</dd></div><div><dt>Seller commission</dt><dd>{formatBps(policy.policy.sellerFeeBps)} at settlement only</dd></div></dl><TransactionFlow service={browser.service} wallet={browser.wallet} submitOnClick action={{ kind: "open", id: snapshot.id, expectedPolicyHash: policy.hash }} label="List" formatUsdc={formatUsdc} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} /><details className="workflow-details"><summary>Listing details</summary><dl className="review-list"><div><dt>Treasury</dt><dd className="hash">{policy.policy.treasury}</dd></div><div><dt>Coordinator</dt><dd className="hash">{policy.policy.coordinator}</dd></div><div><dt>Terms</dt><dd className="hash">{policy.policy.termsHash}</dd></div><div><dt>Payment</dt><dd>{policy.policy.nativePayment ? "Native VRF billing" : "LINK VRF billing"}</dd></div><div><dt>State block</dt><dd>{policy.block.number.toString()}</dd></div></dl><button className="text-link" type="button" onClick={() => setRetry(value => value + 1)}>Refresh policy review</button></details></section>;
}

function RecoveryAlternatives({ browser, snapshot, availability, onConfirmed, writesEnabled, writeDisabledReason }: {
  browser: Extract<BrowserService, { kind: "configured" }>; snapshot: RaffleSnapshot;
  availability: readonly ActionAvailability[]; onConfirmed: () => Promise<void>;
  writesEnabled: boolean; writeDisabledReason?: string;
}) {
  const kinds = ["settle", "cancel", "abortDrawing", "refund", "reclaimPrize"] as const;
  const [, ...others] = publicRecoveryActions(snapshot, availability);
  const actions = kinds.flatMap(kind => others.filter(item => item.kind === kind).map(item => ({ ...item, kind })));
  if (!actions.length) return null;
  return <section className="workflow-details stack" aria-label="Other available actions"><h3>Available recovery and settlement</h3><p>These actions do not require commitment recovery.</p>{actions.map(item => <TransactionFlow key={item.kind} service={browser.service} wallet={browser.wallet} action={{ kind: item.kind, id: snapshot.id }} label={item.label} formatUsdc={formatUsdc} onConfirmed={onConfirmed} disabled={!writesEnabled} disabledReason={writeDisabledReason} />)}</section>;
}
