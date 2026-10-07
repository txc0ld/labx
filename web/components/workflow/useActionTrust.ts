"use client";
import { useEffect, useState } from "react";
import type { RaffleService } from "@/lib/chain/ports";
import type { RaffleSnapshot } from "@/lib/chain/types";

// Presentation only. Preparation and submission independently check current chain state.
export function useActionTrust(service: RaffleService, snapshot: RaffleSnapshot): string | null {
  const [result, setResult] = useState<{ snapshot: RaffleSnapshot; reason: string | null } | null>(null);
  useEffect(() => {
    if (snapshot.raffle.phase !== 0 && snapshot.raffle.phase !== 1) return;
    let active = true;
    void service.assertActionTrust({ kind: snapshot.raffle.phase === 0 ? "opening" : "membership", id: snapshot.id, block: snapshot.block })
      .then(() => { if (active) setResult({ snapshot, reason: null }); })
      .catch((error: unknown) => { if (active) setResult({ snapshot, reason: error instanceof Error ? error.message : "New approvals, openings or purchases could not be verified. Refresh to retry." }); });
    return () => { active = false; };
  }, [service, snapshot]);
  if (snapshot.raffle.phase !== 0 && snapshot.raffle.phase !== 1) return null;
  return result?.snapshot === snapshot ? result.reason : "Checking authority and policy for new approvals, openings and purchases.";
}
