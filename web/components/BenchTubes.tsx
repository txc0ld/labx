"use client";

import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  boxOf,
  fmt,
  hubRoutes,
  roundedOrtho,
  type FittingKind,
  type Point,
  type Spoke,
  type TubeState
} from "@/lib/tubes";

const KEYS = ["hero", "left", "well", "right", "p0", "p1", "p2", "p3"] as const;

type Frame = {
  w: number;
  h: number;
  bend: number;
  fittingLen: number;
  fittingDia: number;
  spokes: Spoke[];
};

function readToken(name: string, fallback: number) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function BenchTubes({ state = "idle" }: { state?: TubeState }) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [frame, setFrame] = useState<Frame>({
    w: 0,
    h: 0,
    bend: 24,
    fittingLen: 26,
    fittingDia: 18,
    spokes: []
  });
  const ids = {
    glass: `${uid}-tubeGlassGrad`,
    liquid: `${uid}-tubeLiquidGrad`,
    liquidActive: `${uid}-tubeLiquidActive`,
    chrome: `${uid}-fittingChrome`,
    ceramic: `${uid}-fittingCeramic`,
    softGlow: `${uid}-tubeSoftGlow`,
    coreGlow: `${uid}-tubeCoreGlow`
  };
  const tubeStyle = {
    "--tube-glass-stroke": `url(#${ids.glass})`,
    "--tube-liquid-stroke": `url(#${ids.liquid})`,
    "--tube-liquid-active": `url(#${ids.liquidActive})`,
    "--tube-soft-glow": `url(#${ids.softGlow})`,
    "--tube-core-glow": `url(#${ids.coreGlow})`,
    "--fitting-chrome": `url(#${ids.chrome})`,
    "--fitting-ceramic": `url(#${ids.ceramic})`
  } as CSSProperties;

  useLayoutEffect(() => {
    const svg = svgRef.current;
    const host = svg?.closest(".bench");
    if (!svg || !(host instanceof HTMLElement)) return;

    const measure = () => {
      const rootBox = host.getBoundingClientRect();
      const boxes: Record<string, ReturnType<typeof boxOf>> = {};
      KEYS.forEach((key) => {
        const el = host.querySelector(`[data-tube="${key}"]`);
        if (el) boxes[key] = boxOf(rootBox, el);
      });
      host.setAttribute("data-tube-state", state);
      setFrame({
        w: rootBox.width,
        h: rootBox.height,
        bend: readToken("--tube-bend-r", 24),
        fittingLen: readToken("--fitting-len", 26),
        fittingDia: readToken("--fitting-dia", 18),
        spokes: hubRoutes(boxes)
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    host.querySelectorAll("[data-tube]").forEach((node) => observer.observe(node));
    window.addEventListener("resize", measure);
    const settle = requestAnimationFrame(() => requestAnimationFrame(measure));
    const later = window.setTimeout(measure, 120);
    const late = window.setTimeout(measure, 400);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(settle);
      window.clearTimeout(later);
      window.clearTimeout(late);
    };
  }, [state]);

  return (
    <svg
      ref={svgRef}
      className="bench-tubes"
      viewBox={frame.w ? `0 0 ${frame.w} ${frame.h}` : "0 0 1 1"}
      aria-hidden="true"
      focusable="false"
      style={tubeStyle}
    >
      <TubeDefs ids={ids} />
      {frame.spokes.map((spoke, index) => (
        <LabTube
          key={`spoke-${index}`}
          d={roundedOrtho(spoke.pts, frame.bend)}
          from={spoke.from}
          to={spoke.to}
          fitFrom={spoke.fitFrom ? spoke.fit : false}
          fitTo={spoke.fitTo ? (spoke.fit === "ceramic" ? "chrome" : "ceramic") : false}
          fromAngle={spoke.fa}
          toAngle={spoke.ta}
          fittingLen={frame.fittingLen}
          fittingDia={frame.fittingDia}
        />
      ))}
    </svg>
  );
}

function TubeDefs({
  ids
}: {
  ids: {
    glass: string;
    liquid: string;
    liquidActive: string;
    chrome: string;
    ceramic: string;
    softGlow: string;
    coreGlow: string;
  };
}) {
  return (
    <defs>
      <linearGradient id={ids.glass} x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
        <stop offset="0.18" stopColor="#e8ffc8" stopOpacity="0.9" />
        <stop offset="0.42" stopColor="#b9ff87" stopOpacity="0.72" />
        <stop offset="0.62" stopColor="#8ad86a" stopOpacity="0.78" />
        <stop offset="0.82" stopColor="#d4ff9e" stopOpacity="0.88" />
        <stop offset="1" stopColor="#5aa63a" stopOpacity="0.85" />
      </linearGradient>
      <linearGradient id={ids.liquid} x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">
        <stop offset="0" stopColor="#8fffb6" />
        <stop offset="0.25" stopColor="#d8ff9a" />
        <stop offset="0.5" stopColor="#b9ff87" />
        <stop offset="0.75" stopColor="#f4ffe4" />
        <stop offset="1" stopColor="#8fffb6" />
      </linearGradient>
      <linearGradient id={ids.liquidActive} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#b9ff87" />
        <stop offset="0.35" stopColor="#ffffff" />
        <stop offset="0.65" stopColor="#8fffb6" />
        <stop offset="1" stopColor="#b9ff87" />
      </linearGradient>
      <linearGradient id={ids.chrome} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.18" stopColor="#e8ecf2" />
        <stop offset="0.4" stopColor="#9aa6b8" />
        <stop offset="0.58" stopColor="#f7f8fb" />
        <stop offset="0.78" stopColor="#6e7888" />
        <stop offset="1" stopColor="#c5ceda" />
      </linearGradient>
      <linearGradient id={ids.ceramic} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.45" stopColor="#f4eaff" />
        <stop offset="1" stopColor="#d4c2f3" />
      </linearGradient>
      <filter id={ids.softGlow} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b" />
        <feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.85 0" result="b2" />
        <feMerge>
          <feMergeNode in="b2" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id={ids.coreGlow} x="-60%" y="-60%" width="220%" height="220%" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

function LabTube({
  d,
  from,
  to,
  fitFrom,
  fitTo,
  fromAngle,
  toAngle,
  fittingLen,
  fittingDia
}: {
  d: string;
  from: Point;
  to: Point;
  fitFrom: FittingKind | false;
  fitTo: FittingKind | false;
  fromAngle: number;
  toAngle: number;
  fittingLen: number;
  fittingDia: number;
}) {
  if (!d) return null;
  return (
    <g className="lab-tube-group">
      <path className="lab-tube lab-tube-glow" d={d} />
      <path className="lab-tube lab-tube-rim" d={d} />
      <path className="lab-tube lab-tube-glass" d={d} />
      <path className="lab-tube lab-tube-liquid" d={d} />
      <path className="lab-tube lab-tube-reflect" d={d} transform="translate(0.9 -1.0)" />
      <path className="lab-tube lab-tube-specular" d={d} transform="translate(-0.7 -1.6)" />
      <path className="lab-tube lab-tube-flow" d={d} />
      {fitFrom ? (
        <TubeFitting x={from.x} y={from.y} rotationDeg={fromAngle} kind={fitFrom} length={fittingLen} diameter={fittingDia} />
      ) : null}
      {fitTo ? (
        <TubeFitting x={to.x} y={to.y} rotationDeg={toAngle} kind={fitTo} length={fittingLen} diameter={fittingDia} />
      ) : null}
    </g>
  );
}

function TubeFitting({
  x,
  y,
  rotationDeg,
  kind,
  length,
  diameter
}: {
  x: number;
  y: number;
  rotationDeg: number;
  kind: FittingKind;
  length: number;
  diameter: number;
}) {
  const hx = length / 2;
  const hy = diameter / 2;
  const rx = Math.min(4, hy);
  const portR = Math.max(2.4, diameter * 0.22);
  const coreR = Math.max(1.2, diameter * 0.12);
  return (
    <g className="fitting" transform={`translate(${fmt(x)} ${fmt(y)}) rotate(${fmt(rotationDeg)})`}>
      <rect className="fitting-flange" x={-hx - 2} y={-hy - 2.5} width="5" height={diameter + 5} rx="1.5" />
      <rect
        className={kind === "ceramic" ? "fitting-collar" : "fitting-body"}
        x={-hx}
        y={-hy}
        width={length}
        height={diameter}
        rx={rx}
      />
      <line className="fitting-groove" x1={-hx + 5} y1={-hy * 0.35} x2={hx - 5} y2={-hy * 0.35} />
      <line className="fitting-groove-hi" x1={-hx + 5} y1={-hy * 0.35 - 0.8} x2={hx - 5} y2={-hy * 0.35 - 0.8} />
      <line className="fitting-groove" x1={-hx + 5} y1="0" x2={hx - 5} y2="0" />
      <line className="fitting-groove" x1={-hx + 5} y1={hy * 0.35} x2={hx - 5} y2={hy * 0.35} />
      <line className="fitting-groove-hi" x1={-hx + 5} y1={hy * 0.35 - 0.8} x2={hx - 5} y2={hy * 0.35 - 0.8} />
      <circle className="fitting-port" cx={hx - 1} cy="0" r={portR} />
      <circle className="fitting-core" cx={hx - 1} cy="0" r={coreR} />
      <circle className="fitting-screw" cx={-hx + 3.5} cy={-hy + 3.2} r="1.5" />
      <circle className="fitting-screw" cx={-hx + 3.5} cy={hy - 3.2} r="1.5" />
    </g>
  );
}
