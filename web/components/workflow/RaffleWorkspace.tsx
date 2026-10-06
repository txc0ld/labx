"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatEther, type Hex } from "viem";
import type { BrowserService } from "@/lib/chain/ports";
import type { ActionAvailability, AccountRaffleState, MembershipQuote, RaffleSnapshot, WorkflowAction } from "@/lib/chain/types";
import type { ReserveRecord } from "@/lib/reserve";
import { SellerDraftForm, type SaveCommitment } from "./SellerDraftForm";
import { TransactionFlow } from "./TransactionFlow";
import { formatDate, formatUsdc, phaseLabel, shortAddress } from "./format";
import { useWalletSnapshot, WalletGate } from "./WalletGate";
import { ResumeTransaction } from "./ResumeTransaction";
import { DrawProgress } from "./DrawProgress";
import { RaffleArtwork } from "./RaffleArtwork";

export type AvailabilityReader = (snapshot: RaffleSnapshot, account: AccountRaffleState | null) => readonly ActionAvailability[];
export type RecoverCommitment = (commit: Hex) => Promise<ReserveRecord>;
export type RecordAgreement = (raffleId: bigint) => Promise<void>;

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "unavailable" | "legacy" | "mismatch" | "missing" | "error"; message: string }
  | { kind: "ready"; snapshot: RaffleSnapshot };

export function RaffleWorkspace({ browser, id, termsHash, availableActions, saveCommitment, recoverCommitment, recordAgreement }: {
  browser: BrowserService;
  id: bigint;
  termsHash: Hex;
  availableActions: AvailabilityReader;
  saveCommitment?: SaveCommitment;
  recoverCommitment?: RecoverCommitment;
  recordAgreement?: RecordAgreement;
}) {
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const request = useRef(0);

  async function refresh() {
    if (browser.kind === "unavailable") {
      setState({ kind: "unavailable", message: browser.reason });
      return;
    }
    const version = ++request.current;
    setState({ kind: "loading" });
    try {
      const deployment = await browser.service.attest();
      if (version !== request.current) return;
      if (deployment.kind !== "verified") {
        setState({ kind: deployment.kind, message: deployment.reason });
        return;
      }
      const snapshot = await browser.service.readRaffle({ id });
      if (version === request.current) setState({ kind: "ready", snapshot });
    } catch (error) {
      if (version !== request.current) return;
      const message = error instanceof Error ? error.message : "The raffle could not be loaded.";
      setState({ kind: /not found|does not exist|unknown raffle/i.test(message) ? "missing" : "error", message });
    }
  }

  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
    // A new runtime or route ID invalidates the previous authoritative read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, id]);

  if (state.kind === "loading") return <section className="section state-section"><div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading raffle</strong><p>Reading the verified contract state.</p></div></div></section>;
  if (state.kind !== "ready") {
    return (
      <section className="section stack missing-state">
        <h1 className="page-title">{state.kind === "missing" ? "This raffle was not found." : state.kind === "legacy" ? "Legacy raffle detected." : "Raffle unavailable."}</h1>
        <p className="notice warning" role={state.kind === "error" ? "alert" : "status"}>{state.message}</p>
        <p>No purchase or claim is available without a verified current deployment.</p>
        <div className="btn-row"><Link className="btn" href="/">Back to explore</Link><button className="btn btn-dark" type="button" onClick={() => void refresh()}>Retry</button></div>
      </section>
    );
  }

  if (browser.kind !== "configured") return null;
  return <LoadedRaffle browser={browser} snapshot={state.snapshot} termsHash={termsHash} availableActions={availableActions} saveCommitment={saveCommitment} recoverCommitment={recoverCommitment} recordAgreement={recordAgreement} refresh={refresh} />;
}

