"use client";

import { useBench } from "@/lib/bench";
import { createCommitment } from "@/lib/chain/api";
import { SellerDashboard } from "./SellerDashboard";
import { SellerDraftForm } from "./SellerDraftForm";

export function LiveSeller() {
  const bench = useBench();
  const draftForm = bench.browser.kind === "configured"
    ? <SellerDraftForm service={bench.browser.service} wallet={bench.browser.wallet} saveCommitment={(input) => createCommitment(bench.browser.wallet, input)} onConfirmed={() => bench.refreshCatalog()} />
    : undefined;
  return <SellerDashboard browser={bench.browser} draftForm={draftForm} />;
}
