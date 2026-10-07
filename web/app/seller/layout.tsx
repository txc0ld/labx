import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Seller studio",
  description: "Manage your LABx raffles, revenue, settlement and recovery from the verified seller wallet."
};

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return children;
}