function LoadedRaffle({ browser, snapshot, termsHash, availableActions, saveCommitment, recoverCommitment, recordAgreement, refresh }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  termsHash: Hex;
  availableActions: AvailabilityReader;
  saveCommitment?: SaveCommitment;
  recoverCommitment?: RecoverCommitment;
  recordAgreement?: RecordAgreement;
  refresh: () => Promise<void>;
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
    if (walletSnapshot.kind !== "connected") {
      setAccountState("idle");
      return;
    }
    setAccountState("loading");
    void browser.service.readAccount({ id: snapshot.id, account: walletSnapshot.account }).then((next) => {
      if (version === accountRequest.current) { setAccount(next); setAccountState("ready"); }
    }).catch((error: unknown) => {
      if (version === accountRequest.current) {
        setAccountError(error instanceof Error ? error.message : "Account state could not be loaded.");
        setAccountState("error");
      }
    });
    return () => { accountRequest.current += 1; };
  }, [browser.service, snapshot.id, walletSnapshot]);

  const availability = availableActions(snapshot, account);
  const phase = Number(snapshot.raffle.phase);
  const seller = walletSnapshot.kind === "connected" && walletSnapshot.account.toLowerCase() === snapshot.raffle.seller.toLowerCase();
  const reload = async () => { await refresh(); };

  return (
    <>
      <div className="detail-path"><Link href="/" className="detail-back"><span aria-hidden="true">←</span> Back to explore</Link><button className="text-link" type="button" onClick={() => void refresh()}>Refresh state</button></div>
      <ResumeTransaction browser={browser} pendingOnly onConfirmed={refresh} />
      <section className="section piece-layout piece-console chain-piece">
        <div className="piece-visual chain-piece-visual">
          <div className="piece-visual-topline"><span>Verified on-chain raffle</span><span>#{snapshot.id.toString()}</span></div>
          <RaffleArtwork service={browser.service} snapshot={snapshot} showDescription />
          <div className="piece-visual-caption"><span className="piece-escrow-status">{snapshot.raffle.escrowed ? "Escrow verified" : "Not escrowed"}</span></div>
        </div>
        <div className="purchase-console">
          <header className="purchase-header">
            <div className="purchase-eyebrow"><p className="kicker">Seller {shortAddress(snapshot.raffle.seller)}</p><span className="piece-status">{phaseLabel(phase)}</span></div>
            <h1 className="page-title">{snapshot.raffle.title}</h1>
            <p className="piece-deadline">Sales deadline {formatDate(snapshot.raffle.salesEnd)} UTC · {snapshot.lotCount.toString()} recorded lots</p>
            <Link className="guide-link" href="/fairness">Draw protections <span aria-hidden="true">↗</span></Link>
          </header>
          {accountState === "loading" ? <p className="notice" role="status">Loading your account state…</p> : null}
          {accountState === "error" ? <p className="notice error" role="alert">{accountError}</p> : null}
          {seller
            ? <SellerActions browser={browser} snapshot={snapshot} account={account} availability={availability} recoverCommitment={recoverCommitment} onConfirmed={reload} />
            : <BuyerActions browser={browser} snapshot={snapshot} account={account} availability={availability} termsHash={termsHash} recordAgreement={recordAgreement} onConfirmed={reload} />}
          <RecoveryAlternatives browser={browser} snapshot={snapshot} availability={availability} onConfirmed={reload} />
          {seller && phase === 0 && saveCommitment ? <details className="workflow-details"><summary>Edit draft</summary><SellerDraftForm service={browser.service} wallet={browser.wallet} saveCommitment={saveCommitment} existing={snapshot} onConfirmed={reload} /></details> : null}
          <details className="workflow-details"><summary>Contract details</summary><dl className="review-list"><div><dt>Raffle contract</dt><dd className="hash">{browser.service.manifest.address}</dd></div><div><dt>NFT contract</dt><dd className="hash">{snapshot.raffle.nft}</dd></div><div><dt>Token</dt><dd>{snapshot.raffle.tokenId.toString()}</dd></div><div><dt>Treasury</dt><dd className="hash">{snapshot.policy.treasury}</dd></div><div><dt>State block</dt><dd>{snapshot.block.number.toString()}</dd></div></dl></details>
        </div>
      </section>
      <DrawProgress service={browser.service} snapshot={snapshot} />
    </>
  );
}

