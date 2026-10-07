import type { Metadata } from "next";
import { LiveSellerRaffle } from "@/components/workflow/LiveSellerRaffle";

export const metadata: Metadata = { title: "Manage raffle" };

export default async function SellerRafflePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveSellerRaffle id={id} />;
}
