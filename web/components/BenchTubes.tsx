"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { elbowPoints, fmt, makeRun, type Joint, type TubeRun, type TubeTone } from "@/lib/tubes";

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

export function BenchTubes() {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [frame, setFrame] = useState<{ w: number; h: number; runs: TubeRun[] }>({ w: 0, h: 0, runs: [] });

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
      const drafts: TubeRun[] = [];
      const push = (points: { x: number; y: number }[]) => {
        const run = makeRun(points, drafts.length);
        if (run) drafts.push(run);
      };

      if (hero && well) push(elbowPoints(point(hero, "bottom"), point(well, "top"), "v"));
      if (hero && left) {
        const start = { x: hero.x + hero.w * 0.16, y: hero.y + hero.h };
        const drop = { x: start.x, y: start.y + 28 };
        const end = point(left, "top");
        push([start, drop, { x: end.x, y: drop.y }, end]);
      }
      if (hero && right) {
        const start = { x: hero.x + hero.w * 0.84, y: hero.y + hero.h };
        const drop = { x: start.x, y: start.y + 28 };
        const end = point(right, "top");
        push([start, drop, { x: end.x, y: drop.y }, end]);
      }
      if (left && well) push(elbowPoints(point(left, "right"), point(well, "left"), "h"));
      if (right && well) push(elbowPoints(point(well, "right"), point(right, "left"), "h"));
      const present = pieces.filter((box): box is Box => Boolean(box));
      if (present.length) {
        const manifoldY = Math.min(...present.map((box) => box.y)) - 28;
        if (well) push(elbowPoints(point(well, "bottom"), { x: point(well, "bottom").x, y: manifoldY }, "v"));
        if (left) push(elbowPoints(point(left, "bottom"), { x: point(left, "bottom").x, y: manifoldY }, "v"));
        if (right) push(elbowPoints(point(right, "bottom"), { x: point(right, "bottom").x, y: manifoldY }, "v"));
        const first = point(present[0], "top");
        const last = point(present[present.length - 1], "top");
        push([
          { x: first.x, y: manifoldY },
          { x: last.x, y: manifoldY }
        ]);
        present.forEach((box) => {
          const top = point(box, "top");
          push([
            { x: top.x, y: manifoldY },
            top
          ]);
        });
      }

      setFrame({ w: rootBox.width, h: rootBox.height, runs: drafts });
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

  const chrome = `lab-tube-chrome-${uid}`;
  const enamel = `lab-tube-enamel-${uid}`;

  return (
    <svg
      ref={svgRef}
      className="bench-tubes"
      viewBox={frame.w ? `0 0 ${frame.w} ${frame.h}` : "0 0 1 1"}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={chrome} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.16" stopColor="#d7deea" />
          <stop offset="0.38" stopColor="#f8f9fc" />
          <stop offset="0.55" stopColor="#8e97a8" />
          <stop offset="0.76" stopColor="#f3f5f8" />
          <stop offset="1" stopColor="#6e7888" />
        </linearGradient>
        <linearGradient id={enamel} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fcf9ff" />
          <stop offset="0.42" stopColor="#e6d8fa" />
          <stop offset="1" stopColor="#d4ded2" />
        </linearGradient>
      </defs>
      {frame.runs.map((run, index) => (
        <TubeSpoke key={`${run.tone}-${index}`} run={run} chrome={chrome} enamel={enamel} />
      ))}
    </svg>
  );
}

function TubeSpoke({ run, chrome, enamel }: { run: TubeRun; chrome: string; enamel: string }) {
  return (
    <g className={`lab-tube lab-tube-${run.tone}`}>
      <path className="lab-tube-shadow" d={run.d} transform="translate(2.2 3.4)" />
      <path className="lab-tube-jacket" d={run.d} stroke={`url(#${chrome})`} />
      <path className="lab-tube-enamel" d={run.d} stroke={`url(#${enamel})`} />
      <path className="lab-tube-core" d={run.d} />
      <path className="lab-tube-bore" d={run.d} />
      <path className="lab-tube-reflect" d={run.d} />
      <path className="lab-tube-flow" d={run.d} />
      {run.joints.map((joint, index) => (
        <TubeFitting key={`${joint.kind}-${index}`} joint={joint} tone={run.tone} chrome={chrome} />
      ))}
    </g>
  );
}

function TubeFitting({ joint, tone, chrome }: { joint: Joint; tone: TubeTone; chrome: string }) {
  const port = joint.kind === "port";
  const tee = joint.kind === "tee";
  const halfW = port ? 7.5 : tee ? 7 : 6;
  const halfH = port ? 11 : tee ? 9 : 8;
  const grooves = port ? [-4, 0, 4] : [-2.4, 2.4];
  return (
    <g
      className={`lab-tube-fitting lab-tube-fitting-${joint.kind}`}
      transform={`translate(${fmt(joint.x)} ${fmt(joint.y)}) rotate(${fmt(joint.angle)})`}
    >
      <rect className="lab-tube-fitting-shadow" x={-halfW} y={-halfH + 1.2} width={halfW * 2} height={halfH * 2} rx="3.5" />
      <rect
        className="lab-tube-fitting-body"
        x={-halfW}
        y={-halfH}
        width={halfW * 2}
        height={halfH * 2}
        rx="3.5"
        fill={`url(#${chrome})`}
      />
      <rect
        className="lab-tube-fitting-enamel"
        x={-halfW + 1.5}
        y={-halfH + 2}
        width={halfW * 2 - 3}
        height={halfH * 2 - 4}
        rx="2.4"
      />
      {grooves.map((y) => (
        <path
          key={y}
          className="lab-tube-fitting-groove"
          d={`M ${fmt(-halfW + 2)} ${fmt(y)} L ${fmt(halfW - 2)} ${fmt(y)}`}
        />
      ))}
      {port ? <circle className="lab-tube-fitting-port" r="3.5" /> : null}
      <circle className={`lab-tube-fitting-lamp lab-tube-lamp-${tone}`} r={port ? 1.85 : 1.45} />
    </g>
  );
}
