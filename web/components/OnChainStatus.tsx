"use client";

import { onChainReady } from "@/lib/wallet";

const COPY = {
  studio: "Sepolia contract is not wired. Creating a piece stores the commitment hash on this bench only.",
  profile: "Sepolia contract is not wired. Connect still requires Sepolia. Receipts need a signed wallet and Resend.",
  rules: "Sepolia contract is not wired. Complimentary entries record on this bench. On-chain signatures stay off until the raffle address is set.",
  piece: "Sepolia contract is not wired. Recording a pack stays on this bench. Mainnet stays disabled."
} as const;

export function OnChainStatus({ surface }: { surface: keyof typeof COPY }) {
  if (onChainReady()) return null;
  return <p className="notice warning" role="status">{COPY[surface]}</p>;
}
