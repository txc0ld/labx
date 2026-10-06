import type { Metadata } from "next";
import { LiveRaffle } from "@/components/workflow/LiveRaffle";

export const metadata: Metadata = { title: "Piece" };

export default async function PiecePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveRaffle id={id} />;
}
