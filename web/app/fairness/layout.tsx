import type { Metadata } from "next";
import { configuredChainId, NETWORKS } from "@/lib/chain/networks";

export const metadata: Metadata = {
  title: "Fairness",
  description: `Escrow, commitment hash, and Chainlink VRF locks on every LABx ${NETWORKS[configuredChainId()].shortName} draw.`
};

export default function FairnessLayout({ children }: { children: React.ReactNode }) {
  return children;
}
