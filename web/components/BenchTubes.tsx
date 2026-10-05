"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";

type Box = { x: number; y: number; w: number; h: number };

const KEYS = ["hero", "left", "well", "right", "p0", "p1", "p2", "p3"] as const;

function boxOf(root: DOMRect, node: Element): Box {
  const rect = node.getBoundingClientRect();
  return { x: rect.left - root.left, y: rect.top - root.top, w: rect.width, h: rect.height };
}

function point(box: Box, edge: "top" | "bottom" | "left" | "right") {
  if (edge === "top") return { x: box.x + box.w / 2, y: box.y };
  if (edge === "bottom") return { x: box.x + box.w / 2, y: box.y + box.h };
  if (edge === "left") return { x: box.x, y: box.y + box.h / 2 };
  return { x: box.x + box.w, y: box.y + box.h / 2 };
}

function elbow(from: { x: number; y: number }, to: { x: number; y: number }, first: "h" | "v") {
  if (first === "h") return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} H ${to.x.toFixed(1)} V ${to.y.toFixed(1)}`;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} V ${to.y.toFixed(1)} H ${to.x.toFixed(1)}`;
}

export function BenchTubes() {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [frame, setFrame] = useState<{ w: number; h: number; paths: string[] }>({ w: 0, h: 0, paths: [] });

  useLayoutEffect(() => {
    const svg = svgRef.current;
    const host = svg?.closest(".bench");
    if (!svg || !(host instanceof HTMLElement)) return;

    const measure = () => {
      const rootBox = host.getBoundingClientRect();
      const take = (key: string) => {
        const el = host.querySelector(`[data-tube="${key}"]`);
        return el ? boxOf(rootBox, el) : null;
      };
      const hero = take("hero");
      const left = take("left");
      const well = take("well");
      const right = take("right");
      const pieces = KEYS.slice(4).map(take);
      const paths: string[] = [];

      if (hero && well) paths.push(elbow(point(hero, "bottom"), point(well, "top"), "v"));
      if (hero && left) {
        const start = { x: hero.x + hero.w * 0.16, y: hero.y + hero.h };
        const end = point(left, "top");
        paths.push(`M ${start.x.toFixed(1)} ${start.y.toFixed(1)} V ${(start.y + 26).toFixed(1)} H ${end.x.toFixed(1)} V ${end.y.toFixed(1)}`);
      }
      if (hero && right) {
        const start = { x: hero.x + hero.w * 0.84, y: hero.y + hero.h };
        const end = point(right, "top");
        paths.push(`M ${start.x.toFixed(1)} ${start.y.toFixed(1)} V ${(start.y + 26).toFixed(1)} H ${end.x.toFixed(1)} V ${end.y.toFixed(1)}`);
      }
      if (left && well) paths.push(elbow(point(left, "right"), point(well, "left"), "h"));
      if (right && well) paths.push(elbow(point(well, "right"), point(right, "left"), "h"));
      const present = pieces.filter((box): box is Box => Boolean(box));
      if (present.length) {
        const manifoldY = Math.min(...present.map((box) => box.y)) - 24;
        if (well) {
          const start = point(well, "bottom");
          paths.push(`M ${start.x.toFixed(1)} ${start.y.toFixed(1)} V ${manifoldY.toFixed(1)}`);
        }
        if (left) {
          const start = point(left, "bottom");
          paths.push(`M ${start.x.toFixed(1)} ${start.y.toFixed(1)} V ${manifoldY.toFixed(1)}`);
        }
        if (right) {
          const start = point(right, "bottom");
          paths.push(`M ${start.x.toFixed(1)} ${start.y.toFixed(1)} V ${manifoldY.toFixed(1)}`);
        }
        const first = point(present[0], "top");
        const last = point(present[present.length - 1], "top");
        paths.push(`M ${first.x.toFixed(1)} ${manifoldY.toFixed(1)} H ${last.x.toFixed(1)}`);
        present.forEach((box) => {
          const top = point(box, "top");
          paths.push(`M ${top.x.toFixed(1)} ${manifoldY.toFixed(1)} V ${top.y.toFixed(1)}`);
        });
      }

      setFrame({ w: rootBox.width, h: rootBox.height, paths });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    host.querySelectorAll("[data-tube]").forEach((node) => observer.observe(node));
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const chrome = `tube-chrome-${uid}`;
  const glow = `tube-glow-${uid}`;

  return (
    <svg ref={svgRef} className="bench-tubes" viewBox={frame.w ? `0 0 ${frame.w} ${frame.h}` : "0 0 1 1"} role="img" aria-label="Fluoro chrome tubes linking the bench panels">
      <title>Fluoro chrome tubes linking the bench panels</title>
      <defs>
        <linearGradient id={chrome} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4ffe4" />
          <stop offset="0.22" stopColor="#b9ff87" />
          <stop offset="0.48" stopColor="#ffffff" />
          <stop offset="0.72" stopColor="#8fffb6" />
          <stop offset="1" stopColor="#5aa63a" />
        </linearGradient>
        <filter id={glow} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {frame.paths.map((d, index) => (
        <g key={`${d}-${index}`} filter={`url(#${glow})`}>
          <path className="tube-shell" d={d} />
          <path className="tube-body" d={d} stroke={`url(#${chrome})`} />
          <path className="tube-shine" d={d} />
        </g>
      ))}
    </svg>
  );
}
