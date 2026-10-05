import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Studio",
  description: "Commit and operate a LABx piece on the Sepolia bench."
};

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return children;
}
