import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Draw rules",
  description: "How a LABx piece is snapshotted, drawn, and how a complimentary entry is requested."
};

export default function RulesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
