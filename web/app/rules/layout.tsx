import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Draw rules",
  description: "How a LABx piece is snapshotted and drawn, including the intended complimentary-entry rules."
};

export default function RulesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
