import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Studio",
  description: "Prepare and review public LABx listing details without publishing them."
};

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return children;
}
