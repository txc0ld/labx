"use client";

import { createCommitment, recoverCommitment } from "@/lib/chain/api";
import { availableActions } from "@/lib/chain/workflow";
import { parseSellerRaffleId } from "@/lib/chain/seller-actions";
import { PUBLISHED_TERMS_HASH } from "@/lib/published-terms";
import { useBench } from "@/lib/bench";
import { RaffleWorkspace } from "./RaffleWorkspace";

export function LiveSellerRaffle({ id }: { id: string }) {
  const bench = useBench();
  const raffleId = parseSellerRaffleId(id);
  if (raffleId === null) return <section className="section stack missing-state"><p className="kicker">Seller studio</p><h1 className="page-title">This raffle ID is invalid.</h1><p>Open a raffle from your verified seller portfolio.</p></section>;
  return <RaffleWorkspace mode="seller" browser={bench.browser} id={raffleId} termsHash={PUBLISHED_TERMS_HASH} availableActions={availableActions} saveCommitment={(input) => createCommitment(bench.browser.wallet, input)} recoverCommitment={(commit) => recoverCommitment(bench.browser.wallet, { commit })} />;
}
