import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Profile",
  description: "Connect a Sepolia wallet, check points, and save an email preference on LABx."
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
