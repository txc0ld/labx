"use client";

import Link from "next/link";
import React from "react";
import { useEffect, useRef } from "react";
import { PixelDivider } from "./PixelDivider";

const STORIES = [
  {
    title: "Look closer.",
    href: "#bench",
    link: "Back to the collection"
  },
  {
    title: "Follow the draw.",
    href: "/guide",
    link: "How it works"
  }
] as const;

export function ScrollStory() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !("requestAnimationFrame" in window)) return;

    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let observer: ResizeObserver | null = null;
    let listening = false;

    const reset = () => {
      root.querySelectorAll<HTMLElement>("[data-story-character]").forEach((character) => {
        character.style.removeProperty("--story-x");
        character.style.removeProperty("--story-y");
        character.style.removeProperty("--story-r");
        character.style.removeProperty("--story-opacity");
      });
    };

    const render = () => {
      frame = 0;
      const viewportHeight = window.innerHeight;
      root.querySelectorAll<HTMLElement>("[data-story]").forEach((section, storyIndex) => {
        const rect = section.getBoundingClientRect();
        const progress = Math.max(0, Math.min(1, (viewportHeight - rect.top) / (viewportHeight + rect.height)));
        const entryStrength = progress < .28 ? 1 - progress / .28 : 0;
        const exitStrength = progress > .72 ? (progress - .72) / .28 : 0;
        const strength = Math.max(entryStrength, exitStrength);
        const direction = exitStrength > 0 ? -1 : 1;

        section.querySelectorAll<HTMLElement>("[data-story-character]").forEach((character, index) => {
          const seed = (index + 1) * (storyIndex + 3);
          const x = (((seed * 29) % 71) - 35) * strength * direction;
          const y = (((seed * 17) % 45) - 22) * strength;
          const rotation = (((seed * 13) % 25) - 12) * strength * direction;
          character.style.setProperty("--story-x", `${x.toFixed(2)}px`);
          character.style.setProperty("--story-y", `${y.toFixed(2)}px`);
          character.style.setProperty("--story-r", `${rotation.toFixed(2)}deg`);
          character.style.setProperty("--story-opacity", String(1 - strength * .42));
        });
      });
    };

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(render);
    };

    const stop = () => {
      if (listening) {
        window.removeEventListener("scroll", schedule);
        window.removeEventListener("resize", schedule);
        listening = false;
      }
      observer?.disconnect();
      observer = null;
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      reset();
    };

    const start = () => {
      stop();
      if (preference.matches) return;
      window.addEventListener("scroll", schedule, { passive: true });
      window.addEventListener("resize", schedule, { passive: true });
      listening = true;
      if ("ResizeObserver" in window) {
        observer = new ResizeObserver(schedule);
        observer.observe(root);
        if (root.parentElement) observer.observe(root.parentElement);
      }
      schedule();
    };

    start();
    preference.addEventListener("change", start);
    return () => {
      preference.removeEventListener("change", start);
      stop();
    };
  }, []);

  return (
    <div className="scroll-stories" ref={rootRef}>
      {STORIES.map((story, storyIndex) => (
        <React.Fragment key={story.title}>
        <section className="scroll-story" data-story>
          <h2 className="scroll-story-heading">
            <span className="sr">{story.title}</span>
            <span aria-hidden="true">
              {story.title.split(" ").map((word, wordIndex) => (
                <React.Fragment key={`${story.title}-${word}`}>
                  <span className="scroll-story-word">
                    {Array.from(word, (character, characterIndex) => (
                      <span className="scroll-story-character" data-story-character key={`${word}-${characterIndex}`}>{character}</span>
                    ))}
                  </span>
                  {wordIndex < story.title.split(" ").length - 1 ? " " : null}
                </React.Fragment>
              ))}
            </span>
          </h2>
          <div className="scroll-story-copy">
            <Link href={story.href}>{story.link} <span aria-hidden="true">↗</span></Link>
          </div>
        </section>
        {storyIndex === 0 ? <PixelDivider /> : null}
        </React.Fragment>
      ))}
    </div>
  );
}
