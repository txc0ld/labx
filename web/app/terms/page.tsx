import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  redirect("/legal");
}
