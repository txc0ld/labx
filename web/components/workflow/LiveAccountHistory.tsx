"use client";

import { useBench } from "@/lib/bench";
import { AccountHistory } from "./AccountHistory";

export function LiveAccountHistory() {
  const bench = useBench();
  return <AccountHistory browser={bench.browser} loading={!bench.ready} />;
}
