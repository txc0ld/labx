"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { sellerAccounting } from "@/lib/chain/fees";
import type { BrowserService } from "@/lib/chain/ports";
import { scanSellerPortfolio, sellerPortfolioTotals } from "@/lib/chain/seller-portfolio";
import type { BlockRef, RaffleSnapshot } from "@/lib/chain/types";
import styles from "./SellerPortal.module.css";
import { ResumeTransaction } from "./ResumeTransaction";
import { formatDate, formatUsdc, phaseLabel } from "./format";
import { useWalletSnapshot, WalletGate } from "./WalletGate";

type SellerState =
  | { kind: "idle" }
  | { kind: "scanning"; raffles: readonly RaffleSnapshot[]; block: BlockRef | null }
  | { kind: "incomplete"; raffles: readonly RaffleSnapshot[]; block: BlockRef | null; message: string }
  | { kind: "ready"; raffles: readonly RaffleSnapshot[]; block: BlockRef };

export function SellerDashboard({ browser, draftForm, revision = 0 }: { browser: BrowserService; draftForm?: React.ReactNode; revision?: number }) {
  const wallet = useWalletSnapshot(browser.wallet);
  const [state, setState] = useState<SellerState>({ kind: "idle" });
  const request = useRef(0);

  async function load() {
    if (browser.kind !== "configured" || wallet.kind !== "connected" || wallet.chainId !== browser.service.manifest.chainId) return;
    const version = ++request.current;
    setState({ kind: "scanning", raffles: [], block: null });
    const result = await scanSellerPortfolio({
      service: browser.service,
      seller: wallet.account,
      isCurrent: () => version === request.current,
      onProgress: (raffles, block) => {
        if (version === request.current) setState({ kind: "scanning", raffles, block });
      }
    });
    if (version !== request.current || result.kind === "stale") return;
    setState(result.kind === "complete" ? { kind: "ready", raffles: result.raffles, block: result.block } : result);
  }

  useEffect(() => {
    request.current += 1;
    setState({ kind: "idle" });
    if (browser.kind === "configured" && wallet.kind === "connected" && wallet.chainId === browser.service.manifest.chainId) void load();
    return () => { request.current += 1; };
    // The wallet revision invalidates delayed pages even when the account address is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, wallet.kind, wallet.kind === "connected" ? wallet.account : "", wallet.kind === "connected" ? wallet.chainId : 0, wallet.revision, revision]);

  if (browser.kind === "unavailable") return <div className={`${styles.gate} notice warning`} role="status"><strong>Studio unavailable</strong><span>{browser.reason}</span><small>No example revenue or raffle data is shown without a reviewed deployment.</small></div>;
  if (wallet.kind === "connected" && wallet.chainId !== browser.service.manifest.chainId) {
    return <div className={`${styles.gate} notice warning`} role="status"><strong>Wrong network</strong><span>Switch your wallet to chain {browser.service.manifest.chainId} to load this seller portfolio.</span><small>Raffle data and totals stay hidden until the wallet and reviewed deployment use the same network.</small></div>;
  }

  const totals = state.kind === "ready" ? sellerPortfolioTotals(state.raffles) : null;
  const raffles = state.kind === "idle" ? [] : state.raffles;
  const scanning = state.kind === "idle" || state.kind === "scanning";

  return (
    <WalletGate wallet={browser.wallet}>
      <div className={styles.portal}>
        <ResumeTransaction browser={browser} pendingOnly onConfirmed={load} confirmedThroughBlock={state.kind === "ready" ? state.block.number : undefined} deferRefresh={state.kind !== "ready"} />

        <section className={styles.createPanel} aria-label="Create a raffle draft">
          <details>
            <summary><span><small>New raffle</small><strong>Create a raffle</strong><em>Choose your NFT, set memberships, then press Create. LABx reviews it before you list.</em></span><span className={styles.summaryIcon} aria-hidden="true">＋</span></summary>
            <div className={styles.createBody}>{draftForm ?? <><p>Draft creation needs the commitment recovery service.</p><p className="notice warning" role="status">Never enter a seed phrase, wallet key or account password.</p></>}</div>
          </details>
        </section>

        <section className={styles.raffles} aria-labelledby="seller-raffles-title">
          <div className={styles.sectionHeading}><div><h2 id="seller-raffles-title">Your raffles</h2></div>{state.kind === "ready" ? <span>{state.raffles.length} total</span> : null}</div>
          {scanning && raffles.length === 0 ? <RaffleSkeleton /> : null}
          {state.kind === "ready" && state.raffles.length === 0 ? (
            <div className={styles.emptyState}><span className={styles.emptyMark} aria-hidden="true">＋</span><div><strong>No raffles for this wallet yet</strong><p>Start with Create a raffle above. You choose when to list after LABx approval.</p></div></div>
          ) : null}
          {raffles.length > 0 ? <ol className={styles.raffleList}>{raffles.map((snapshot) => <SellerRaffleCard key={snapshot.id.toString()} snapshot={snapshot} />)}</ol> : null}
          {state.kind === "incomplete" && raffles.length > 0 ? <p className={`${styles.inlineWarning} notice warning`}>Showing discovered raffles only. Revenue totals remain hidden until the full scan succeeds.</p> : null}
        </section>
        <details className={styles.revenueDisclosure}>
          <summary>Revenue and sales</summary>
        <section className={styles.overview} aria-labelledby="seller-overview-title">
          <div className={styles.overviewHeading}>
            <div><p className="kicker">Seller portfolio</p><h2 id="seller-overview-title">Revenue at a glance</h2></div>
            <div className={styles.scanStatus} aria-live="polite"><span className={styles.statusDot} data-active={scanning} aria-hidden="true" />{scanning ? `Scanning all raffles${raffles.length ? ` · ${raffles.length} found` : ""}` : state.kind === "ready" ? `Complete at block ${state.block.number.toString()}` : "Scan incomplete"}</div>
          </div>
          {totals ? (
            <div className={styles.metricClusters}>
              <section className={styles.metricCluster} aria-labelledby="seller-proceeds-title">
                <h3 id="seller-proceeds-title">Seller proceeds</h3>
                <dl className={styles.metrics}>
                  <Metric label="Earned net revenue" value={totals.earnedNetProceeds} note="Settled proceeds after seller commission" primary />
                  <Metric label="Already claimed" value={totals.paidProceeds} note="Settled proceeds paid to this seller" />
                  <Metric label="Ready to claim" value={totals.claimableProceeds} note="Settled seller proceeds still in escrow" />
                </dl>
              </section>
              <section className={styles.metricCluster} aria-labelledby="seller-exposure-title">
                <h3 id="seller-exposure-title">Pending &amp; refunds</h3>
                <dl className={styles.metrics}>
                  <Metric label="Pending principal" value={totals.pendingPrincipal} note="Open or drawing; not earned revenue" />
                  <Metric label="Refund liability" value={totals.refundLiability} note="Outstanding principal only for cancelled raffles" />
                </dl>
              </section>
              <section className={styles.metricCluster} aria-labelledby="seller-sales-context-title">
                <h3 id="seller-sales-context-title">Sales history</h3>
                <dl className={styles.metrics}>
                  <Metric label="Gross pack sales" value={totals.grossPrincipal} note="Includes sales later cancelled and refunded" />
                  <Metric label="Processing fees paid" value={totals.buyerFees} note="Historical buyer fees; never seller revenue or refund liability" />
                </dl>
              </section>
            </div>
          ) : (
            <div className={styles.totalsPending} role={state.kind === "incomplete" ? "alert" : "status"}>
              <strong>{state.kind === "incomplete" ? "Portfolio totals are incomplete" : "Calculating complete portfolio totals"}</strong>
              <p>{state.kind === "incomplete" ? state.message : "Totals appear only after every catalog page is read at one verified block."}</p>
              {state.kind === "incomplete" ? <button className="btn btn-dark" type="button" onClick={() => void load()}>Retry full scan</button> : null}
            </div>
          )}
        </section>

        </details>

      </div>
    </WalletGate>
  );
}

function Metric({ label, value, note, primary = false }: { label: string; value: bigint; note: string; primary?: boolean }) {
  return <div className={styles.metric} data-primary={primary}><dt>{label}</dt><dd>{formatUsdc(value)} <small>USDC</small></dd><p>{note}</p></div>;
}

function SellerRaffleCard({ snapshot }: { snapshot: RaffleSnapshot }) {
  const accounting = sellerAccounting(snapshot);
  const phase = Number(snapshot.raffle.phase);
  const outcome = phase === 5
    ? { label: accounting.claimableProceeds > 0n ? "Ready to claim" : "Net earned", value: accounting.claimableProceeds > 0n ? accounting.claimableProceeds : accounting.netProceeds }
    : phase === 6
      ? { label: "Refund liability", value: accounting.refundLiability }
      : { label: "Pending principal", value: accounting.pendingPrincipal };
  const admission = snapshot.admission.status === "pending" ? "Pending review"
    : snapshot.admission.status === "changed" ? "Changed since review"
      : snapshot.admission.status === "approved" ? "Approved for current draft"
        : snapshot.admission.status === "opened" ? "Approved at opening" : "No approval recorded at opening";
  return (
    <li>
      <div className={styles.cardTopline}><span>Raffle #{snapshot.id.toString()}</span><span className={styles.phase}>{phaseLabel(phase)}</span></div>
      <div className={styles.cardTitle}><h3>{snapshot.raffle.title}</h3><p>Closes {formatDate(snapshot.raffle.salesEnd)} UTC</p></div>
      <dl className={styles.cardFacts}><div><dt>LABx review</dt><dd>{admission}</dd></div><div><dt>Gross pack sales</dt><dd>{formatUsdc(accounting.grossPrincipal)} USDC</dd></div><div><dt>{outcome.label}</dt><dd>{formatUsdc(outcome.value)} USDC</dd></div></dl>
      <Link className={`btn btn-dark ${styles.manageButton}`} href={`/seller/${snapshot.id.toString()}`}>Manage raffle <span aria-hidden="true">→</span></Link>
    </li>
  );
}

function RaffleSkeleton() {
  return <div className={styles.skeleton} role="status"><span /><span /><span /><p>Reading verified seller raffles…</p></div>;
}
