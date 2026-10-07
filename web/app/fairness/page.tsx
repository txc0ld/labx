"use client";

import { LegalNav } from "@/components/LegalNav";
import { FairnessRecords } from "@/components/workflow/FairnessRecords";

export default function FairnessPage() {
  return (
    <section className="section page-frame">
      <h1 className="page-title">The draw</h1>
      <p className="lede">The prize is locked. Entries are frozen. One verifiable draw decides the winner.</p>
      <LegalNav />
      <div className="piece-grid legal-surfaces">
        <article className="pearl pad">
          <h2>Escrow</h2>
          <p>The NFT enters escrow before memberships open. After settlement, the winner claims the prize, the seller claims net proceeds, and the treasury claims the fees separately.</p>
        </article>
        <article className="pearl pad">
          <h2>Commit</h2>
          <p>The seller records a private commitment before opening. Its public hash lets anyone check the later reveal. It does not enforce a minimum sale price.</p>
        </article>
        <article className="terminal pad">
          <h2>VRF</h2>
          <p>After sales close and the complete entry snapshot freezes, anyone can start the single Chainlink VRF v2.5 request before the seven-day draw-start deadline. The raffle uses the settings fixed when memberships opened. No rerolls are allowed.</p>
        </article>
      </div>
      <div className="section table-wrap well pad">
        <FairnessRecords />
      </div>
    </section>
  );
}
