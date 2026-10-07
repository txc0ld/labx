"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { OnChainStatus } from "@/components/OnChainStatus";
import { AccountNav } from "@/components/AccountNav";
import { useBench } from "@/lib/bench";
import { WalletConnectionControls } from "@/components/workflow/WalletConnectionControls";
import { ResumeTransaction } from "@/components/workflow/ResumeTransaction";

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

  if (!bench.ready) return <section className="section state-section"><div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Loading profile</strong><p>Opening your local account view.</p></div></div></section>;

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
        <h1 className="page-title">Your bench</h1>
        <p className="lede">Wallet, account records and browser-only receipt preferences.</p>
        <AccountNav />
      </header>
      <div className="split profile-grid">
      <div className="pearl pad stack profile-primary">
        <div className="terminal pad">
          <div>wallet {bench.wallet || "not connected"}</div>
          <div>
            points {!bench.wallet ? "connect wallet" : currentPoints.kind === "ready" ? currentPoints.balance : currentPoints.kind === "error" ? "unavailable" : "loading"}
          </div>
          <div>chain sepolia</div>
        </div>
        <OnChainStatus surface="profile" />
        <p className="muted">Existing points records are separate from memberships and bonus entries. They do not grant an entry.</p>
        <WalletConnectionControls wallet={bench.browser.wallet} />
        <div className="btn-row">
          {currentPoints.kind === "error" ? <button className="btn btn-dark" type="button" onClick={() => setPointsRetry((value) => value + 1)}>Retry points</button> : null}
        </div>
        {currentPoints.kind === "error" ? <p className="notice error" role="alert">{currentPoints.message}</p> : null}
        {bench.banner ? <p className={`notice ${bench.banner.tone}`} role="status">{bench.banner.text}</p> : null}
        <form className="stack" id="email-preferences" onSubmit={savePreference}>
          <label htmlFor="email">Email preference
            <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <p className="muted">This address is stored only in this browser. Purchase receipts are unavailable until verified purchase history is connected. See the <Link href="/privacy">privacy policy</Link>.</p>
          <button className="btn btn-lime" type="submit">Save email in this browser</button>
          {note ? <p className="notice warning" role="status">{note}</p> : null}
        </form>
      </div>
      <div className="stack profile-secondary">
        <div className="well pad">
          <h2>Membership status</h2>
          <p>Membership status is unknown because the website is not connected to an authoritative membership source.</p>
          <Link href="/membership">Review membership packs</Link>
        </div>
        <div className="pearl pad">
          <h2>Account records</h2>
          <p className="muted">Confirmed purchases and claims come from contract events. Private receipt and agreement status requires a wallet signature.</p>
          <div className="btn-row"><Link className="btn" href="/profile/history">View history</Link><Link className="btn btn-dark" href="/profile/receipts">View receipts</Link></div>
        </div>
        <ResumeTransaction browser={bench.browser} />
      </div>
      </div>
    </section>
  );
}
