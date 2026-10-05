"use client";

import Image from "next/image";
import Link from "next/link";
import { FlowMark } from "@/components/FlowMark";
import { useBench } from "@/lib/bench";
import { LAB_FEE } from "@/lib/seed";

export default function HomePage() {
  const { pieces, banner, ready } = useBench();
  if (!ready) return <section className="section"><p className="pearl pad">Opening the bench.</p></section>;
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="bezel">
          <div className="shot">
            <Image src="/lab/terminal-panel.jpg" alt="Purple terminal housing with a mirrored chrome bezel and a fluorescent cable" width={900} height={675} priority />
          </div>
        </div>
        <article className="pearl hero-copy">
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
        <div className="bezel">
          <div className="shot">
            <Image src="/lab/filter-panel.jpg" alt="Glossy pearlescent filter panel with chunky buttons and a fluorescent cable" width={900} height={675} priority />
          </div>
        </div>
      </section>
      <div className="bezel cable-photo">
        <Image src="/lab/chrome-fluoro-run.jpg" alt="Mirrored chrome tubes and fluorescent cables linking two instrument panels" width={1600} height={900} />
      </div>
      <p className="notice warning">Sepolia only. This bench does not touch Ethereum mainnet.</p>
      <section className="section" id="bench" aria-labelledby="bench-title">
        <h2 id="bench-title">On the bench</h2>
        <ul className="piece-grid" role="list">
          {pieces.map((piece) => {
            const entry = piece.packs.find((pack) => pack.name === "Entry");
            return (
              <li key={piece.id}>
                <Link className="bezel card" href={`/piece/${piece.id}`}>
                  <Image src={piece.image} alt={piece.imageAlt} width={640} height={480} />
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
    </>
  );
}
