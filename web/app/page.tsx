"use client";

import { BenchHub } from "@/components/BenchHub";
import { ScrollStory } from "@/components/ScrollStory";
import { useBench } from "@/lib/bench";

export default function HomePage() {
  const { pieces, banner, ready } = useBench();
  return (
    <>
      {ready
        ? <BenchHub pieces={pieces} banner={banner} />
        : <section className="section" id="bench"><p className="pearl pad">Opening the bench.</p></section>}
      <ScrollStory />
    </>
  );
}
