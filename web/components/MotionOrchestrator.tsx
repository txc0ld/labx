"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function MotionOrchestrator() {
  const pathname = usePathname();

  useEffect(() => {
    const media = window.matchMedia(MOTION_QUERY);
    const root = document.documentElement;
    const surfaces = new Set(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    let observer: IntersectionObserver | null = null;
    let mutations: MutationObserver | null = null;

    const stop = () => {
      observer?.disconnect();
      observer = null;
      mutations?.disconnect();
      mutations = null;
      delete root.dataset.motion;
      surfaces.forEach((surface) => delete surface.dataset.inView);
    };

    const start = () => {
      stop();
      if (media.matches || !("IntersectionObserver" in window)) return;

      const reveal = (surface: HTMLElement) => {
        surfaces.add(surface);
        const { top } = surface.getBoundingClientRect();
        if (top < window.innerHeight * 0.94) {
          surface.dataset.inView = "true";
          observer?.unobserve(surface);
          return;
        }
        observer?.observe(surface);
      };
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            if (!(entry.target instanceof HTMLElement)) return;
            entry.target.dataset.inView = "true";
            observer?.unobserve(entry.target);
          });
        },
        { rootMargin: "0px 0px -8%", threshold: 0.08 }
      );
      surfaces.forEach(reveal);
      root.dataset.motion = "enabled";
      mutations = new MutationObserver((records) => {
        records.forEach((record) => {
          record.addedNodes.forEach((node) => {
            if (!(node instanceof HTMLElement)) return;
            if (node.matches("[data-reveal]")) reveal(node);
            node.querySelectorAll<HTMLElement>("[data-reveal]").forEach(reveal);
          });
        });
      });
      mutations.observe(document.body, { childList: true, subtree: true });
    };

    start();
    media.addEventListener("change", start);
    return () => {
      media.removeEventListener("change", start);
      stop();
    };
  }, [pathname]);

  return null;
}
