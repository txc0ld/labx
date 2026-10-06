import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Draw rules",
  description: "How bonus entries included with LABx memberships are snapshotted, drawn and settled."
};

export default function RulesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
