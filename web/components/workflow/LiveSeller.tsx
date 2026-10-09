"use client";

import { useState } from "react";
import { useBench } from "@/lib/bench";
import { createCommitment } from "@/lib/chain/api";
import { SellerDashboard } from "./SellerDashboard";
import { SellerDraftForm } from "./SellerDraftForm";

export function LiveSeller() {
  const bench = useBench();
  const [revision, setRevision] = useState(0);
  const draftForm = bench.browser.kind === "configured"
    ? <SellerDraftForm service={bench.browser.service} wallet={bench.browser.wallet} saveCommitment={(input, options) => createCommitment(bench.browser.wallet, input, options)} onConfirmed={async () => { await bench.refreshCatalog(); setRevision(value => value + 1); }} />
    : undefined;
  return <SellerDashboard browser={bench.browser} draftForm={draftForm} revision={revision} />;
}
