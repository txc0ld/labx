"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { SELLER_FEE_BPS, sellerAccounting } from "@/lib/chain/fees";
import type { BrowserService, RaffleService } from "@/lib/chain/ports";
import { scanSellerPortfolio, sellerPortfolioTotals } from "@/lib/chain/seller-portfolio";
import type { BlockRef, RaffleSnapshot } from "@/lib/chain/types";
import { drawRunnerEnabled } from "@/lib/draw-runner/enabled";
import styles from "./SellerPortal.module.css";
import { ResumeTransaction } from "./ResumeTransaction";
import { catalogAvailability, formatUsdcAmount, networkName } from "./format";
import { LocalTime } from "./LocalTime";
import { cardNextStep } from "./seller-card";
import { useRevealTime } from "./useRevealTime";
import { useWalletSnapshot, WalletGate } from "./WalletGate";

type SellerState =
  | { kind: "idle" }
  | { kind: "scanning"; raffles: readonly RaffleSnapshot[]; block: BlockRef | null }
  | { kind: "incomplete"; raffles: readonly RaffleSnapshot[]; block: BlockRef | null; message: string }
  | { kind: "ready"; raffles: readonly RaffleSnapshot[]; block: BlockRef };

export function SellerDashboard({ browser, draftForm, revision = 0, loading = false, creating = false }: {
  browser: BrowserService;
  draftForm?: React.ReactNode;
  revision?: number;
  /** True until the browser has read its deployment configuration. */
  loading?: boolean;
  /** True while a Create activation runs, so the empty state does not contradict it. */
  creating?: boolean;
}) {
  const wallet = useWalletSnapshot(browser.wallet);
  const [state, setState] = useState<SellerState>({ kind: "idle" });
  // null until the seller opens or closes Create; until then it opens by itself for a seller with no raffles.
  const [createToggled, setCreateToggled] = useState<boolean | null>(null);
  // The draft form, with its wallet NFT gallery, loads the first time Create opens and then stays, so closing keeps the seller's entries.
  const [createLoaded, setCreateLoaded] = useState(false);
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

  if (loading) return <div className={styles.skeleton} role="status"><span /><span /><span /><p>Loading your studio…</p></div>;
  if (browser.kind === "unavailable") return <div className={`${styles.gate} notice warning`} role="status"><strong>The studio is unavailable right now.</strong><span>{browser.reason}</span></div>;
  if (wallet.kind === "connected" && wallet.chainId !== browser.service.manifest.chainId) {
    return <div className={`${styles.gate} notice warning`} role="status"><strong>Wrong network</strong><span>Switch your wallet to {networkName(browser.service.manifest.chainId)} to load your raffles.</span><small>Raffle data and totals stay hidden until the wallet and reviewed deployment use the same network.</small></div>;
  }

  const totals = state.kind === "ready" ? sellerPortfolioTotals(state.raffles) : null;
  const raffles = state.kind === "idle" ? [] : state.raffles;
  const scanning = state.kind === "idle" || state.kind === "scanning";
  const seller = wallet.kind === "connected" ? wallet.account : null;
  const createOpen = createToggled ?? (creating || state.kind === "ready" && state.raffles.length === 0);
  if (createOpen && !createLoaded) setCreateLoaded(true);

  return (
    <WalletGate wallet={browser.wallet}>
      <div className={styles.portal}>
        <ResumeTransaction browser={browser} pendingOnly onConfirmed={load} confirmedThroughBlock={state.kind === "ready" ? state.block.number : undefined} deferRefresh={state.kind !== "ready"} />

        <section className={styles.createPanel} aria-label="Create a raffle draft">
          <details open={createOpen} onToggle={event => { const open = event.currentTarget.open; if (open !== createOpen) setCreateToggled(open); }}>
            <summary><span><strong>Create a raffle</strong><em>Choose your NFT, set memberships, then press Create. LABx reviews it before you list.</em></span><span className={styles.summaryIcon} aria-hidden="true">＋</span></summary>
            <div className={styles.createBody}>{!createLoaded ? null : draftForm ?? <><p>Draft creation needs the commitment recovery service.</p><p className="notice warning" role="status">Never enter a seed phrase, wallet key or account password.</p></>}</div>
          </details>
        </section>

        <section className={styles.raffles} aria-labelledby="seller-raffles-title">
          <div className={styles.sectionHeading}><div><h2 id="seller-raffles-title">Your raffles</h2></div>{state.kind === "ready" ? <span>{state.raffles.length} total</span> : null}</div>
          {scanning && raffles.length === 0 ? <RaffleSkeleton /> : null}
          {state.kind === "ready" && state.raffles.length === 0 && !creating ? (
            <div className={styles.emptyState}><span className={styles.emptyMark} aria-hidden="true">＋</span><div><strong>No raffles yet</strong><p>Your raffles appear here after you create one.</p></div></div>
          ) : null}
          {raffles.length > 0 && seller ? <ol className={styles.raffleList}>{raffles.map((snapshot) => <SellerRaffleCard key={snapshot.id.toString()} service={browser.service} snapshot={snapshot} seller={seller} />)}</ol> : null}
          {state.kind === "incomplete" ? <div className={`${styles.inlineWarning} notice warning`} role="alert"><p>{raffles.length > 0 ? "Some raffles couldn't be loaded." : "Your raffles couldn't be loaded."}</p><button className="btn btn-dark" type="button" onClick={() => void load()}>Reload raffles</button></div> : null}
        </section>
        <details className={styles.revenueDisclosure}>
          <summary>Revenue</summary>
          {totals ? (
            <dl className={styles.revenue}>
              <Amount label="Sales" value={totals.grossPrincipal} />
              <Amount label={shareLabel(state.kind === "ready" ? state.raffles : [])} value={totals.earnedNetProceeds} />
              <Amount label="Paid to you" value={totals.paidProceeds} />
              {totals.claimableProceeds > 0n ? <Amount label="Ready to claim" value={totals.claimableProceeds} /> : null}
              {totals.pendingPrincipal > 0n ? <Amount label="Held until the draw" value={totals.pendingPrincipal} /> : null}
              {totals.refundLiability > 0n ? <Amount label="Owed to buyers" value={totals.refundLiability} /> : null}
            </dl>
          ) : (
            <div className={styles.totalsPending} role={state.kind === "incomplete" ? "alert" : "status"}>
              <p>{state.kind === "incomplete" ? "Revenue can't be added up until every raffle loads." : "Adding up your raffles…"}</p>
              {state.kind === "incomplete" ? <button className="btn btn-dark" type="button" onClick={() => void load()}>Try again</button> : null}
            </div>
          )}
        </details>
      </div>
    </WalletGate>
  );
}

