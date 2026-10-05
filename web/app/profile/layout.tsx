import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Profile",
  description: "Sepolia wallet, bonus entries, receipts, and agreements on the LABx bench."
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