function BuyerActions({ browser, snapshot, account, availability, termsHash, recordAgreement, onConfirmed }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  account: AccountRaffleState | null;
  availability: readonly ActionAvailability[];
  termsHash: Hex;
  recordAgreement?: RecordAgreement;
  onConfirmed: () => Promise<void>;
}) {
  const [packId, setPackId] = useState(() => Math.max(0, snapshot.packs.findIndex((pack) => pack.active && pack.sold < pack.maxSupply)));
  const [quantity, setQuantity] = useState(1);
  const [payment, setPayment] = useState<"usdc" | "eth">("usdc");
  const [agreements, setAgreements] = useState({ terms: false, rules: false, age: false });
  const [agreementState, setAgreementState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [agreementError, setAgreementError] = useState("");
  const agreementInFlight = useRef(false);
  const agreementGeneration = useRef(0);
  const [quote, setQuote] = useState<MembershipQuote | null>(null);
  const [quoteState, setQuoteState] = useState<"idle" | "loading" | "error">("idle");
  const [quoteError, setQuoteError] = useState("");
  const quoteRequest = useRef(0);
  const buyerWallet = useWalletSnapshot(browser.wallet);
  const selected = snapshot.packs[packId];
  const salesOpen = Number(snapshot.raffle.phase) === 1 && snapshot.block.timestamp < snapshot.raffle.salesEnd && !snapshot.paused;

  useEffect(() => {
    const version = ++quoteRequest.current;
    setQuote(null);
    agreementGeneration.current += 1;
    setAgreements({ terms: false, rules: false, age: false });
    setAgreementState("idle");
    setAgreementError("");
    if (!selected || !Number.isSafeInteger(quantity) || quantity < 1 || !selected.active || selected.sold >= selected.maxSupply || !salesOpen) {
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
    return () => { quoteRequest.current += 1; };
  }, [browser.service, buyerWallet.revision, packId, quantity, salesOpen, selected, snapshot.id]);

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
  const recoveryKinds: WorkflowAction["kind"][] = ["claimPrize", "refund", "abortDrawing", "settle", "cancel", "close", "snapshot", "claimFee"];
  const nextRecovery = recoveryKinds.map(kind => availability.find(item => item.kind === kind)).find(item => item?.enabled);
  const recoveryAction: WorkflowAction | null = nextRecovery
    ? nextRecovery.kind === "snapshot"
      ? { kind: "snapshot", id: snapshot.id, maxSteps: 100n }
      : { kind: nextRecovery.kind as "claimPrize" | "refund" | "close" | "cancel" | "abortDrawing" | "settle" | "claimFee", id: snapshot.id }
    : null;

  async function recordReviewedAgreement() {
    if (!recordAgreement || agreementInFlight.current) return;
    agreementInFlight.current = true;
    const generation = agreementGeneration.current;
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
      agreementInFlight.current = false;
    }
  }

  return (
    <div className="stack buyer-flow">
      {salesOpen ? (
        <>
          <section className="pack-selector" aria-labelledby="pack-title">
            <div className="console-section-heading"><h2 id="pack-title">Choose membership</h2><span>Bonus entries included</span></div>
            <div className="chain-pack-grid" role="radiogroup" aria-label="Membership packs">
              {snapshot.packs.map((pack, index) => {
                const remaining = Math.max(0, Number(pack.maxSupply) - Number(pack.sold));
                return <label className="chain-pack" data-selected={index === packId} data-disabled={!pack.active || remaining === 0} key={`${index}-${pack.name}`}><input type="radio" name="pack" value={index} checked={index === packId} disabled={!pack.active || remaining === 0} onChange={() => setPackId(index)} /><strong>{pack.name}</strong><span>{formatUsdc(pack.priceUsdc)} USDC</span><small>{pack.bonusEntries} bonus entries · {remaining} left</small></label>;
              })}
            </div>
          </section>
          <section className="order-panel" aria-labelledby="order-title">
            <div className="quantity-control"><label htmlFor="membership-qty"><span id="order-title">Quantity</span><input id="membership-qty" inputMode="numeric" type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label><span>Validated against live supply</span></div>
            <div className="order-total" aria-live="polite"><span>Total</span><strong>{quote ? formatUsdc(quote.totalUsdc) : "—"} <small>USDC</small></strong>{quote ? <p>{formatUsdc(quote.principal)} membership + {formatUsdc(quote.fee)} lab fee · {quote.bonusEntries.toString()} bonus entries</p> : <p>{quoteState === "loading" ? "Refreshing quote…" : "Choose an available membership."}</p>}</div>
          </section>
          {quoteState === "error" ? <p className="notice error" role="alert">{quoteError}</p> : null}
          {quote?.eth.kind === "available" ? <><fieldset className="payment-choice"><legend>Payment</legend><label><input type="radio" name="payment" checked={payment === "usdc"} onChange={() => setPayment("usdc")} /> USDC</label><label><input type="radio" name="payment" checked={payment === "eth"} onChange={() => setPayment("eth")} /> ETH quote</label></fieldset>{payment === "eth" ? <dl className="review-list"><div><dt>Current quote</dt><dd>{formatEther(quote.eth.requiredEth)} ETH</dd></div><div><dt>Maximum sent</dt><dd>{formatEther(quote.eth.maxEth)} ETH</dd></div><div><dt>Slippage cap</dt><dd>{quote.eth.slippageBps / 100}%</dd></div><div><dt>Expires</dt><dd>{formatDate(quote.eth.deadline)} UTC</dd></div></dl> : null}</> : <p className="muted">ETH payment unavailable{quote?.eth.kind === "unavailable" ? `: ${quote.eth.reason}` : "."}</p>}
          {!termsMatch ? <p className="notice error" role="alert">The raffle’s published terms do not match this website version. Purchasing is blocked.</p> : (
            <fieldset className="agreements stack"><legend>Confirm before purchase</legend><label><input type="checkbox" checked={agreements.terms} onChange={(event) => setAgreements((value) => ({ ...value, terms: event.target.checked }))} /> I agree to the <Link href="/legal">membership terms</Link>.</label><label><input type="checkbox" checked={agreements.rules} onChange={(event) => setAgreements((value) => ({ ...value, rules: event.target.checked }))} /> I agree to the <Link href="/rules">draw rules</Link>.</label><label><input type="checkbox" checked={agreements.age} onChange={(event) => setAgreements((value) => ({ ...value, age: event.target.checked }))} /> I confirm I am at least 18.</label></fieldset>
          )}
          <WalletGate wallet={browser.wallet}>
            {!account ? <p className="notice" role="status">Loading balance and allowance…</p> : insufficientUsdc ? <p className="notice warning" role="status">This wallet does not have enough USDC for the reviewed total.</p> : needsApproval && payment === "usdc" ? (
              approval?.enabled && quote ? <TransactionFlow key={`approve-${packId}-${quantity}-${quote.totalUsdc}`} service={browser.service} wallet={browser.wallet} action={{ kind: "approveUsdc", id: snapshot.id, packId, quantity }} label="Approve exact USDC" formatUsdc={formatUsdc} onConfirmed={onConfirmed} /> : <p className="notice warning" role="status">{approval?.reason || "USDC approval is not available."}</p>
            ) : !allAgreed ? <p className="notice warning" role="status">Review and accept all three confirmations to continue.</p>
              : agreementState !== "saved" ? <div className="stack"><button className="btn" type="button" disabled={!recordAgreement || agreementState === "saving"} onClick={() => void recordReviewedAgreement()}>{agreementState === "saving" ? "Recording agreement…" : "Sign and record agreement"}</button>{!recordAgreement ? <p className="notice warning" role="status">Agreement storage is not configured. Purchasing is unavailable.</p> : null}{agreementState === "error" ? <p className="notice error" role="alert">{agreementError}</p> : null}</div>
                : purchaseAction && purchase?.enabled ? <TransactionFlow key={`buy-${packId}-${quantity}-${payment}`} service={browser.service} wallet={browser.wallet} action={purchaseAction} label="Purchase membership" formatUsdc={formatUsdc} onConfirmed={onConfirmed} /> : <p className="notice warning" role="status">{purchase?.reason || "Purchase is not available."}</p>}
          </WalletGate>
        </>
      ) : <p className="notice" role="status">Membership sales are not open{snapshot.paused && Number(snapshot.raffle.phase) === 1 ? " because admissions are paused" : ""}.</p>}
      {account && (account.principal > 0n || account.fee > 0n) ? <div className="account-balance"><span>Your refundable balance</span><strong>{formatUsdc(account.principal + account.fee)} USDC</strong><small>Membership price and lab fee are claimable only when contract state allows a refund.</small></div> : null}
      {nextRecovery && recoveryAction ? <section className="workflow-next stack"><div><p className="kicker">Available now</p><h2>{nextRecovery.label}</h2><p>{nextRecovery.reason || (nextRecovery.kind === "claimFee" ? "Anyone can send the fee to the pinned treasury; it is never paid to the caller." : "The contract currently permits this action.")}</p></div><TransactionFlow service={browser.service} wallet={browser.wallet} action={recoveryAction} label={nextRecovery.label} formatUsdc={formatUsdc} onConfirmed={onConfirmed} /></section> : null}
    </div>
  );
}

function SellerActions({ browser, snapshot, account, availability, recoverCommitment, onConfirmed }: {
  browser: Extract<BrowserService, { kind: "configured" }>;
  snapshot: RaffleSnapshot;
  account: AccountRaffleState | null;
  availability: readonly ActionAvailability[];
  recoverCommitment?: RecoverCommitment;
  onConfirmed: () => Promise<void>;
}) {
  const [policy, setPolicy] = useState<Awaited<ReturnType<typeof browser.service.openingPolicy>> | null>(null);
  const [recovered, setRecovered] = useState<ReserveRecord | null>(null);
  const [preflight, setPreflight] = useState<"idle" | "loading" | "error">("idle");
  const [preflightError, setPreflightError] = useState("");
  const preflightInFlight = useRef(false);
  const priority: WorkflowAction["kind"][] = ["approvePrize", "escrow", "open", "close", "snapshot", "requestRandomness", "abortDrawing", "settle", "reveal", "claimPrize", "claimProceeds", "claimFee", "refund", "reclaimPrize", "cancel"];
  if (snapshot.block.timestamp >= snapshot.raffle.salesEnd + snapshot.drawStartGrace) priority.unshift("cancel");
  const next = priority.map((kind) => availability.find((item) => item.kind === kind)).find((item) => item?.enabled);

  async function reviewOpeningPolicy() {
    if (preflightInFlight.current) return;
    preflightInFlight.current = true;
    setPreflight("loading");
    setPreflightError("");
    try { setPolicy(await browser.service.openingPolicy()); setPreflight("idle"); }
    catch (error) { setPreflightError(error instanceof Error ? error.message : "Opening policy could not be loaded."); setPreflight("error"); }
    finally { preflightInFlight.current = false; }
  }

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

  if (!account) return <WalletGate wallet={browser.wallet}><p className="notice" role="status">Loading seller controls…</p></WalletGate>;
  if (!next) return <p className="notice" role="status">No seller action is currently available. Refresh after the deadline or a pending transaction confirms.</p>;
  if (next.kind === "open") {
    if (!policy) return <section className="workflow-next stack"><div><p className="kicker">Seller action</p><h2>Review opening policy</h2><p>Opening fixes the treasury, terms and randomness configuration for this raffle.</p></div><button className="btn" type="button" disabled={preflight === "loading"} onClick={() => void reviewOpeningPolicy()}>{preflight === "loading" ? "Loading policy…" : "Review opening policy"}</button>{preflight === "error" ? <p className="notice error" role="alert">{preflightError}</p> : null}</section>;
    return <section className="workflow-next stack"><div><p className="kicker">Opening policy</p><h2>Open memberships</h2><p>Review the pinned recipients and terms before opening. They cannot be edited after this transaction.</p></div><dl className="review-list"><div><dt>Treasury</dt><dd className="hash">{policy.policy.treasury}</dd></div><div><dt>Coordinator</dt><dd className="hash">{policy.policy.coordinator}</dd></div><div><dt>Terms</dt><dd className="hash">{policy.policy.termsHash}</dd></div><div><dt>Payment</dt><dd>{policy.policy.nativePayment ? "Native VRF billing" : "LINK VRF billing"}</dd></div><div><dt>State block</dt><dd>{policy.block.number.toString()}</dd></div></dl><TransactionFlow service={browser.service} wallet={browser.wallet} action={{ kind: "open", id: snapshot.id, expectedPolicyHash: policy.hash }} label="Open memberships" formatUsdc={formatUsdc} onConfirmed={onConfirmed} /><button className="text-link" type="button" onClick={() => setPolicy(null)}>Refresh policy review</button></section>;
  }
  if (next.kind === "reveal") {
    if (!recoverCommitment) return <p className="notice warning" role="status">Commitment recovery is not configured. Reveal is unavailable.</p>;
    if (!recovered) return <section className="workflow-next stack"><div><p className="kicker">Seller action</p><h2>Recover commitment</h2><p>A wallet signature retrieves the private hashes for this raffle. Nothing is revealed until you separately review the transaction.</p></div><button className="btn" type="button" disabled={preflight === "loading"} onClick={() => void recoverSavedCommitment()}>{preflight === "loading" ? "Opening wallet…" : "Sign to recover commitment"}</button>{preflight === "error" ? <p className="notice error" role="alert">{preflightError}</p> : null}</section>;
    return <section className="workflow-next stack"><div><p className="kicker">Commitment recovered</p><h2>Reveal commitment</h2><p>The review below submits the saved public and private hashes and salt. The original private value stays off-chain.</p></div><TransactionFlow service={browser.service} wallet={browser.wallet} action={{ kind: "reveal", id: snapshot.id, publicHash: recovered.publicHash, privateHash: recovered.privateHash, salt: recovered.salt }} label="Reveal commitment" formatUsdc={formatUsdc} onConfirmed={onConfirmed} /></section>;
  }
  const action: WorkflowAction = next.kind === "snapshot"
    ? { kind: "snapshot", id: snapshot.id, maxSteps: 100n }
    : { kind: next.kind as "approvePrize" | "escrow" | "close" | "requestRandomness" | "abortDrawing" | "settle" | "claimPrize" | "claimProceeds" | "claimFee" | "refund" | "reclaimPrize" | "cancel", id: snapshot.id };
  return <section className="workflow-next stack"><div><p className="kicker">Seller action</p><h2>{next.label}</h2><p>{next.reason}</p></div><TransactionFlow service={browser.service} wallet={browser.wallet} action={action} label={next.label} formatUsdc={formatUsdc} onConfirmed={onConfirmed} /></section>;
}

function RecoveryAlternatives({ browser, snapshot, availability, onConfirmed }: {
  browser: Extract<BrowserService, { kind: "configured" }>; snapshot: RaffleSnapshot;
  availability: readonly ActionAvailability[]; onConfirmed: () => Promise<void>;
}) {
  const kinds = ["settle", "cancel", "abortDrawing", "refund", "reclaimPrize"] as const;
  const actions = kinds.flatMap(kind => { const item = availability.find(item => item.kind === kind && item.enabled); return item ? [{ ...item, kind }] : []; });
  if (!actions.length) return null;
  return <section className="workflow-details stack" aria-label="Other available actions"><h3>Available recovery and settlement</h3><p>These actions do not require commitment recovery.</p>{actions.map(item => <TransactionFlow key={item.kind} service={browser.service} wallet={browser.wallet} action={{ kind: item.kind, id: snapshot.id }} label={item.label} formatUsdc={formatUsdc} onConfirmed={onConfirmed} />)}</section>;
}
