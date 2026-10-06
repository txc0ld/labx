"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { isHex, type Hex } from "viem";
import type { BrowserService } from "@/lib/chain/ports";
import { useWalletSnapshot } from "./WalletGate";

type ResumeState =
  | { kind: "idle" }
  | { kind: "checking"; hash: Hex }
  | { kind: "pending"; hash: Hex }
  | { kind: "confirmed"; hash: Hex; block: bigint }
  | { kind: "error"; message: string };

export function ResumeTransaction({ browser, onConfirmed, pendingOnly = false }: { browser: BrowserService; onConfirmed?: () => void | Promise<void>; pendingOnly?: boolean }) {
  const [hash, setHash] = useState("");
  const [state, setState] = useState<ResumeState>({ kind: "idle" });
  const inFlight = useRef(false);
  const generation = useRef(0);
  const wallet = useWalletSnapshot(browser.wallet);
  const [pending, setPending] = useState<{ hash: Hex | null; nonce: number } | null>(null);
  const inputId = useId();
  useEffect(() => {
    const version = ++generation.current;
    inFlight.current = false; setHash(""); setPending(null); setState({ kind: "idle" });
    if (browser.kind === "configured" && wallet.kind === "connected" && wallet.chainId === browser.service.manifest.chainId) {
      void browser.service.pending({ wallet: browser.wallet }).then(value => {
        if (version === generation.current) { setPending(value); setHash(value?.hash ?? ""); }
      }).catch(error => {
        if (version === generation.current) setState({ kind: "error", message: error instanceof Error ? error.message : "Pending wallet activity could not be read." });
      });
    }
    return () => { generation.current += 1; };
  }, [browser, wallet]);

  async function check(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    if (browser.kind !== "configured") {
      setState({ kind: "error", message: browser.reason });
      return;
    }
    if (!isHex(hash, { strict: true }) || hash.length !== 66) {
      setState({ kind: "error", message: "Enter a complete transaction hash." });
      return;
    }
    const version = generation.current;
    const transactionHash: Hex = hash;
    inFlight.current = true;
    setState({ kind: "checking", hash: transactionHash });
    try {
      const submitted = await browser.service.resume({ hash: transactionHash, wallet: browser.wallet });
      if (version !== generation.current) return;
      const confirmation = await browser.service.confirm({ transaction: submitted });
      if (version !== generation.current) return;
      if (confirmation.kind !== "pending") setPending(null);
      if (confirmation.kind === "pending") setState({ kind: "pending", hash: confirmation.hash });
      else if (confirmation.kind === "confirmed") {
        setState({ kind: "confirmed", hash: confirmation.hash, block: confirmation.blockNumber });
        await onConfirmed?.();
      } else setState({ kind: "error", message: confirmation.reason });
    } catch (error) {
      if (version === generation.current) setState({ kind: "error", message: error instanceof Error ? error.message : "The transaction could not be checked." });
    } finally {
      if (version === generation.current) inFlight.current = false;
    }
  }

  if (pendingOnly && (wallet.kind !== "connected" || browser.kind !== "configured" || wallet.chainId !== browser.service.manifest.chainId || !pending && state.kind === "idle")) return null;
  return (
    <form className="well pad stack resume-transaction" onSubmit={check}>
      <div><h2>{pending ? "Pending wallet activity" : "Resume after reload"}</h2><p>Use a transaction hash from this connected wallet to check its on-chain result. A submitted hash is not treated as success.</p></div>
      {pending ? <p className="notice warning" role="status">Reconcile this wallet’s unresolved transaction at nonce {pending.nonce} before submitting another action. {pending.hash ? "Its saved hash is filled in below." : "The wallet response was uncertain. Check wallet activity for the actual transaction or a same-nonce replacement/cancellation hash."}</p> : null}
      <label htmlFor={inputId}>Transaction hash<input id={inputId} spellCheck={false} autoComplete="off" value={hash} onChange={(event) => { setHash(event.target.value.trim()); setState({ kind: "idle" }); }} placeholder="0x…" /></label>
      <button className="btn btn-dark" type="submit" disabled={state.kind === "checking" || wallet.kind !== "connected" || browser.kind !== "configured" || wallet.chainId !== browser.service.manifest.chainId}>{state.kind === "checking" ? "Checking confirmation…" : "Check transaction"}</button>
      {state.kind === "pending" ? <p className="notice warning" role="status">Still pending. Check again later.</p> : null}
      {state.kind === "confirmed" ? <p className="notice ok" role="status">Confirmed in block {state.block.toString()}.</p> : null}
      {state.kind === "error" ? <p className="notice error" role="alert">{state.message}</p> : null}
    </form>
  );
}
