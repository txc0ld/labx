import type { Metadata } from "next";
import { PieceDesk } from "@/components/PieceDesk";

export const metadata: Metadata = { title: "Piece" };

export default async function PiecePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PieceDesk id={id} />;
}
