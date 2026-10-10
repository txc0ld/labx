import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Profile",
  description: "Your wallet, raffles, points and receipt email on LABx."
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
