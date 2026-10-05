"use client";

import Link from "next/link";
import { useRef } from "react";
import { FlowMark } from "@/components/FlowMark";
import { LAB_FEE, type Piece } from "@/lib/seed";
import { BenchTubes, type TubeNode } from "./BenchTubes";
import { markFor, PieceMark } from "./PieceMark";

const FEATURED_LEFT = "terminal-well";
const FEATURED_RIGHT = "filter-bank";
const ROW_ORDER = ["cable-run", "filter-bank", "terminal-well", "junction-array"];

export function BenchHub({
  pieces,
  banner
}: {
  pieces: Piece[];
  banner?: { tone: "warning" | "error" | "ok"; text: string };
}) {
  const root = useRef<HTMLElement>(null);
  const nodes = useRef<Partial<Record<TubeNode, HTMLElement | null>>>({});
  const left = pieces.find((piece) => piece.id === FEATURED_LEFT) ?? pieces[0];
  const right = pieces.find((piece) => piece.id === FEATURED_RIGHT) ?? pieces[1] ?? pieces[0];
  const row = [...pieces].sort((a, b) => rank(a.id) - rank(b.id));

  function bind(key: TubeNode) {
    return (node: HTMLElement | null) => {
      nodes.current[key] = node;
    };
  }

  return (
    <>
      <section className="bench" aria-labelledby="hero-title" ref={root}>
        <BenchTubes root={root} nodes={nodes} />
        <article className="pearl hero-copy bench-hero" ref={bind("hero")}>
          <p className="kicker">labx.art · sepolia bench</p>
          <h1 id="hero-title">Pieces, linked on the bench.</h1>
          <p className="lede">
            Membership packs for one escrowed piece. Bonus entries come with the pack. Chainlink VRF runs after the entry snapshot.
          </p>
          <div className="btn-row">
            <FlowMark />
            <span className="lamp lime"><i /> +{LAB_FEE} USDC lab fee</span>
            <span className="lamp lavender"><i /> USDC</span>
          </div>
          <div className="btn-row">
            <a className="btn" href="#bench">Explore the bench</a>
            <Link className="btn btn-dark" href="/fairness">How a draw stays fair</Link>
          </div>
          {banner ? <p className={`notice ${banner.tone}`} role="status">{banner.text}</p> : null}
        </article>
        {left ? <SideCard piece={left} bind={bind("left")} slot="side-l" /> : null}
        <div className="nft-capsule bezel" ref={bind("well")}>
          <div className="nft-capsule-well">
            <p className="nft-capsule-label">NFT<br />CONTAINER</p>
          </div>
        </div>
        {right ? <SideCard piece={right} bind={bind("right")} slot="side-r" /> : null}
        <ul className="piece-row" id="bench" role="list">
          {row.map((piece, index) => {
            const entry = piece.packs.find((pack) => pack.name === "Entry");
            const key = (`p${index}`) as TubeNode;
            return (
              <li key={piece.id} ref={index < 4 ? bind(key) : undefined}>
                <Link className="bezel piece-card" href={`/piece/${piece.id}`}>
                  <div className="icon-plate">
                    <PieceMark name={markFor(piece.id, piece.mark)} />
                  </div>
                  <div className="pearl meta">
                    <span className={`lamp ${piece.phase === "open" ? "mint" : "lavender"}`}><i /> {piece.phase}</span>
                    <h3>{piece.title}</h3>
                    <p>{piece.artist}</p>
                    <p className="price">{entry ? `Entry pack ${entry.priceUsdc} USDC` : "Packs on this piece"}</p>
                    <p>Entry through Platinum. Bonus entries included.</p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
      <p className="notice warning">Sepolia only. This bench does not touch Ethereum mainnet.</p>
      <section className="section bench-foot" aria-labelledby="bench-title">
        <h2 id="bench-title">On the bench</h2>
      </section>
    </>
  );
}

function rank(id: string) {
  const index = ROW_ORDER.indexOf(id);
  return index === -1 ? ROW_ORDER.length : index;
}

function SideCard({ piece, bind, slot }: { piece: Piece; bind: (node: HTMLElement | null) => void; slot: "side-l" | "side-r" }) {
  return (
    <Link className={`bezel side-card ${slot}`} href={`/piece/${piece.id}`} ref={bind}>
      <div className="icon-plate">
        <PieceMark name={markFor(piece.id, piece.mark)} />
      </div>
      <div className="pearl meta">
        <span className={`lamp ${piece.phase === "open" ? "mint" : "lavender"}`}><i /> {piece.phase}</span>
        <h3>{piece.title}</h3>
      </div>
    </Link>
  );
}
