"use client";

import React from "react";

const COPY = {
  studio: "Listing tools are not connected yet.",
  profile: "Wallet connection uses Sepolia. Membership, bonus-entry, receipt and agreement history is not connected yet.",
  rules: "Draw and recovery actions are not connected. The current Sepolia deployment does not include the latest source protections; do not treat it as the new workflow.",
  piece: "Purchasing is unavailable until this raffle is connected to an authoritative listing."
} as const;

export function OnChainStatus({ surface, compact = false }: { surface: keyof typeof COPY; compact?: boolean }) {
  return <p className={`notice warning${compact ? " notice-compact" : ""}`} role="status">{COPY[surface]}</p>;
}
