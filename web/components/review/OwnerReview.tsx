"use client";
import { SubmissionNotDispatchedError } from "@/lib/chain/submission-errors";
import { isWalletRequestRejected } from "@/lib/chain/wallet-errors";

import { useActionTrust } from "../workflow/useActionTrust";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { isHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { useBench } from "@/lib/bench";
import { parseOwnerExecutionIntent, serializeOwnerExecutionIntent } from "@/lib/chain/owner-execution";
import type { OwnerExecutionDiscoveryCursor } from "@/lib/chain/owner-execution-discovery";
import { safeTransactionFile } from "@/lib/chain/safe-transaction";
import type { BrowserService, RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { AdmissionReview, BlockRef, OwnerAction, OwnerExecutionConfirmation, OwnerExecutionIntent, RaffleSnapshot, WalletSnapshot } from "@/lib/chain/types";
import { sameAddress } from "@/lib/chain/validation";
import { formatDate, formatUsdc, shortAddress } from "@/components/workflow/format";
import { useWalletSnapshot, WalletGate } from "@/components/workflow/WalletGate";
import { WalletConnectionControls } from "@/components/workflow/WalletConnectionControls";
import styles from "./OwnerReview.module.css";

type QueueState =
  | { kind: "idle" | "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: readonly RaffleSnapshot[]; nextCursor: bigint | null; block: BlockRef; loadingMore: boolean };

type DetailState =
  | { kind: "loading" }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; review: AdmissionReview };

type OwnerHintState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; owner: Address };

type Attestations = { canonicalProvenance: boolean; transferRestrictions: boolean; drawFunding: boolean };
export type ReviewAttestationState = Attestations & { attestedDigest: Hex | null };

type FlowState =
  | { kind: "idle" }
  | { kind: "preparing"; actionKind: OwnerAction["kind"] }
  | { kind: "exported" | "requested"; intent: OwnerExecutionIntent; copied: boolean; error?: string }
  | { kind: "recovery"; intent: OwnerExecutionIntent; message?: string }
  | { kind: "confirming"; intent: OwnerExecutionIntent; hash: Hex; confirmationOnly: boolean }
  | { kind: "pending"; intent: OwnerExecutionIntent; hash: Hex; confirmationOnly: boolean }
  | { kind: "executed"; confirmation: Extract<OwnerExecutionConfirmation, { kind: "executed" }> }
  | { kind: "error"; message: string };

type DiscoveryState =
  | { kind: "idle" }
  | { kind: "range"; fromBlock: bigint; toBlock: bigint; head: bigint; caughtUp: boolean; reset: boolean }
  | { kind: "error"; message: string };

const EMPTY_ATTESTATIONS: Attestations = { canonicalProvenance: false, transferRestrictions: false, drawFunding: false };
const EMPTY_REVIEW_ATTESTATIONS: ReviewAttestationState = { ...EMPTY_ATTESTATIONS, attestedDigest: null };

export function changeReviewAttestation(current: ReviewAttestationState, reviewHash: Hex | null, key: keyof Attestations, value: boolean): ReviewAttestationState {
  return { ...(current.attestedDigest === reviewHash ? current : EMPTY_REVIEW_ATTESTATIONS), attestedDigest: reviewHash, [key]: value };
}

export function admissionLabel(snapshot: RaffleSnapshot) {
  switch (snapshot.admission.status) {
    case "pending": return { label: "Pending review", detail: "No owner approval is recorded for this draft." };
    case "changed": return { label: "Changed since review", detail: "A prior approval no longer matches the current draft, owner or opening policy." };
    case "approved": return { label: "Approved for current draft", detail: "The recorded approval matches this exact draft and current owner." };
    case "opened": return { label: "Approved at opening", detail: "The approval was recorded when memberships opened. It is historical after opening." };
    case "not-opened": return { label: "No opening approval recorded", detail: "The historical admission record does not show approval at opening." };
    default: {
      const exhaustive: never = snapshot.admission;
      return exhaustive;
    }
  }
}

export function formatOwnerPayload(intent: OwnerExecutionIntent) {
  return JSON.stringify({ chainId: intent.chainId, from: intent.from, to: intent.to, value: 0, data: intent.data }, null, 2);
}

type OwnerQueueSource = Pick<RaffleService, "readOwner" | "listOwnerQueue">;

export async function loadOwnerQueuePage({ service, account, cursor, block }: {
  service: OwnerQueueSource;
  account: Address;
  cursor?: bigint;
  block?: BlockRef;
}) {
  const identity = await service.readOwner({ block });
  if (!sameAddress(identity.owner, account)) throw new Error("This route is available only to the current on-chain raffle owner.");
  return service.listOwnerQueue({ cursor, limit: 24, block: identity.block });
}

function chainName(chainId: number) {
  return chainId === 11155111 ? "Ethereum Sepolia" : chainId === 31337 ? "Isolated local chain" : `Chain ${chainId}`;
}

function explorerAddress(chainId: number, address: Address) {
  return chainId === 11155111 ? `https://sepolia.etherscan.io/address/${address}` : null;
}

function explorerToken(chainId: number, address: Address, tokenId: bigint) {
  return chainId === 11155111 ? `https://sepolia.etherscan.io/token/${address}?a=${tokenId.toString()}` : null;
}

function safeQueue(chainId: number, owner: Address) {
  return chainId === 11155111 ? `https://app.safe.global/transactions/queue?safe=sep:${owner}` : null;
}

function SafeConnectionHelp({ service, wallet, snapshot, owner, headingLevel = "h1" }: {
  service: RaffleService;
  wallet: WalletSessionPort;
  snapshot: WalletSnapshot;
  owner: Address;
  headingLevel?: "h1" | "h2";
}) {
  const href = safeQueue(service.manifest.chainId, owner);
  const Heading = headingLevel;
  return <section className={`section page-frame stack ${styles.connectionHelp}`} aria-labelledby="safe-connection-title">
    <div><p className="kicker">Safe connection</p><Heading className="page-title" id="safe-connection-title">Connect the Safe to LABx</Heading></div>
    <p>Use the Safe account itself here. Keep the signer wallet connected inside Safe, where it can review and authorize the transaction later.</p>
    <dl className={styles.facts}><div><dt>Required Safe</dt><dd className="hash">{owner}</dd></div><div><dt>Required network</dt><dd>{chainName(service.manifest.chainId)} ({service.manifest.chainId})</dd></div></dl>
    <ol className={styles.stepList}>
      <li>In LABx, choose <strong>Connect wallet</strong>, then <strong>WalletConnect</strong>. Beneath the QR code choose <strong>Copy link</strong>.</li>
      <li>{href ? <><a href={href} target="_blank" rel="noreferrer">Open this exact Safe <span aria-hidden="true">↗</span></a>, then in the Safe header choose <strong>WalletConnect</strong>.</> : <>Open the owner Safe for this isolated network, then in the Safe header choose <strong>WalletConnect</strong>.</>} Paste the copied connection link and approve the connection.</li>
      <li>Return to LABx. The connected account must be the Safe address above, not its signer wallet.</li>
    </ol>
    {snapshot.kind === "connected" && snapshot.chainId === service.manifest.chainId && !sameAddress(snapshot.account, owner) ? <p className="notice warning" role="status">LABx currently sees {snapshot.account}. Disconnect it and connect the Safe address above through WalletConnect.</p> : null}
    <WalletGate wallet={wallet}><WalletConnectionControls wallet={wallet} /></WalletGate>
  </section>;
}

function formatBps(bps: number) {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  return `${whole}${fraction ? `.${fraction.toString().padStart(2, "0").replace(/0+$/, "")}` : ""}%`;
}

function idFromRoute(raw: string) {
  if (!/^[1-9]\d{0,77}$/.test(raw)) return null;
  const id = BigInt(raw);
  return id < 2n ** 256n ? id : null;
}

export function LiveOwnerReviewQueue() {
  const bench = useBench();
  return <OwnerReviewQueue browser={bench.browser} />;
}

export function LiveOwnerReviewDetail({ id }: { id: string }) {
  const bench = useBench();
  return <OwnerReviewDetail browser={bench.browser} rawId={id} />;
}

function OwnerReviewQueue({ browser }: { browser: BrowserService }) {
  const wallet = useWalletSnapshot(browser.wallet);
  const [state, setState] = useState<QueueState>({ kind: "idle" });
  const [ownerHint, setOwnerHint] = useState<OwnerHintState>({ kind: "loading" });
  const request = useRef(0);
  const ownerRequest = useRef(0);

  async function loadOwnerHint() {
    const version = ++ownerRequest.current;
    setOwnerHint({ kind: "loading" });
    if (browser.kind !== "configured") return;
    try {
      const deployment = await browser.service.attest();
      if (version !== ownerRequest.current) return;
      if (deployment.kind !== "verified") throw new Error(deployment.reason);
      const identity = await browser.service.readOwner({ block: deployment.block });
      if (version === ownerRequest.current) setOwnerHint({ kind: "ready", owner: identity.owner });
    } catch (error) {
      if (version === ownerRequest.current) setOwnerHint({ kind: "error", message: error instanceof Error ? error.message : "The current Safe could not be loaded." });
    }
  }

  useEffect(() => {
    void loadOwnerHint();
    return () => { ownerRequest.current += 1; };
    // The browser service identity defines the public attestation request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser]);

  async function load(cursor?: bigint) {
    if (browser.kind !== "configured" || wallet.kind !== "connected" || wallet.chainId !== browser.service.manifest.chainId) return;
    const version = ++request.current;
    if (cursor === undefined) setState({ kind: "loading" });
    else setState((current) => current.kind === "ready" ? { ...current, loadingMore: true } : current);
    try {
      if (cursor === undefined) {
        const deployment = await browser.service.attest();
        if (deployment.kind !== "verified") throw new Error(deployment.reason);
      }
      const page = await loadOwnerQueuePage({
        service: browser.service,
        account: wallet.account,
        cursor,
        block: cursor !== undefined && state.kind === "ready" ? state.block : undefined
      });
      if (version !== request.current) return;
      setState((current) => ({
        kind: "ready",
        items: cursor !== undefined && current.kind === "ready" ? [...current.items, ...page.items] : page.items,
        nextCursor: page.nextCursor,
        block: page.block,
        loadingMore: false
      }));
    } catch (error) {
      if (version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "The review queue could not be loaded." });
    }
  }

  useEffect(() => {
    setState({ kind: "idle" });
    if (browser.kind === "configured" && ownerHint.kind === "ready" && wallet.kind === "connected"
      && wallet.chainId === browser.service.manifest.chainId && sameAddress(wallet.account, ownerHint.owner)) void load();
    return () => { request.current += 1; };
    // Wallet, chain and deployment changes discard the previous bounded page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, wallet, ownerHint]);

  if (browser.kind === "unavailable") return <div className="notice warning" role="status">{browser.reason}</div>;
  if (ownerHint.kind === "loading") return <div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading Safe access</strong><p>Checking the verified network and current owner.</p></div></div>;
  if (ownerHint.kind === "error") return <div className="notice error stack" role="alert"><strong>Safe access unavailable</strong><span>{ownerHint.message}</span><button className="btn btn-dark" type="button" onClick={() => void loadOwnerHint()}>Retry Safe check</button></div>;
  if (wallet.kind !== "connected" || wallet.chainId !== browser.service.manifest.chainId || !sameAddress(wallet.account, ownerHint.owner)) {
    return <SafeConnectionHelp service={browser.service} wallet={browser.wallet} snapshot={wallet} owner={ownerHint.owner} headingLevel="h2" />;
  }

  return (
    <WalletGate wallet={browser.wallet}>
      <div className={styles.shell}>
        {state.kind === "idle" || state.kind === "loading" ? <div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading the review queue</strong><p>Scanning at most 24 raffle IDs on this page.</p></div></div> : null}
        {state.kind === "error" ? <div className="notice error stack" role="alert"><strong>Owner review unavailable</strong><span>{state.message}</span><button className="btn btn-dark" type="button" onClick={() => void load()}>Retry owner check</button></div> : null}
        {state.kind === "ready" ? <OwnerQueueView state={state} onLoadMore={(cursor) => void load(cursor)} /> : null}
      </div>
    </WalletGate>
  );
}

function OwnerQueueView({ state, onLoadMore }: { state: Extract<QueueState, { kind: "ready" }>; onLoadMore: (cursor: bigint) => void }) {
  return (
    <>
      <div className={styles.toolbar}><div><p className="kicker">Draft queue</p><strong>{state.items.length} draft{state.items.length === 1 ? "" : "s"} loaded</strong></div><span>State block {state.block.number.toString()}</span></div>
      {!state.items.length ? <div className={styles.empty}><h2>No drafts in this page</h2><p>The scan remains bounded. Continue when another cursor is available.</p></div> : (
        <ul className={styles.queue}>
          {state.items.map((snapshot) => {
            const status = admissionLabel(snapshot);
            return <li className={styles.card} key={snapshot.id.toString()}><div className={styles.cardTop}><div><p className="kicker">Raffle #{snapshot.id.toString()}</p><h2>{snapshot.raffle.title}</h2></div><span className={styles.status} data-status={snapshot.admission.status}>{status.label}</span></div><p>{status.detail}</p><dl className={styles.facts}><div><dt>Seller</dt><dd>{shortAddress(snapshot.raffle.seller)}</dd></div><div><dt>NFT</dt><dd>{shortAddress(snapshot.raffle.nft)} / token {snapshot.raffle.tokenId.toString()}</dd></div><div><dt>Revision</dt><dd>{snapshot.admission.record.reviewRevision.toString()}</dd></div><div><dt>Sales end</dt><dd>{formatDate(snapshot.raffle.salesEnd)} UTC</dd></div></dl><Link className="btn btn-dark" href={`/review/${snapshot.id.toString()}`}>Review exact draft</Link></li>;
          })}
        </ul>
      )}
      {state.nextCursor !== null ? <button className="btn" type="button" disabled={state.loadingMore} onClick={() => onLoadMore(state.nextCursor ?? 0n)}>{state.loadingMore ? "Scanning next 24 IDs…" : "Scan next 24 raffle IDs"}</button> : <p className="muted">The bounded queue scan is complete.</p>}
    </>
  );
}

function OwnerReviewDetail({ browser, rawId }: { browser: BrowserService; rawId: string }) {
  const wallet = useWalletSnapshot(browser.wallet);
  const id = idFromRoute(rawId);
  const [state, setState] = useState<DetailState>(() => id === null ? { kind: "invalid", message: "This raffle ID is invalid." } : { kind: "loading" });
  const request = useRef(0);
  const loadScope = useRef({ browser, id, mounted: false });
  if (loadScope.current.browser !== browser || loadScope.current.id !== id) {
    loadScope.current = { browser, id, mounted: false };
    request.current += 1;
  }

  async function load(showLoading = true) {
    const scope = loadScope.current;
    if (!scope.mounted || scope.browser !== browser || scope.id !== id || id === null) return;
    if (browser.kind !== "configured") {
      setState({ kind: "error", message: browser.reason });
      return;
    }
    const version = ++request.current;
    if (showLoading) setState({ kind: "loading" });
    try {
      const deployment = await browser.service.attest();
      if (loadScope.current !== scope || !scope.mounted || version !== request.current) return;
      if (deployment.kind !== "verified") throw new Error(deployment.reason);
      const review = await browser.service.readAdmission({ id });
      if (loadScope.current === scope && scope.mounted && version === request.current) setState({ kind: "ready", review });
    } catch (error) {
      if (loadScope.current === scope && scope.mounted && version === request.current) setState({ kind: "error", message: error instanceof Error ? error.message : "The review record could not be loaded." });
    }
  }

  useEffect(() => {
    const scope = loadScope.current;
    scope.mounted = true;
    if (id === null) setState({ kind: "invalid", message: "This raffle ID is invalid." });
    else void load();
    return () => {
      scope.mounted = false;
      request.current += 1;
    };
    // Route and deployment changes invalidate every displayed review field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, id]);

  if (state.kind === "invalid") return <section className="section stack missing-state"><h1 className="page-title">Invalid review route.</h1><p>{state.message}</p><Link className="btn btn-dark" href="/review">Back to review queue</Link></section>;
  if (state.kind === "loading") return <section className="section state-section"><div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading exact review data</strong><p>Pinning draft, policy, custody and code facts to one block.</p></div></div></section>;
  if (state.kind === "error") return <section className="section stack missing-state"><h1 className="page-title">Owner review unavailable.</h1><p className="notice error" role="alert">{state.message}</p><button className="btn btn-dark" type="button" onClick={() => void load()}>Retry review</button></section>;

  if (browser.kind !== "configured") return null;
  if (wallet.kind !== "connected" || wallet.chainId !== browser.service.manifest.chainId || !sameAddress(wallet.account, state.review.snapshot.owner)) {
    return <SafeConnectionHelp service={browser.service} wallet={browser.wallet} snapshot={wallet} owner={state.review.snapshot.owner} />;
  }
  if (state.review.snapshot.raffle.phase !== 0 || state.review.snapshot.admission.reviewHash === null) return <section className="section stack missing-state"><h1 className="page-title">This raffle is no longer a draft.</h1><p>Owner approval and revocation are available only while the raffle remains in Draft.</p><Link className="btn btn-dark" href={`/piece/${state.review.snapshot.id.toString()}`}>View public raffle</Link></section>;

  return <OwnerReviewRecord service={browser.service} wallet={browser.wallet} review={state.review} onRefresh={() => load(false)} />;
}

function AddressFact({ chainId, value, children }: { chainId: number; value: Address; children?: React.ReactNode }) {
  const href = explorerAddress(chainId, value);
  return href ? <a href={href} target="_blank" rel="noreferrer">{children ?? value} <span aria-hidden="true">↗</span></a> : <>{children ?? value}</>;
}

function OwnerReviewRecord({ service, wallet, review, onRefresh }: { service: RaffleService; wallet: WalletSessionPort; review: AdmissionReview; onRefresh: () => Promise<void> }) {
  const { snapshot, policy } = review;
  const admission = snapshot.admission;
  if (admission.reviewHash === null) return null;
  const status = admissionLabel(snapshot);
  const nftHref = explorerToken(service.manifest.chainId, snapshot.raffle.nft, snapshot.raffle.tokenId);
  return (
    <section className={`section page-frame ${styles.shell}`}>
      <div className={styles.toolbar}><Link className="detail-back" href="/review"><span aria-hidden="true">←</span> Back to review queue</Link><button className="text-link" type="button" onClick={() => void onRefresh()}>Refresh exact state</button></div>
      <div className={styles.heading}><div><p className="kicker">Raffle #{snapshot.id.toString()} / revision {admission.record.reviewRevision.toString()}</p><h1 className="page-title">{snapshot.raffle.title}</h1></div><span className={styles.status} data-status={admission.status}>{status.label}</span></div>
      <p className="notice warning">LABx review records a human decision about this exact draft. It does not prove NFT authenticity, reserve VRF subscription funds or guarantee future transferability.</p>

      <section className={styles.identity} aria-labelledby="review-identity-title">
        <div><p className="kicker">Canonical identity</p><h2 id="review-identity-title">Network, contract and prize</h2></div>
        <dl className={styles.facts}>
          <div><dt>Chain</dt><dd>{chainName(service.manifest.chainId)} ({service.manifest.chainId})</dd></div>
          <div><dt>Raffle contract</dt><dd><AddressFact chainId={service.manifest.chainId} value={service.manifest.address} /></dd></div>
          <div><dt>Raffle ID</dt><dd>{snapshot.id.toString()}</dd></div>
          <div><dt>Seller</dt><dd><AddressFact chainId={service.manifest.chainId} value={snapshot.raffle.seller} /></dd></div>
          <div><dt>Collection contract</dt><dd><AddressFact chainId={service.manifest.chainId} value={snapshot.raffle.nft} /></dd></div>
          <div><dt>Token</dt><dd>{nftHref ? <a href={nftHref} target="_blank" rel="noreferrer">#{snapshot.raffle.tokenId.toString()} on explorer <span aria-hidden="true">↗</span></a> : `#${snapshot.raffle.tokenId.toString()} (local chain has no public explorer)`}</dd></div>
          <div><dt>Current custody</dt><dd>{review.custody.kind === "unknown" ? "Unknown. The NFT owner read failed." : <>{review.custody.kind === "held" ? "Held by the raffle contract" : "Not held by the raffle contract"} · <AddressFact chainId={service.manifest.chainId} value={review.custody.owner}>{review.custody.owner}</AddressFact></>}</dd></div>
          <div><dt>NFT runtime code hash</dt><dd className="hash">{review.nftCodeHash ?? "Unavailable or no runtime code"}</dd></div>
          <div><dt>Sales end</dt><dd>{formatDate(snapshot.raffle.salesEnd)} UTC</dd></div>
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="review-economics-title">
        <div><p className="kicker">Exact economics</p><h2 id="review-economics-title">Membership packs</h2></div>
        <ul className={styles.packs}>{snapshot.packs.map((pack, index) => <li key={`${index}-${pack.name}`}><strong>{pack.name}</strong><p>{formatUsdc(pack.priceUsdc)} USDC principal per membership</p><p>{pack.bonusEntries} bonus entries · maximum {pack.maxSupply.toLocaleString("en-US")} · {pack.active ? "active" : "inactive"}</p></li>)}</ul>
        <p>Each purchase call pays the greater of {formatUsdc(policy.minBuyerFeeUsdc)} USDC and {formatBps(policy.buyerFeeBps)} of the quantity-adjusted principal. The processing fee is retained after a successful purchase, including cancellation.</p>
      </section>

      <details className={styles.panel}>
        <summary>Review commitment, policy and epoch details</summary>
        <dl className={styles.facts}>
          <div><dt>Draft digest</dt><dd className="hash">{admission.reviewHash}</dd></div>
          <div><dt>Approved digest</dt><dd className="hash">{admission.record.approvedReviewHash === zeroHash ? "None" : admission.record.approvedReviewHash}</dd></div>
          <div><dt>Approved by</dt><dd>{sameAddress(admission.record.approvedBy, zeroAddress) ? "No recorded approver" : <AddressFact chainId={service.manifest.chainId} value={admission.record.approvedBy} />}</dd></div>
          <div><dt>Review revision</dt><dd>{admission.record.reviewRevision.toString()}</dd></div>
          <div><dt>Owner generation</dt><dd>{review.ownerGeneration.toString()}</dd></div>
          <div><dt>Opening policy generation</dt><dd>{review.openingPolicyGeneration.toString()}</dd></div>
          <div><dt>Opening policy hash</dt><dd className="hash">{review.policyHash ?? "Frozen after opening"}</dd></div>
          <div><dt>Reserve nonce hash</dt><dd className="hash">{snapshot.raffle.reserveNonce}</dd></div>
          <div><dt>Reserve commitment</dt><dd className="hash">{snapshot.raffle.reserveCommit}</dd></div>
          <div><dt>Terms hash</dt><dd className="hash">{policy.termsHash}</dd></div>
          <div><dt>Treasury</dt><dd><AddressFact chainId={service.manifest.chainId} value={policy.treasury} /></dd></div>
          <div><dt>VRF coordinator</dt><dd><AddressFact chainId={service.manifest.chainId} value={policy.coordinator} /></dd></div>
          <div><dt>VRF key hash</dt><dd className="hash">{policy.keyHash}</dd></div>
          <div><dt>Subscription</dt><dd>{policy.subscriptionId.toString()}</dd></div>
          <div><dt>Billing mode</dt><dd>{policy.nativePayment ? "Native token" : "LINK"}</dd></div>
          <div><dt>Callback gas</dt><dd>{policy.callbackGasLimit.toLocaleString("en-US")}</dd></div>
          <div><dt>Confirmations</dt><dd>{policy.requestConfirmations.toString()}</dd></div>
          <div><dt>Buyer processing fee</dt><dd>max({formatUsdc(policy.minBuyerFeeUsdc)} USDC, {formatBps(policy.buyerFeeBps)} of purchase principal)</dd></div>
          <div><dt>Seller commission</dt><dd>{formatBps(policy.sellerFeeBps)} at settlement only</dd></div>
          <div><dt>Review block</dt><dd>{snapshot.block.number.toString()} / <span className="hash">{snapshot.block.hash}</span></dd></div>
        </dl>
      </details>

      <OwnerExecutionFlow service={service} wallet={wallet} review={review} onRecorded={onRefresh} />
    </section>
  );
}

function intentStorageKey(service: RaffleService, owner: Address, id: bigint) {
  return `labx:owner-review:v1:${service.manifest.chainId}:${service.manifest.address.toLowerCase()}:${service.manifest.runtimeCodeHash}:${owner.toLowerCase()}:${id.toString()}`;
}

function isRevokeConfirmationRecovery(intent: OwnerExecutionIntent, review: AdmissionReview) {
  const admission = review.snapshot.admission;
  return intent.action.kind === "revokeRaffleApproval"
    && intent.action.id === review.snapshot.id
    && sameAddress(intent.from, review.snapshot.owner)
    && intent.ownerGeneration === review.ownerGeneration
    && intent.openingPolicyGeneration === review.openingPolicyGeneration
    && admission.status === "pending"
    && admission.record.approvedReviewHash === zeroHash
    && admission.record.reviewRevision === intent.reviewRevision + 1n;
}

function downloadSafeFile(intent: OwnerExecutionIntent, service: RaffleService) {
  const file = safeTransactionFile({ intent, manifest: service.manifest, createdAt: Date.now() });
  const url = URL.createObjectURL(new Blob([file.content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sameDiscoveryState(left: DiscoveryState, right: DiscoveryState) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "idle" || right.kind === "idle") return true;
  if (left.kind === "error" || right.kind === "error") return left.kind === "error" && right.kind === "error" && left.message === right.message;
  return left.fromBlock === right.fromBlock && left.toBlock === right.toBlock && left.head === right.head && left.caughtUp === right.caughtUp && left.reset === right.reset;
}

function DiscoveryStatus({ state, busy, onRetry }: { state: DiscoveryState; busy: boolean; onRetry: () => void }) {
  if (state.kind === "idle" && !busy) return null;
  return <div className="notice warning stack" aria-busy={busy}>
    {state.kind === "idle" ? <span aria-hidden="true">Checking approval…</span> : null}
    {state.kind === "error" ? <span role="status" aria-live="polite">{state.message}</span> : null}
    {state.kind === "range" && state.caughtUp ? <span role="status" aria-live="polite">No completed approval found yet. LABx will check again while this page is visible.{state.reset ? " The check restarted after the chain changed." : ""}</span> : null}
    {state.kind === "range" && !state.caughtUp ? <span role="status" aria-live="polite">Checked approval events through block {state.toBlock.toString()} of {state.head.toString()}. LABx will continue while this page is visible.{state.reset ? " The check restarted after the chain changed." : ""}</span> : null}
    {state.kind !== "idle" ? <span className={`${styles.checkingLine} muted`} data-visible={busy ? "true" : "false"} aria-hidden="true">Checking again…</span> : null}
    {state.kind === "error" ? <button className="text-link" type="button" disabled={busy} onClick={onRetry}>Retry automatic check</button> : null}
  </div>;
}

function OwnerExecutionFlow({ service, wallet, review, onRecorded }: { service: RaffleService; wallet: WalletSessionPort; review: AdmissionReview; onRecorded: () => Promise<void> }) {
  const currentWallet = useWalletSnapshot(wallet);
  const identity = useRef({ service, wallet, epoch: 0 });
  if (identity.current.service !== service || identity.current.wallet !== wallet) {
    identity.current = { service, wallet, epoch: identity.current.epoch + 1 };
  }
  const walletKey = currentWallet.kind === "connected"
    ? `${currentWallet.revision}:${currentWallet.chainId}:${currentWallet.account.toLowerCase()}`
    : `${currentWallet.revision}:disconnected`;
  const flowKey = [identity.current.epoch, walletKey, service.manifest.chainId, service.manifest.address.toLowerCase(), service.manifest.runtimeCodeHash, review.snapshot.id.toString(), review.snapshot.owner.toLowerCase()].join(":");
  return <OwnerExecutionFlowScope key={flowKey} service={service} wallet={wallet} currentWallet={currentWallet} review={review} onRecorded={onRecorded} />;
}

function OwnerExecutionFlowScope({ service, wallet, currentWallet, review, onRecorded }: {
  service: RaffleService;
  wallet: WalletSessionPort;
  currentWallet: WalletSnapshot;
  review: AdmissionReview;
  onRecorded: () => Promise<void>;
}) {
  const trustReason = useActionTrust(service, review.snapshot);
  const admission = review.snapshot.admission;
  const [selection, setSelected] = useState<OwnerAction["kind"] | null>(null);
  const selected = selection ?? (admission.status !== "approved" ? "approveRaffle" : null);
  const [attestations, setAttestations] = useState<ReviewAttestationState>(EMPTY_REVIEW_ATTESTATIONS);
  const [hashInput, setHashInput] = useState("");
  const [visiblePayload, setVisiblePayload] = useState<string | null>(null);
  const [state, setState] = useState<FlowState>({ kind: "idle" });
  const [discovery, setDiscovery] = useState<DiscoveryState>({ kind: "idle" });
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const reviewHash = admission.reviewHash;
  const owner = review.snapshot.owner;
  const storageKey = intentStorageKey(service, owner, review.snapshot.id);
  const exposureKey = `${storageKey}:manual-exposure`;
  const channelKey = `${storageKey}:handoff`;
  const lifetime = useRef({ mounted: false, generation: 0, nextOperation: 0, exclusiveOperation: null as number | null, reviewHash });
  const discoveryCursor = useRef<OwnerExecutionDiscoveryCursor | undefined>(undefined);
  const previousReviewHash = useRef(reviewHash);
  const latestReview = useRef(review);
  latestReview.current = review;
  if (lifetime.current.reviewHash !== reviewHash) {
    lifetime.current.reviewHash = reviewHash;
    lifetime.current.nextOperation += 1;
    lifetime.current.exclusiveOperation = null;
  }
  const allAttested = reviewHash !== null && attestations.attestedDigest === reviewHash && attestations.canonicalProvenance && attestations.transferRestrictions && attestations.drawFunding;
  const draftReady = reviewHash !== null && review.snapshot.raffle.escrowed && review.custody.kind === "held" && review.nftCodeHash !== null && review.snapshot.block.timestamp < review.snapshot.raffle.salesEnd;
  const canApprove = trustReason === null && draftReady;
  const canRevoke = reviewHash !== null && admission.record.approvedReviewHash !== zeroHash;

  const discoveryOperation = useRef<number | null>(null);
  type Operation = { id: number; generation: number; reviewHash: Hex | null; exclusive: boolean };
  function beginOperation(exclusive: boolean): Operation | null {
    const current = lifetime.current;
    if (!current.mounted || current.exclusiveOperation !== null || previousReviewHash.current !== current.reviewHash) return null;
    const operation = { id: ++current.nextOperation, generation: current.generation, reviewHash: current.reviewHash, exclusive };
    if (exclusive) current.exclusiveOperation = operation.id;
    return operation;
  }
  function beginUserOperation() {
    if (discoveryOperation.current !== null && lifetime.current.exclusiveOperation === discoveryOperation.current) {
      invalidateOperations();
      discoveryOperation.current = null;
      setDiscoveryBusy(false);
    }
    return beginOperation(true);
  }
  function isCurrent(operation: Operation) {
    const current = lifetime.current;
    return current.mounted && current.generation === operation.generation && current.nextOperation === operation.id && current.reviewHash === operation.reviewHash;
  }
  function finishOperation(operation: Operation) {
    if (isCurrent(operation) && operation.exclusive) lifetime.current.exclusiveOperation = null;
  }
  function invalidateOperations() {
    lifetime.current.nextOperation += 1;
    lifetime.current.exclusiveOperation = null;
  }
  function clearAttestations() {
    setAttestations(EMPTY_REVIEW_ATTESTATIONS);
  }
  function setDiscoveryOutcome(next: DiscoveryState) {
    setDiscovery(current => sameDiscoveryState(current, next) ? current : next);
  }

  useEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
      lifetime.current.generation += 1;
      invalidateOperations();
    };
  }, []);

  useEffect(() => {
    setSelected(null);
    clearAttestations();
    setHashInput("");
    setState({ kind: "idle" });
    setDiscovery({ kind: "idle" });
    setDiscoveryBusy(false);
    discoveryCursor.current = undefined;
    if (currentWallet.kind !== "connected" || currentWallet.chainId !== service.manifest.chainId || !sameAddress(currentWallet.account, owner)) return;
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return;
    try {
      const intent = parseOwnerExecutionIntent(raw, service.manifest, owner);
      if (intent.action.id !== review.snapshot.id) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      if (intent.action.expectedReviewHash !== reviewHash && isRevokeConfirmationRecovery(intent, review)) {
        setState({ kind: "recovery", intent });
        return;
      }
      setSelected(intent.action.kind);
      setState(handoffState(intent));
    } catch {
      window.localStorage.removeItem(storageKey);
    }
    // The persisted value is parsed against the current digest at load time. A later
    // digest change is handled below without erasing an observed execution result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWallet.revision, owner, review.snapshot.id, service, storageKey]);

  useEffect(() => {
    if (previousReviewHash.current === reviewHash) return;
    previousReviewHash.current = reviewHash;
    clearAttestations();
    setDiscoveryBusy(false);
    if (state.kind === "executed") return;
    const intent = (state.kind === "exported" || state.kind === "requested") || state.kind === "recovery" || state.kind === "confirming" || state.kind === "pending" ? state.intent : null;
    if (intent !== null && isRevokeConfirmationRecovery(intent, review)) {
      invalidateOperations();
      setSelected(null);
      setHashInput("");
      setDiscovery({ kind: "idle" });
      setState({ kind: "recovery", intent });
      return;
    }
    if (intent !== null && intent.action.expectedReviewHash !== reviewHash) {
      invalidateOperations();
      setState(handoffState(intent));
      return;
    }
    invalidateOperations();
    setSelected(null);
    setHashInput("");
    setDiscovery({ kind: "idle" });
    discoveryCursor.current = undefined;
    setState({ kind: "idle" });
    // State is inspected only when the authoritative digest changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewHash, storageKey]);

  const discoverableIntent = (state.kind === "exported" || state.kind === "requested") || state.kind === "recovery" || state.kind === "confirming" || state.kind === "pending" ? state.intent : null;
  useEffect(() => {
    if (discoverableIntent === null) return;
    const check = () => {
      if (document.visibilityState === "visible") void discover(discoverableIntent);
    };
    check();
    const interval = window.setInterval(check, 15_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
    };
    // discover is scoped by the operation-generation guard and the stable intent object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoverableIntent, service]);

  async function discover(intent: OwnerExecutionIntent) {
    const operation = beginOperation(true);
    if (operation === null) return;
    discoveryOperation.current = operation.id;
    setDiscoveryBusy(true);
    try {
      const page = await service.discoverOwnerExecutions({ intent, cursor: discoveryCursor.current, timeoutMs: 10_000 });
      if (!isCurrent(operation)) return;
      const rangeOutcome: DiscoveryState = { kind: "range", fromBlock: page.scanned.fromBlock, toBlock: page.scanned.toBlock, head: page.head.number, caughtUp: page.caughtUp, reset: page.reset };
      let pendingHash: Hex | null = null;
      let candidateError: string | null = null;
      for (const candidate of page.candidates) {
        try {
          const confirmation = await service.confirmOwnerExecution({ intent, hash: candidate, timeoutMs: 2_000 });
          if (!isCurrent(operation)) return;
          if (confirmation.kind === "pending") {
            pendingHash ??= confirmation.hash;
            continue;
          }
          window.localStorage.removeItem(storageKey);
          setHashInput(confirmation.hash);
          discoveryOperation.current = null;
          setState({ kind: "executed", confirmation });
          await onRecorded();
          return;
        } catch (error) {
          candidateError = error instanceof Error ? error.message : "A discovered execution could not be verified.";
        }
      }
      if (!isCurrent(operation)) return;
      if (pendingHash !== null) {
        setDiscoveryOutcome(rangeOutcome);
        setHashInput(pendingHash);
        const confirmationOnly = isRevokeConfirmationRecovery(intent, latestReview.current);
        setState(current => current.kind === "pending" && current.intent === intent && current.hash === pendingHash && current.confirmationOnly === confirmationOnly
          ? current
          : { kind: "pending", intent, hash: pendingHash, confirmationOnly });
        return;
      }
      if (candidateError !== null) {
        setDiscoveryOutcome({ kind: "error", message: `${candidateError} LABx will retry while this page is visible.` });
        return;
      }
      setDiscoveryOutcome(rangeOutcome);
      discoveryCursor.current = page.cursor;
    } catch (error) {
      if (isCurrent(operation)) setDiscoveryOutcome({ kind: "error", message: error instanceof Error ? error.message : "Automatic execution discovery is unavailable. Retry when the RPC is available." });
    } finally {
      if (isCurrent(operation)) setDiscoveryBusy(false);
      if (discoveryOperation.current === operation.id) discoveryOperation.current = null;
      finishOperation(operation);
    }
  }

  async function prepare(dispatch = false) {
    if (selected === null || reviewHash === null) return;
    const action: OwnerAction = selected === "approveRaffle"
      ? { kind: "approveRaffle", id: review.snapshot.id, expectedReviewHash: reviewHash, attestations: { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } }
      : { kind: "revokeRaffleApproval", id: review.snapshot.id, expectedReviewHash: reviewHash };
    if (action.kind === "approveRaffle" && !(dispatch ? canApprove : allAttested)) return;
    if (dispatch && action.kind === "approveRaffle") setAttestations({ attestedDigest: reviewHash, canonicalProvenance: true, transferRestrictions: true, drawFunding: true });
    const operation = beginOperation(true);
    if (operation === null) return;
    setSelected(action.kind);
    setState({ kind: "preparing", actionKind: selected });
    let exported: OwnerExecutionIntent | null = null;
    const scopeCurrent = () => lifetime.current.mounted && lifetime.current.generation === operation.generation && lifetime.current.reviewHash === operation.reviewHash;
    try {
      const prepared = await service.prepare({ action, wallet });
      if (!isCurrent(operation)) return;
      const persist = async (intent: OwnerExecutionIntent) => {
        if (!isCurrent(operation)) throw new Error("This review is no longer active.");
        if (intent.action.kind !== action.kind || intent.action.id !== review.snapshot.id || intent.action.expectedReviewHash !== reviewHash) throw new Error("Owner execution changed. Review again.");
        const raw = serializeOwnerExecutionIntent(intent);
        if (!navigator.locks) throw new Error("Safe recovery requires a browser with secure Web Locks.");
        await navigator.locks.request(storageKey, () => {
          if (!isCurrent(operation)) throw new Error("This review is no longer active.");
          if (dispatch && window.localStorage.getItem(storageKey) !== null) throw new Error("A saved owner execution is still pending. Wait for canonical recovery before another request.");
          persistHandoff(intent, dispatch ? "wallet-request" : "file");
          exported = intent;
          window.localStorage.setItem(storageKey, raw);
          if (window.localStorage.getItem(storageKey) !== raw) throw new Error("Owner execution recovery could not be saved.");
          if (!dispatch) recordExposureLocked(intent);
        });
        exported = intent;
        if (dispatch && scopeCurrent()) {
          discoveryCursor.current = undefined;
          setDiscovery({ kind: "idle" });
          setDiscoveryBusy(false);
          setState(handoffState(intent));
          finishOperation(operation);
        }
      };
      if (dispatch) {
        await service.requestOwnerExecution({ prepared, wallet, beforeRequest: persist, assertIntent: () => { if (!scopeCurrent()) throw new Error("This review is no longer active."); } });
      } else {
        const intent = await service.exportOwnerExecution({ prepared, wallet });
        await persist(intent);
        if (!isCurrent(operation)) return;
        downloadSafeFile(intent, service);
      }
      if (!isCurrent(operation)) return;
      discoveryCursor.current = undefined;
      setDiscovery({ kind: "idle" });
      setDiscoveryBusy(false);
      if (exported) setState(handoffState(exported));
    } catch (error) {
      if (exported && dispatch && (isWalletRequestRejected(error) || error instanceof SubmissionNotDispatchedError)) {
        const rejected = exported;
        let retired = false;
        try {
          if (!navigator.locks) throw new Error("Safe recovery requires secure Web Locks.");
          await navigator.locks.request(storageKey, () => {
            const raw = window.localStorage.getItem(storageKey);
            if (raw === null) { retired = true; return; }
            if (raw !== serializeOwnerExecutionIntent(rejected)) return;
            const exposure = window.localStorage.getItem(exposureKey);
            if (exposure !== null && canonicalIntent(exposure) === canonicalIntent(serializeOwnerExecutionIntent(rejected))) return;
            window.localStorage.removeItem(storageKey);
            if (window.localStorage.getItem(storageKey) !== null) throw new Error("Cancelled owner review could not be retired.");
            retired = true;
          });
        } catch { /* Unknown persistence or exposure must retain canonical observation. */ }
        if (retired && scopeCurrent()) {
          invalidateOperations();
          exported = null;
          setDiscoveryBusy(false);
          setState(current => current.kind === "executed" ? current : { kind: "error", message: isWalletRequestRejected(error) ? "The wallet request was cancelled. Review and click Approve to try again." : "The Safe request was not sent. Check browser storage, then review and click Approve again." });
        } else if (scopeCurrent()) {
          setState(current => current.kind === "executed" ? current : handoffState(rejected, false, "The wallet request stopped. Saved recovery is still being watched; check Advanced recovery before another request."));
        }
      } else if (isCurrent(operation)) {
        if (exported) {
          setState(handoffState(exported));
          setDiscovery({ kind: "error", message: "The wallet response is uncertain. Watching for canonical execution. Do not send another approval." });
        } else {
          exported = null;
          setState({ kind: "error", message: isWalletRequestRejected(error) ? "The wallet request was cancelled. Review and click Approve to try again." : error instanceof Error ? error.message : "The owner execution could not be prepared." });
        }
      }
    } finally {
      finishOperation(operation);
    }
    if (exported !== null && scopeCurrent() && window.localStorage.getItem(storageKey) !== null) void discover(exported);
  }

  function persistHandoff(intent: OwnerExecutionIntent, channel: "wallet-request" | "file") {
    const raw = JSON.stringify({ intent: canonicalIntent(serializeOwnerExecutionIntent(intent)), channel });
    window.localStorage.setItem(channelKey, raw);
    if (window.localStorage.getItem(channelKey) !== raw) throw new Error("Safe handoff recovery could not be saved.");
  }
  function handoffState(intent: OwnerExecutionIntent, copied = false, error?: string): Extract<FlowState, { kind: "exported" | "requested" }> {
    let kind: "exported" | "requested" = "exported";
    try {
      const raw = window.localStorage.getItem(channelKey);
      const value: unknown = raw === null ? null : JSON.parse(raw);
      if (value && typeof value === "object" && "intent" in value && value.intent === canonicalIntent(serializeOwnerExecutionIntent(intent)) && "channel" in value && value.channel === "wallet-request") kind = "requested";
    } catch { /* Unknown handoffs use manual import instructions, never imply dispatch. */ }
    return { kind, intent, copied, ...(error ? { error } : {}) };
  }
  function canonicalIntent(raw: string) {
    return serializeOwnerExecutionIntent(parseOwnerExecutionIntent(raw, service.manifest, owner));
  }
  function recordExposureLocked(intent: OwnerExecutionIntent) {
    const marker = canonicalIntent(serializeOwnerExecutionIntent(intent));
    window.localStorage.setItem(exposureKey, marker);
    if (window.localStorage.getItem(exposureKey) !== marker) throw new Error("Manual Safe recovery could not be saved. Try again before copying or downloading.");
    return marker;
  }
  async function recordExposure(intent: OwnerExecutionIntent, assertCurrent: () => void) {
    if (!navigator.locks) throw new Error("Safe recovery requires a browser with secure Web Locks.");
    return navigator.locks.request(storageKey, () => {
      assertCurrent();
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null || canonicalIntent(raw) !== canonicalIntent(serializeOwnerExecutionIntent(intent))) throw new Error("The saved owner review changed. Reload before copying this call.");
      return recordExposureLocked(intent);
    });
  }
  async function showPayload(intent: OwnerExecutionIntent) {
    const generation = lifetime.current.generation, hash = lifetime.current.reviewHash;
    const current = () => lifetime.current.mounted && lifetime.current.generation === generation && lifetime.current.reviewHash === hash;
    try {
      const marker = await recordExposure(intent, () => { if (!current()) throw new Error("This review is no longer active."); });
      if (current()) setVisiblePayload(marker);
    } catch (error) {
      if (current()) setState(state => (state.kind === "exported" || state.kind === "requested") ? { ...state, error: error instanceof Error ? error.message : "Manual Safe recovery could not be saved." } : state);
    }
  }

  async function copyPayload(intent: OwnerExecutionIntent) {
    const operation = beginOperation(false);
    if (operation === null) return;
    try {
      await recordExposure(intent, () => { if (!isCurrent(operation)) throw new Error("This review is no longer active."); });
      if (!isCurrent(operation)) return;
      await navigator.clipboard.writeText(formatOwnerPayload(intent));
      if (isCurrent(operation)) setState(handoffState(intent, true));
    } catch {
      if (isCurrent(operation)) setState(handoffState(intent, false, "The call could not be copied safely. Retry Advanced recovery."));
    }
  }

  async function confirm(intent: OwnerExecutionIntent, confirmationOnly = false) {
    if (!isHex(hashInput, { strict: true }) || hashInput.length !== 66) return;
    const operation = beginUserOperation();
    if (operation === null) return;
    const executionHash: Hex = hashInput;
    setState({ kind: "confirming", intent, hash: executionHash, confirmationOnly });
    try {
      const confirmation = await service.confirmOwnerExecution({ intent, hash: executionHash });
      if (!isCurrent(operation)) return;
      if (confirmation.kind === "pending") setState({ kind: "pending", intent, hash: confirmation.hash, confirmationOnly });
      else {
        window.localStorage.removeItem(storageKey);
        discoveryCursor.current = undefined;
        setDiscovery({ kind: "idle" });
        setDiscoveryBusy(false);
        setState({ kind: "executed", confirmation });
        if (!isCurrent(operation)) return;
        await onRecorded();
      }
    } catch (error) {
      if (isCurrent(operation)) {
        const message = error instanceof Error ? error.message : "The execution could not be reconciled.";
        setState(confirmationOnly ? { kind: "recovery", intent, message } : { kind: "error", message });
      }
    } finally {
      finishOperation(operation);
    }
  }

  function discardExport() {
    invalidateOperations();
    window.localStorage.removeItem(storageKey);
    discoveryCursor.current = undefined;
    setDiscovery({ kind: "idle" });
    setDiscoveryBusy(false);
    setSelected(null);
    clearAttestations();
    setState({ kind: "idle" });
    setHashInput("");
  }

  async function reviewAndDownload(original: OwnerExecutionIntent) {
    if (reviewHash === null || (original.action.kind === "approveRaffle" ? !canApprove : !canRevoke)) return;
    const operation = beginUserOperation();
    if (operation === null) return;
    let observed = original;
    setState({ kind: "preparing", actionKind: original.action.kind });
    try {
      const originalRaw = window.localStorage.getItem(storageKey);
      const displayed = parseOwnerExecutionIntent(serializeOwnerExecutionIntent(original), service.manifest, owner);
      if (originalRaw === null || serializeOwnerExecutionIntent(parseOwnerExecutionIntent(originalRaw, service.manifest, owner)) !== serializeOwnerExecutionIntent(displayed)) throw new Error("The saved owner review changed in another tab. Reload to recover it.");
      const action: OwnerAction = original.action.kind === "approveRaffle"
        ? { kind: "approveRaffle", id: review.snapshot.id, expectedReviewHash: reviewHash, attestations: { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } }
        : { kind: "revokeRaffleApproval", id: review.snapshot.id, expectedReviewHash: reviewHash };
      const prepared = await service.prepare({ action, wallet });
      if (!isCurrent(operation)) return;
      const fresh = await service.exportOwnerExecution({ prepared, wallet });
      if (!isCurrent(operation)) return;
      if (fresh.action.kind !== action.kind || fresh.action.id !== action.id || fresh.action.expectedReviewHash !== reviewHash) throw new Error("The owner review changed. Refresh and review again.");
      if (!navigator.locks) throw new Error("Safe recovery requires a browser with secure Web Locks.");
      await navigator.locks.request(storageKey, () => {
        if (!isCurrent(operation)) throw new Error("This review is no longer active.");
        if (window.localStorage.getItem(storageKey) !== originalRaw) throw new Error("The saved owner review changed in another tab. Reload to recover it.");
        if (fresh.action.expectedReviewHash === original.action.expectedReviewHash) {
          if (fresh.data !== original.data || fresh.from !== original.from || fresh.to !== original.to || fresh.value !== original.value || fresh.ownerGeneration !== original.ownerGeneration || fresh.openingPolicyGeneration !== original.openingPolicyGeneration || fresh.reviewRevision !== original.reviewRevision) throw new Error("The exact owner call changed. Refresh and review again.");
          recordExposureLocked(original);
          return;
        }
        const archiveKey = `${storageKey}:history:${original.action.expectedReviewHash}:${original.reviewBlock.hash}`;
        window.localStorage.setItem(archiveKey, originalRaw);
        if (window.localStorage.getItem(archiveKey) !== originalRaw) throw new Error("The previous owner review could not be preserved.");
        const freshRaw = serializeOwnerExecutionIntent(fresh);
        persistHandoff(fresh, "file");
        recordExposureLocked(fresh);
        window.localStorage.setItem(storageKey, freshRaw);
        if (window.localStorage.getItem(storageKey) !== freshRaw) throw new Error("The current owner review could not be saved.");
        observed = fresh;
      });
      if (!isCurrent(operation)) return;
      downloadSafeFile(fresh, service);
      discoveryCursor.current = undefined;
      setDiscovery({ kind: "idle" });
      setState(handoffState(observed));
    } catch (error) {
      if (isCurrent(operation)) {
        setState(handoffState(observed, false, error instanceof Error ? error.message : "The current Safe call could not be downloaded. The saved execution is still being watched."));
      }
    } finally {
      finishOperation(operation);
    }
  }

  if (previousReviewHash.current !== reviewHash && state.kind !== "executed") {
    return <section className={styles.flow} role="status"><h2>Refreshing the owner review</h2><p>The draft digest changed. Reloading current owner actions.</p></section>;
  }

  if (state.kind === "recovery" || state.kind === "confirming" && state.confirmationOnly || state.kind === "pending" && state.confirmationOnly) {
    const intent = state.intent;
    return <section className={styles.flow} aria-labelledby="owner-recovery-title" aria-busy={discoveryBusy}><div><p className="kicker">Revocation receipt recovery</p><h2 id="owner-recovery-title">Confirm the recorded revocation</h2></div><p>The review revision advanced exactly once and the approval is now revoked. This stored call is historical and cannot be downloaded, copied or submitted again. LABx checks for the matching outer Ethereum transaction automatically. The field below remains available if you already have its hash.</p><DiscoveryStatus state={discovery} busy={discoveryBusy} onRetry={() => void discover(intent)} />{state.kind === "recovery" && state.message ? <p className="notice error" role="alert">{state.message}</p> : null}<label className={styles.hashInput}>Executed Ethereum transaction hash<input value={hashInput} spellCheck={false} autoCapitalize="none" autoCorrect="off" placeholder="0x…" onChange={(event) => setHashInput(event.target.value.trim())} /></label>{state.kind === "pending" ? <p className="notice warning" role="status">Execution is still pending or has not reached two canonical confirmations. A matching event has not been confirmed at that depth yet.</p> : null}<div className="btn-row"><button className="btn" type="button" disabled={state.kind === "confirming" || !isHex(hashInput, { strict: true }) || hashInput.length !== 66} onClick={() => void confirm(intent, true)}>{state.kind === "confirming" ? "Checking execution…" : state.kind === "pending" ? "Check execution again" : "Confirm recorded revocation"}</button><button className="text-link" type="button" disabled={state.kind === "confirming" || discoveryBusy} onClick={discardExport}>Discard recorded review</button></div></section>;
  }

  if (state.kind === "executed") {
    const copy = state.confirmation.state === "approved"
      ? "Approval execution was confirmed at the block below. Check the current draft status above before opening."
      : state.confirmation.state === "revoked"
        ? "Revocation execution was confirmed at the block below. Check the current draft status above for later changes."
        : "At confirmation, the reviewed owner, policy or draft state had changed. This execution was stale. Check the current draft status above.";
    return <section className={styles.flow} aria-live="polite"><p className="kicker">Canonical execution</p><h2>{state.confirmation.state === "stale" ? "Stale at confirmation" : state.confirmation.state === "approved" ? "Approval recorded" : "Approval revoked"}</h2><p>{copy}</p><dl className={styles.facts}><div><dt>Execution hash</dt><dd className="hash">{state.confirmation.hash}</dd></div><div><dt>Execution block</dt><dd>{state.confirmation.blockNumber.toString()}</dd></div></dl><button className="btn btn-dark" type="button" onClick={() => { invalidateOperations(); clearAttestations(); setSelected(null); setState({ kind: "idle" }); }}>Review current state</button></section>;
  }

  if (state.kind === "error") return <section className={styles.flow}><h2>Owner action unavailable</h2><p className="notice error" role="alert">{state.message}</p><button className="btn btn-dark" type="button" onClick={() => { invalidateOperations(); setState({ kind: "idle" }); }}>Return to owner actions</button></section>;

  if (selected === null) {
    return <section className={styles.flow} aria-labelledby="owner-action-title"><div><p className="kicker">Owner action</p><h2 id="owner-action-title">Choose the current draft action</h2></div><p>Only the current on-chain owner can export these zero-value calls. Connect the Safe account here and keep its signer wallet connected inside Safe.</p><div className="btn-row"><button className="btn" type="button" disabled={!canApprove || admission.status === "approved"} onClick={() => setSelected("approveRaffle")}>{admission.status === "approved" ? "Current draft approved" : "Review approval checklist"}</button><button className="btn btn-dark" type="button" disabled={!canRevoke} onClick={() => setSelected("revokeRaffleApproval")}>Prepare revocation</button></div>{trustReason ? <p className="notice warning" role="status">{trustReason} Revocation and execution confirmation remain available.</p> : null}{!draftReady && admission.status !== "approved" ? <p className="notice warning" role="status">Approval requires an escrowed NFT, confirmed current custody, runtime code and a future sales deadline.</p> : null}</section>;
  }

  if (state.kind === "preparing") return <section className={styles.flow} role="status"><h2>Refreshing the owner review</h2><p>Simulating the {state.actionKind === "approveRaffle" ? "approval" : "revocation"} against current chain state before your wallet request.</p><button className="btn" type="button" disabled>Waiting for Safe…</button></section>;

  if ((state.kind === "exported" || state.kind === "requested") || state.kind === "confirming" && !state.confirmationOnly || state.kind === "pending" && !state.confirmationOnly) {
    const intent = state.intent;
    const safeHref = safeQueue(intent.chainId, intent.from);
    const verb = intent.action.kind === "approveRaffle" ? "approval" : "revocation";
    return <section className={styles.flow} aria-labelledby="owner-execution-title" aria-busy={discoveryBusy}>
      <div><p className="kicker">Safe handoff</p><h2 id="owner-execution-title">Finish the {verb} in Safe</h2></div>
      {handoffState(intent).kind === "requested" ? <p>Complete the signatures and execution in your connected Safe. LABx watches automatically for the canonical transaction. A wallet acceptance or proposal alone is not approval.</p> : <p>This saved call has no recorded wallet request. Open your Safe, check existing proposals, then import the downloaded JSON file with Transaction Builder. Review, collect signatures and execute it. Downloading alone does not change the raffle. LABx watches for canonical execution.</p>}
      {(state.kind === "exported" || state.kind === "requested") && state.error ? <p className="notice error" role="alert">{state.error}</p> : null}
      <details><summary>Advanced recovery</summary>
      <p>Manual execution tools are available if your Safe connection cannot finish this request.</p>
      {intent.action.kind === "approveRaffle" ? <p>By clicking Review and download call, I confirm that I checked the canonical collection provenance against an independent source, reviewed transfer restrictions and upgradability, and reviewed the draw funding shown above. Approval does not reserve the VRF subscription balance.</p> : <p>Review and download the revocation for the current draft revision shown above.</p>}
      <p className="hash">Current review digest: {reviewHash}</p>
      <p>This downloads a freshly checked call without sending another wallet request. Check your existing Safe proposals before importing it.</p>
      <button className="text-link" type="button" disabled={discoveryBusy || state.kind === "confirming" || (intent.action.kind === "approveRaffle" ? !canApprove : !canRevoke)} onClick={() => void reviewAndDownload(intent)}>Review and download call</button>
      {safeHref ? <a href={safeHref} target="_blank" rel="noreferrer">Open Safe</a> : null}
      </details>
      <DiscoveryStatus state={discovery} busy={discoveryBusy} onRetry={() => void discover(intent)} />
      <details onToggle={event => { if (event.currentTarget.open) void showPayload(intent); }}><summary>Advanced call fields and technical details</summary><p>The manual file contains one zero-ETH call for this exact review. Downloading or copying it sends nothing. A Safe transaction proposal hash is not an executed Ethereum transaction hash.</p><p>Before every download LABx repeats the owner, draft, policy, custody, runtime, network and simulation checks.</p>{visiblePayload === canonicalIntent(serializeOwnerExecutionIntent(intent)) ? <><pre className={styles.payload}>{formatOwnerPayload(intent)}</pre><div className={styles.payloadActions}><button className="btn" type="button" disabled={state.kind === "confirming" || discoveryBusy} onClick={() => void copyPayload(intent)}>{(state.kind === "exported" || state.kind === "requested") && state.copied ? "Payload copied" : "Copy exact call fields"}</button></div><dl className={styles.facts}><div><dt>Function</dt><dd>{intent.action.kind}(uint256 id, bytes32 expectedReviewHash)</dd></div><div><dt>ID</dt><dd>{intent.action.id.toString()}</dd></div><div><dt>Expected review hash</dt><dd className="hash">{intent.action.expectedReviewHash}</dd></div><div><dt>Calldata</dt><dd className="hash">{intent.data}</dd></div><div><dt>Review block</dt><dd>{intent.reviewBlock.number.toString()}</dd></div></dl></> : <p>Checking saved recovery before showing the exact call fields.</p>}</details>
      <details><summary>Advanced: executed Ethereum transaction hash</summary><label className={styles.hashInput}>Executed Ethereum transaction hash<input value={hashInput} spellCheck={false} autoCapitalize="none" autoCorrect="off" placeholder="0x…" onChange={(event) => setHashInput(event.target.value.trim())} /></label>{state.kind === "pending" ? <p className="notice warning" role="status">Execution is still pending or has not reached two canonical confirmations. A matching event has not been confirmed at that depth yet.</p> : null}<button className="btn" type="button" disabled={state.kind === "confirming" || !isHex(hashInput, { strict: true }) || hashInput.length !== 66} onClick={() => void confirm(intent)}>{state.kind === "confirming" ? "Checking execution…" : state.kind === "pending" ? "Check execution again" : "Confirm canonical execution"}</button></details>

    </section>;
  }

  if (selected === "revokeRaffleApproval") {
    return <section className={`${styles.flow} ${styles.danger}`}><div><p className="kicker">Revocation review</p><h2>Revoke this draft approval</h2></div><p>Revocation applies only to raffle #{review.snapshot.id.toString()} while it remains in Draft. It advances the review revision so an older pending approval cannot restore the revoked decision.</p><div className="btn-row"><button className="btn btn-dark" type="button" onClick={() => void prepare()}>Download revocation file</button><button className="text-link" type="button" onClick={() => setSelected(null)}>Cancel</button></div></section>;
  }

  return <section className={styles.flow} aria-labelledby="approval-checklist-title"><div><p className="kicker">Human review</p><h2 id="approval-checklist-title">Approve this raffle</h2></div>{trustReason ? <p className="notice warning" role="status">{trustReason}</p> : null}{!draftReady ? <p className="notice warning" role="status">Approval requires an escrowed NFT, confirmed custody and a future deadline.</p> : null}<p>By clicking Approve, I confirm that I checked the canonical collection provenance against an independent source, reviewed transfer restrictions and upgradability, and reviewed the draw funding shown above. Approval does not reserve the VRF subscription balance.</p><p className="hash">Review digest: {reviewHash}</p><button className="btn" type="button" disabled={!canApprove} onClick={() => void prepare(true)}>Approve</button>{canRevoke ? <details><summary>Advanced owner actions</summary><button className="btn btn-dark" type="button" onClick={() => { clearAttestations(); setSelected("revokeRaffleApproval"); }}>Prepare revocation</button></details> : null}</section>;
}
