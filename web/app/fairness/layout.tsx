import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fairness",
  description: "Escrow, commitment hash, and Chainlink VRF locks on every LABx Sepolia draw."
};

export default function FairnessLayout({ children }: { children: React.ReactNode }) {
  return children;
}
