"use client";

import React from "react";

const COPY = {
  studio: "Listing tools are not connected yet.",
  profile: "Wallet connection and points use Sepolia. Raffle and agreement history is not connected yet.",
  rules: "Complimentary-entry requests are unavailable until website listings are connected.",
  piece: "Purchasing is unavailable until this raffle is connected to an authoritative listing."
} as const;

export function OnChainStatus({ surface, compact = false }: { surface: keyof typeof COPY; compact?: boolean }) {
  return <p className={`notice warning${compact ? " notice-compact" : ""}`} role="status">{COPY[surface]}</p>;
}
