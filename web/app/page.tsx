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
        : <section className="section state-section" id="bench"><div className="pearl pad state-panel" role="status"><span className="state-orb" aria-hidden="true" /><div><strong>Opening the bench</strong><p>Preparing the collection.</p></div></div></section>}
      <ScrollStory />
    </>
  );
}
