"use client";

import { createCommitment, recoverCommitment, saveAgreement } from "@/lib/chain/api";
import { availableActions } from "@/lib/chain/workflow";
import { PUBLISHED_TERMS_HASH } from "@/lib/published-terms";
import { useBench } from "@/lib/bench";
import { RaffleWorkspace } from "./RaffleWorkspace";

export function LiveRaffle({ id }: { id: string }) {
  const bench = useBench();
  if (!/^[1-9]\d{0,77}$/.test(id)) return <section className="section stack missing-state"><h1 className="page-title">This raffle ID is invalid.</h1><p>Use a direct link from the verified collection.</p></section>;
  return <RaffleWorkspace browser={bench.browser} id={BigInt(id)} termsHash={PUBLISHED_TERMS_HASH} availableActions={availableActions} saveCommitment={(input) => createCommitment(bench.browser.wallet, input)} recoverCommitment={(commit) => recoverCommitment(bench.browser.wallet, { commit })} recordAgreement={async (raffleId) => { await saveAgreement(bench.browser.wallet, { raffleId: raffleId.toString(), terms: true, rules: true, age: true }); }} />;
}
