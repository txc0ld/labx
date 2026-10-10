"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { OnChainStatus } from "@/components/OnChainStatus";
import { AccountNav } from "@/components/AccountNav";
import { useBench } from "@/lib/bench";
import { WalletConnectionControls } from "@/components/workflow/WalletConnectionControls";
import { ResumeTransaction } from "@/components/workflow/ResumeTransaction";
import { BuyerRaffles } from "@/components/workflow/BuyerRaffles";
import { shortAddress } from "@/components/workflow/format";

type PointsState =
  | { kind: "idle" }
  | { kind: "loading"; wallet: string }
  | { kind: "ready"; wallet: string; balance: number }
  | { kind: "error"; wallet: string; message: string };

function pointsBody(value: unknown): { balance: number } | { error: string } {
  if (typeof value !== "object" || value === null) return { error: "Points are unavailable." };
  if ("balance" in value && typeof value.balance === "number" && Number.isFinite(value.balance)) {
    return { balance: value.balance };
  }
  return { error: "error" in value && typeof value.error === "string" ? value.error : "Points are unavailable." };
}

export default function ProfilePage() {
  const bench = useBench();
  const [points, setPoints] = useState<PointsState>({ kind: "idle" });
  const [pointsRetry, setPointsRetry] = useState(0);
  const pointsRequest = useRef(0);
  const initialEmailAnchorHandled = useRef(false);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (bench.ready) setEmail(bench.email);
  }, [bench.email, bench.ready]);

  useEffect(() => {
    if (!bench.ready || initialEmailAnchorHandled.current) return;
    if (window.location.hash !== "#email-preferences") {
      initialEmailAnchorHandled.current = true;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("email-preferences")?.scrollIntoView({ block: "start" });
      initialEmailAnchorHandled.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bench.ready]);

  useEffect(() => {
    const request = ++pointsRequest.current;
    const controller = new AbortController();
    const wallet = bench.wallet;
    if (!wallet) {
      setPoints({ kind: "idle" });
      return () => controller.abort();
    }

    setPoints({ kind: "loading", wallet });
    void (async () => {
      try {
        const response = await fetch(`/api/points?address=${wallet}`, { signal: controller.signal });
        const body: unknown = await response.json();
        const parsed = pointsBody(body);
        if (!response.ok || "error" in parsed) throw new Error("error" in parsed ? parsed.error : "Points are unavailable.");
        if (pointsRequest.current === request && !controller.signal.aborted) {
          setPoints({ kind: "ready", wallet, balance: parsed.balance });
        }
      } catch (error) {
        if (pointsRequest.current === request && !controller.signal.aborted) {
          setPoints({ kind: "error", wallet, message: error instanceof Error ? error.message : "Points are unavailable." });
        }
      }
    })();

    return () => {
      controller.abort();
      if (pointsRequest.current === request) pointsRequest.current += 1;
    };
  }, [bench.wallet, pointsRetry]);

  if (!bench.ready) return <section className="section state-section"><div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading your profile…</strong></div></div></section>;

  function savePreference(event: FormEvent) {
    event.preventDefault();
    setNote(bench.saveEmail(email));
  }

  const currentPoints: PointsState = points.kind !== "idle" && points.wallet === bench.wallet
    ? points
    : { kind: "loading", wallet: bench.wallet };

  return (
    <section className="section workflow-page stack">
      <header className="workflow-header stack">
        <h1 className="page-title">Profile</h1>
        <AccountNav />
      </header>
      <div className="split profile-grid">
      <div className="pearl pad stack profile-primary">
        <div className="terminal pad">
          <div>Wallet {bench.wallet ? shortAddress(bench.wallet) : "not connected"}</div>
          {bench.wallet ? <div>Points {currentPoints.kind === "ready" ? currentPoints.balance : currentPoints.kind === "error" ? "unavailable" : "…"}</div> : null}
        </div>
        {bench.browser.kind !== "configured" ? <OnChainStatus surface="profile" /> : null}
        <WalletConnectionControls wallet={bench.browser.wallet} />
        <div className="btn-row">
          {currentPoints.kind === "error" ? <button className="btn btn-dark" type="button" onClick={() => setPointsRetry((value) => value + 1)}>Retry points</button> : null}
        </div>
        {currentPoints.kind === "error" ? <p className="notice error" role="alert">{currentPoints.message}</p> : null}
        {bench.banner ? <p className={`notice ${bench.banner.tone}`} role="status">{bench.banner.text}</p> : null}
        <form className="stack" id="email-preferences" onSubmit={savePreference}>
          <label htmlFor="email">Email for receipts
            <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <p className="muted">Saved in this browser only. We use it to email your <Link href="/profile/receipts">receipts</Link>. See the <Link href="/privacy">privacy policy</Link>.</p>
          <button className="btn btn-lime" type="submit">Save email</button>
          {note ? <p className="notice warning" role="status">{note}</p> : null}
        </form>
      </div>
      <div className="stack profile-secondary">
        <BuyerRaffles browser={bench.browser} />
        <ResumeTransaction browser={bench.browser} />
      </div>
      </div>
    </section>
  );
}
