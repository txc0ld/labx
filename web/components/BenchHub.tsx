"use client";

import Link from "next/link";
import { FlowMark } from "@/components/FlowMark";
import { LAB_FEE, type Piece } from "@/lib/seed";
import { BenchTubes } from "./BenchTubes";
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
  const left = pieces.find((piece) => piece.id === FEATURED_LEFT) ?? pieces[0];
  const right = pieces.find((piece) => piece.id === FEATURED_RIGHT) ?? pieces[1] ?? pieces[0];
  const row = [...pieces].sort((a, b) => rank(a.id) - rank(b.id));

  return (
    <>
      <section className="bench" aria-labelledby="hero-title">
        <BenchTubes />
        <article className="pearl hero-copy bench-hero" data-tube="hero">
          <p className="kicker">sepolia bench</p>
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
            <Link className="hero-about" href="/about">About the lab</Link>
          </div>
          {banner ? <p className={`notice ${banner.tone}`} role="status">{banner.text}</p> : null}
        </article>
        {left ? <SideCard piece={left} slot="side-l" tube="left" /> : null}
        <div className="nft-capsule bezel" data-tube="well">
          <div className="nft-capsule-well">
            <p className="nft-capsule-label">NFT<br />CONTAINER</p>
          </div>
        </div>
        {right ? <SideCard piece={right} slot="side-r" tube="right" /> : null}
        <div className="bench-pieces">
          <h2 id="bench-title">On the bench</h2>
          <ul className="piece-row" id="bench" role="list">
            {row.map((piece, index) => {
              const entry = piece.packs.find((pack) => pack.name === "Entry");
              return (
                <li key={piece.id} data-tube={index < 4 ? `p${index}` : undefined}>
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
        </div>
      </section>
      <p className="notice warning">Sepolia only. This bench does not touch Ethereum mainnet.</p>
    </>
  );
}

function rank(id: string) {
  const index = ROW_ORDER.indexOf(id);
  return index === -1 ? ROW_ORDER.length : index;
}

function SideCard({ piece, slot, tube }: { piece: Piece; slot: "side-l" | "side-r"; tube: "left" | "right" }) {
  return (
    <Link className={`bezel side-card ${slot}`} href={`/piece/${piece.id}`} data-tube={tube}>
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
