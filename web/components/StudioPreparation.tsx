"use client";

import Link from "next/link";
import { useReducer, type FormEvent } from "react";
import { emptyStudioDraft, initialStudioState, studioPreparation } from "@/lib/studio-preparation";

export function StudioPreparation() {
  const [state, dispatch] = useReducer(studioPreparation, undefined, initialStudioState);

  function review(event: FormEvent) {
    event.preventDefault();
    dispatch({ kind: "review" });
  }

  if (state.kind === "reviewing") {
    return (
      <div className="studio-review stack">
        <p className="notice warning" role="status">Preparation only. This review stays in the current page session and is not a listing.</p>
        <dl className="review-list">
          <div><dt>Title</dt><dd>{state.draft.title}</dd></div>
          <div><dt>Artist</dt><dd>{state.draft.artist}</dd></div>
          <div><dt>Public token reference</dt><dd>{state.draft.tokenReference}</dd></div>
          <div><dt>Proposed closing date</dt><dd>{state.draft.proposedClose}</dd></div>
        </dl>
        <div className="btn-row">
          <button className="btn" type="button" onClick={() => dispatch({ kind: "edit" })}>Edit preparation</button>
          <button className="btn btn-dark" type="button" onClick={() => dispatch({ kind: "reset" })}>Reset</button>
        </div>
        <p className="muted">Publishing remains unavailable. Escrow and the public commitment must be confirmed through the authoritative workflow before packs can open.</p>
      </div>
    );
  }

  const hasInput = Object.values(state.draft).some((value) => value.length > 0);

  return (
    <form className="studio-form stack" onSubmit={review}>
      <p className="notice warning">Enter public listing details only. Do not enter a private commitment, salt, seed, key or wallet secret.</p>
      <label htmlFor="studio-title">Piece title<input id="studio-title" value={state.draft.title} onChange={(event) => dispatch({ kind: "change-title", value: event.target.value })} required /></label>
      <label htmlFor="studio-artist">Artist<input id="studio-artist" value={state.draft.artist} onChange={(event) => dispatch({ kind: "change-artist", value: event.target.value })} required /></label>
      <label htmlFor="studio-token">Public token reference<input id="studio-token" value={state.draft.tokenReference} onChange={(event) => dispatch({ kind: "change-token-reference", value: event.target.value })} placeholder="Contract address and token ID" required /></label>
      <label htmlFor="studio-close">Proposed closing date<input id="studio-close" type="datetime-local" value={state.draft.proposedClose} onChange={(event) => dispatch({ kind: "change-proposed-close", value: event.target.value })} required /></label>
      <p className="muted">This preparation stays in this page session. It is not saved, published or sent to a service.</p>
      <div className="btn-row">
        <button className="btn" type="submit">Review preparation</button>
        <button className="btn btn-dark" type="button" disabled={!hasInput} onClick={() => dispatch({ kind: "reset" })}>Reset</button>
        <Link className="btn btn-lime" href="/guide#workflow">Intended workflow</Link>
      </div>
    </form>
  );
}
