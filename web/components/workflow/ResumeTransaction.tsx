"use client";

import { useState, type FormEvent } from "react";
import { isHex, type Hex } from "viem";
import type { BrowserService } from "@/lib/chain/ports";

type ResumeState =
  | { kind: "idle" }
  | { kind: "checking"; hash: Hex }
  | { kind: "pending"; hash: Hex }
  | { kind: "confirmed"; hash: Hex; block: bigint }
  | { kind: "error"; message: string };

export function ResumeTransaction({ browser, onConfirmed }: { browser: BrowserService; onConfirmed?: () => void | Promise<void> }) {
  const [hash, setHash] = useState("");
  const [state, setState] = useState<ResumeState>({ kind: "idle" });

  async function check(event: FormEvent) {
    event.preventDefault();
    if (browser.kind !== "configured") {
      setState({ kind: "error", message: browser.reason });
      return;
    }
    if (!isHex(hash, { strict: true }) || hash.length !== 66) {
      setState({ kind: "error", message: "Enter a complete transaction hash." });
      return;
    }
    const transactionHash: Hex = hash;
    setState({ kind: "checking", hash: transactionHash });
    try {
      const submitted = await browser.service.resume({ hash: transactionHash, wallet: browser.wallet });
      const confirmation = await browser.service.confirm({ transaction: submitted });
      if (confirmation.kind === "pending") setState({ kind: "pending", hash: confirmation.hash });
      else if (confirmation.kind === "confirmed") {
        setState({ kind: "confirmed", hash: confirmation.hash, block: confirmation.blockNumber });
        await onConfirmed?.();
      } else setState({ kind: "error", message: confirmation.reason });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "The transaction could not be checked." });
    }
  }

  return (
    <form className="well pad stack resume-transaction" onSubmit={check}>
      <div><h2>Resume after reload</h2><p>Use a transaction hash from this connected wallet to check its on-chain result. A submitted hash is not treated as success.</p></div>
      <label htmlFor="resume-hash">Transaction hash<input id="resume-hash" spellCheck={false} autoComplete="off" value={hash} onChange={(event) => { setHash(event.target.value.trim()); setState({ kind: "idle" }); }} placeholder="0x…" /></label>
      <button className="btn btn-dark" type="submit" disabled={state.kind === "checking"}>{state.kind === "checking" ? "Checking confirmation…" : "Check transaction"}</button>
      {state.kind === "pending" ? <p className="notice warning" role="status">Still pending. Check again later.</p> : null}
      {state.kind === "confirmed" ? <p className="notice ok" role="status">Confirmed in block {state.block.toString()}.</p> : null}
      {state.kind === "error" ? <p className="notice error" role="alert">{state.message}</p> : null}
    </form>
  );
}
