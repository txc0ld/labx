"use client";

import React from "react";
import { onChainReady } from "../lib/wallet";

const COPY = {
  studio: "Creating a piece saves its private commitment on the server. Piece cards and phase changes are browser demo records; these controls do not escrow a token or submit a draw transaction.",
  profile: "The bench wallet and displayed entries are browser demo records. Connecting a wallet still requires Sepolia. Receipts need a signed wallet and Resend.",
  rules: "Complimentary-entry authorization is requested from the server. Displayed entry records stay on this browser demo; recording one here does not submit it on-chain.",
  piece: "Recording a demo pack stays in this browser. It does not transfer USDC or create an on-chain bonus entry."
} as const;

export function OnChainStatus({ surface }: { surface: keyof typeof COPY }) {
  const configured = onChainReady();
  return (
    <p className="notice warning" role="status">
      <span className="lamp lavender"><i /> bench only</span>
      {COPY[surface]}
      <span>{configured ? "A Sepolia contract address is configured; these controls still do not submit transactions." : "Sepolia contract is not wired. Mainnet stays disabled."}</span>
    </p>
  );
}
