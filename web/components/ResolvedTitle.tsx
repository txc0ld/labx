"use client";

import { useEffect, useState } from "react";

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789+/";
const TARGET = "Pieces, linked\non the bench.";

function resolveFrame(frame: number, frames: number) {
  const resolved = Math.floor((TARGET.length * frame) / frames);
  return Array.from(TARGET, (character, index) => {
    if (character === "\n" || character === " " || index < resolved) return character;
    return GLYPHS[(frame * 7 + index * 11) % GLYPHS.length];
  }).join("");
}

export function ResolvedTitle() {
  const [visual, setVisual] = useState(TARGET);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timers = new Set<number>();

    const clear = () => {
      timers.forEach(window.clearTimeout);
      timers.clear();
    };

    const run = () => {
      clear();
      setVisual(TARGET);
      if (media.matches) return;
      const frames = 18;
      for (let frame = 0; frame <= frames; frame += 1) {
        const timer = window.setTimeout(() => {
          setVisual(frame === frames ? TARGET : resolveFrame(frame, frames));
          timers.delete(timer);
        }, 180 + frame * 42);
        timers.add(timer);
      }
    };

    run();
    media.addEventListener("change", run);
    return () => {
      media.removeEventListener("change", run);
      clear();
    };
  }, []);

  return (
    <h1 id="hero-title" className="resolved-title">
      <span className="sr">Pieces, linked on the bench.</span>
      <span className="resolved-title-visual" aria-hidden="true">{visual}</span>
    </h1>
  );
}
