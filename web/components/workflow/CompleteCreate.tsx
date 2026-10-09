"use client";
import { useEffect, useRef, useState } from "react";
import { createStorageKey, encodeDraft, finishCreate, readCreateRecord, writeCreateRecord, retireCompletedCreate } from "@/lib/chain/create-flow";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { RaffleSnapshot } from "@/lib/chain/types";
import { useWalletSnapshot } from "./WalletGate";

export function CompleteCreate({ service, wallet, snapshot, disabled, onConfirmed }: {
  service: RaffleService; wallet: WalletSessionPort; snapshot: RaffleSnapshot; disabled: boolean; onConfirmed: () => Promise<void>;
}) {
  const session = useWalletSnapshot(wallet);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" | "error"; message: string }>({ kind: "idle" });
  const lifetime = useRef({ mounted: false, busy: false, operation: 0, generation: 0, revision: session.revision, service, wallet, snapshot, disabled });
  if (lifetime.current.revision !== session.revision || lifetime.current.service !== service || lifetime.current.wallet !== wallet || lifetime.current.snapshot !== snapshot || lifetime.current.disabled !== disabled) Object.assign(lifetime.current, { generation: lifetime.current.generation + 1, revision: session.revision, service, wallet, snapshot, disabled });
  useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false; lifetime.current.generation++; }; }, []);
  async function create() {
    if (disabled || lifetime.current.busy || session.kind !== "connected") return;
    const generation = lifetime.current.generation;
    lifetime.current.busy = true;
    const operation = ++lifetime.current.operation;
    const assertIntent = () => { if (!lifetime.current.mounted || lifetime.current.generation !== generation || wallet.getSnapshot().revision !== session.revision) throw new Error("Creation scope changed. Review and click Create again."); };
    try {
      if (!navigator.locks) throw new Error("Creation recovery requires secure Web Locks.");
      const baseKey = createStorageKey(service, session.account);
      await navigator.locks.request(baseKey, async () => {
        assertIntent();
        const r = snapshot.raffle;
        const draft = { nft: r.nft, tokenId: r.tokenId, salesEnd: r.salesEnd, reserveNonce: r.reserveNonce, reserveCommit: r.reserveCommit, title: r.title, packs: snapshot.packs };
        const active = readCreateRecord(localStorage, baseKey);
        const key = active?.kind === "draft" && active.data === encodeDraft(draft) && (active.id === null || active.id === snapshot.id.toString()) ? baseKey : `${baseKey}:raffle:${snapshot.id}`;
        const record = readCreateRecord(localStorage, key) ?? { kind: "draft", data: encodeDraft(draft), id: snapshot.id.toString(), creationHash: null, pending: null };
        if (record.kind !== "draft") throw new Error("Recover the saved draw setup first.");
        writeCreateRecord(localStorage, key, record);
        const result = await finishCreate({ service, wallet, draft, record, save: next => writeCreateRecord(localStorage, key, next), assertIntent, onStep: message => { assertIntent(); setState({ kind: "busy", message }); } });
        assertIntent();
        const completed = readCreateRecord(localStorage, key);
        if (completed?.kind !== "draft") throw new Error("Creation recovery changed.");
        retireCompletedCreate(localStorage, key, completed, result.id);
        await onConfirmed();
      });
    } catch (error) {
      if (lifetime.current.mounted && generation === lifetime.current.generation) setState({ kind: "error", message: error instanceof Error ? error.message : "Creation stopped. Recover this stage before continuing." });
    } finally {
      if (lifetime.current.operation === operation) {
        lifetime.current.busy = false;
        if (lifetime.current.mounted && lifetime.current.generation !== generation) setState(current => current.kind === "busy" ? { kind: "error", message: "The creation details changed. Click Create to resume the saved stage." } : current);
      }
    }
  }
  return <section className="workflow-next stack"><h2>Create your raffle</h2><p>Create completes this saved draft and locks the NFT in raffle custody. Confirm each requested transaction in your wallet.</p>{state.kind !== "idle" ? <p role={state.kind === "error" ? "alert" : "status"}>{state.message}</p> : null}<button className="btn" type="button" disabled={disabled || state.kind === "busy"} onClick={() => void create()}>{state.kind === "busy" ? "Creating…" : "Create"}</button></section>;
}
