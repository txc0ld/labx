"use client";

import { BenchHub } from "@/components/BenchHub";
import { useBench } from "@/lib/bench";

export default function HomePage() {
  const { pieces, banner, ready } = useBench();
  if (!ready) return <section className="section"><p className="pearl pad">Opening the bench.</p></section>;
  return <BenchHub pieces={pieces} banner={banner} />;
}