/** "Your share after the 2% fee", or a general label when settled raffles used different seller fees. */
function shareLabel(raffles: readonly RaffleSnapshot[]) {
  const rates = new Set(raffles.filter(snapshot => snapshot.raffle.phase === 5).map(snapshot => snapshot.policy.sellerFeeBps));
  const [rate = SELLER_FEE_BPS] = rates;
  return rates.size > 1 ? "Your share after fees" : `Your share after the ${rate / 100}% fee`;
}

function Amount({ label, value }: { label: string; value: bigint }) {
  return <div><dt>{label}</dt><dd>{formatUsdcAmount(value)} <small>USDC</small></dd></div>;
}

function SellerRaffleCard({ service, snapshot, seller }: { service: RaffleService; snapshot: RaffleSnapshot; seller: Address }) {
  const accounting = sellerAccounting(snapshot);
  const runner = drawRunnerEnabled();
  const revealedAt = useRevealTime(service, snapshot, runner);
  const next = cardNextStep(snapshot, seller, runner, revealedAt);
  return (
    <li>
      <div className={styles.cardTopline}><span>Raffle #{snapshot.id.toString()}</span><span className={styles.phase}>{catalogAvailability(snapshot).label}</span></div>
      <div className={styles.cardTitle}><h3>{snapshot.raffle.title}</h3><p>Closes <LocalTime at={snapshot.raffle.salesEnd} /></p></div>
      <dl className={styles.cardFacts}><div><dt>Sales</dt><dd>{formatUsdcAmount(accounting.grossPrincipal)} USDC</dd></div>{accounting.refundLiability > 0n ? <div><dt>Owed to buyers</dt><dd>{formatUsdcAmount(accounting.refundLiability)} USDC</dd></div> : null}</dl>
      <p className={styles.cardNext}>{next.status}</p>
      <Link className={`btn btn-dark ${styles.manageButton}`} href={`/seller/${snapshot.id.toString()}`} aria-label={`${next.label}: ${snapshot.raffle.title}`}>{next.label} <span aria-hidden="true">→</span></Link>
    </li>
  );
}

function RaffleSkeleton() {
  return <div className={styles.skeleton} role="status"><span /><span /><span /><p>Loading your raffles…</p></div>;
}
