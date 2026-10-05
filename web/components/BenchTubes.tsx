"use client";

import { useId, useLayoutEffect, useState, type RefObject } from "react";

type Box = { x: number; y: number; w: number; h: number };

export type TubeNode = "hero" | "left" | "well" | "right" | "p0" | "p1" | "p2" | "p3";

function boxOf(root: DOMRect, node: Element): Box {
  const rect = node.getBoundingClientRect();
  return { x: rect.left - root.left, y: rect.top - root.top, w: rect.width, h: rect.height };
}

function point(box: Box, edge: "top" | "bottom" | "left" | "right" | "center") {
  if (edge === "top") return { x: box.x + box.w / 2, y: box.y };
  if (edge === "bottom") return { x: box.x + box.w / 2, y: box.y + box.h };
  if (edge === "left") return { x: box.x, y: box.y + box.h / 2 };
  if (edge === "right") return { x: box.x + box.w, y: box.y + box.h / 2 };
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function elbow(
  from: { x: number; y: number },
  to: { x: number; y: number },
  first: "h" | "v"
) {
  if (first === "h") return `M ${from.x} ${from.y} H ${to.x} V ${to.y}`;
  return `M ${from.x} ${from.y} V ${to.y} H ${to.x}`;
}

export function BenchTubes({
  root,
  nodes
}: {
  root: RefObject<HTMLElement | null>;
  nodes: RefObject<Partial<Record<TubeNode, HTMLElement | null>>>;
}) {
  const uid = useId().replace(/:/g, "");
  const [frame, setFrame] = useState<{ w: number; h: number; paths: string[] }>({ w: 0, h: 0, paths: [] });

  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;

    const measure = () => {
      if (!root.current) return;
      const rootBox = root.current.getBoundingClientRect();
      const map = nodes.current;
      const take = (key: TubeNode) => {
        const el = map?.[key];
        return el ? boxOf(rootBox, el) : null;
      };
      const hero = take("hero");
      const left = take("left");
      const well = take("well");
      const right = take("right");
      const pieces = [take("p0"), take("p1"), take("p2"), take("p3")];
      const paths: string[] = [];

      if (hero && well) {
        paths.push(elbow(point(hero, "bottom"), point(well, "top"), "v"));
      }
      if (hero && left) {
        const start = { x: hero.x + hero.w * 0.18, y: hero.y + hero.h };
        const end = point(left, "top");
        paths.push(`M ${start.x} ${start.y} V ${start.y + 28} H ${end.x} V ${end.y}`);
      }
      if (hero && right) {
        const start = { x: hero.x + hero.w * 0.82, y: hero.y + hero.h };
        const end = point(right, "top");
        paths.push(`M ${start.x} ${start.y} V ${start.y + 28} H ${end.x} V ${end.y}`);
      }
      if (left && well) paths.push(elbow(point(left, "right"), point(well, "left"), "h"));
      if (right && well) paths.push(elbow(point(well, "right"), point(right, "left"), "h"));
      if (well && pieces[1] && pieces[2]) {
        const mid = {
          x: (pieces[1].x + pieces[1].w + pieces[2].x) / 2,
          y: Math.min(pieces[1].y, pieces[2].y)
        };
        paths.push(elbow(point(well, "bottom"), mid, "v"));
      }
      if (left && pieces[0]) paths.push(elbow(point(left, "bottom"), point(pieces[0], "top"), "v"));
      if (right && pieces[3]) paths.push(elbow(point(right, "bottom"), point(pieces[3], "top"), "v"));
      const present = pieces.filter((box): box is Box => Boolean(box));
      if (present.length > 1) {
        const y = present[0].y - 18;
        const first = point(present[0], "top");
        const last = point(present[present.length - 1], "top");
        paths.push(`M ${first.x} ${first.y} V ${y} H ${last.x} V ${last.y}`);
        present.slice(1, -1).forEach((box) => {
          const top = point(box, "top");
          paths.push(`M ${top.x} ${y} V ${top.y}`);
        });
      }

      setFrame({ w: rootBox.width, h: rootBox.height, paths });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    Object.values(nodes.current ?? {}).forEach((node) => {
      if (node) observer.observe(node);
    });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [nodes, root]);

  if (frame.w < 8 || frame.paths.length === 0) return null;

  const chrome = `tube-chrome-${uid}`;
  const glow = `tube-glow-${uid}`;

  return (
    <svg className="bench-tubes" viewBox={`0 0 ${frame.w} ${frame.h}`} role="img" aria-label="Fluoro chrome tubes linking the bench panels">
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
        <g key={d + index} filter={`url(#${glow})`}>
          <path className="tube-shell" d={d} />
          <path className="tube-body" d={d} stroke={`url(#${chrome})`} />
          <path className="tube-shine" d={d} />
        </g>
      ))}
    </svg>
  );
}
