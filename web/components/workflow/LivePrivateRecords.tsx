"use client";

import { useBench } from "@/lib/bench";
import { readPrivateRecords, sendPurchaseReceipt } from "@/lib/chain/api";
import { PrivateRecordsPanel } from "./PrivateRecordsPanel";

export function LivePrivateRecords() {
  const bench = useBench();
  return <PrivateRecordsPanel browser={bench.browser} email={bench.email} readRecords={(input) => readPrivateRecords(bench.browser.wallet, input)} deliverReceipt={(input) => sendPurchaseReceipt(bench.browser.wallet, { ...input, to: bench.email })} />;
}
