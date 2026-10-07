"use client";

import { LegalNav } from "@/components/LegalNav";
import { FairnessRecords } from "@/components/workflow/FairnessRecords";

export default function FairnessPage() {
  return (
    <section className="section page-frame">
      <h1 className="page-title">The draw</h1>
      <p className="lede">Escrow, a commitment hash, then VRF after the snapshot. Settlement flips phase; claims move the prize, proceeds, and fee.</p>
      <LegalNav />
      <div className="piece-grid legal-surfaces">
        <article className="pearl pad">
          <h2>Escrow</h2>
          <p>The piece moves into escrow before memberships open. After settlement, the drawn wallet claims the NFT. Membership proceeds and the lab fee remain separate claims for the seller and pinned treasury.</p>
        </article>
        <article className="pearl pad">
          <h2>Commit</h2>
          <p>A private commitment is hashed with a salt on the server, then committed on-chain. Public pages show the outer hash. The salt stays off this bench until a signed reveal.</p>
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
