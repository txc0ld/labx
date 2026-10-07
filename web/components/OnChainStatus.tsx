"use client";

import React from "react";

const COPY = {
  studio: "Listing tools are not connected yet.",
  profile: "Wallet and account records require a reviewed raffle deployment on the configured test network.",
  rules: "Draw and recovery controls stay disabled unless a reviewed v3 deployment is configured. Historical Sepolia bytecode does not gain these source protections.",
  piece: "Purchasing is unavailable until this raffle is connected to an authoritative listing."
} as const;

export function OnChainStatus({ surface, compact = false }: { surface: keyof typeof COPY; compact?: boolean }) {
  return <p className={`notice warning${compact ? " notice-compact" : ""}`} role="status">{COPY[surface]}</p>;
}
