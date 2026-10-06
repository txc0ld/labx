"use client";

import { useEffect, useRef, useState } from "react";
import type { ArtworkMetadata } from "@/lib/chain/metadata";
import type { RaffleService } from "@/lib/chain/ports";
import type { RaffleSnapshot } from "@/lib/chain/types";

type ArtworkState = { kind: "loading" } | { kind: "ready"; metadata: ArtworkMetadata; broken: boolean } | { kind: "unavailable" };

export function RaffleArtwork({ service, snapshot, compact = false, showDescription = false }: {
  service: RaffleService;
  snapshot: RaffleSnapshot;
  compact?: boolean;
  showDescription?: boolean;
}) {
  const [state, setState] = useState<ArtworkState>({ kind: "loading" });
  const request = useRef(0);
  useEffect(() => {
    const version = ++request.current;
    setState({ kind: "loading" });
    void service.readArtwork({ id: snapshot.id, block: snapshot.block }).then((metadata) => {
      if (version === request.current) setState({ kind: "ready", metadata, broken: false });
    }).catch(() => {
      if (version === request.current) setState({ kind: "unavailable" });
    });
    return () => { request.current += 1; };
  }, [service, snapshot.block, snapshot.id]);

  const image = state.kind === "ready" && !state.broken ? state.metadata.image : null;
  const imageAlt = state.kind === "ready" ? state.metadata.title || snapshot.raffle.title : snapshot.raffle.title;
  return (
    <div className={compact ? "chain-capsule-art" : "chain-art-placeholder"} data-artwork={image ? "ready" : state.kind}>
      {image ? <img src={image} alt={imageAlt} loading={compact ? "lazy" : "eager"} decoding="async" crossOrigin="anonymous" referrerPolicy="no-referrer" onError={() => setState((current) => current.kind === "ready" ? { ...current, broken: true } : current)} /> : <><span aria-hidden="true">{snapshot.raffle.title.slice(0, 2).toUpperCase()}</span><p>{state.kind === "loading" ? "Loading NFT artwork" : "NFT artwork unavailable"}</p><small>Token #{snapshot.raffle.tokenId.toString()}</small></>}
      {showDescription && state.kind === "ready" && state.metadata.description ? <p className="artwork-description">{state.metadata.description}</p> : null}
    </div>
  );
}
