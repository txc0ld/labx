export type Point = { x: number; y: number };
export type TubeTone = "lime" | "pink" | "mint" | "purple";
export type JointKind = "port" | "ferrule" | "tee";
export type Joint = Point & { kind: JointKind; angle: number };
export type TubeRun = { d: string; tone: TubeTone; joints: Joint[] };

const TONES: TubeTone[] = ["lime", "mint", "pink", "purple"];

export function fmt(n: number) {
  return n.toFixed(1);
}

export function toneAt(index: number): TubeTone {
  return TONES[index % TONES.length];
}

function len(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function toward(from: Point, to: Point, distance: number): Point {
  const span = len(from, to);
  if (span < 0.001) return { ...from };
  const t = Math.min(distance, span / 2) / span;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function heading(a: Point, b: Point) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

export function roundedPolyline(points: Point[], radius = 28): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${fmt(points[0].x)} ${fmt(points[0].y)} L ${fmt(points[1].x)} ${fmt(points[1].y)}`;
  }
  let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const reach = Math.min(radius, len(prev, corner) / 2, len(corner, next) / 2);
    const enter = toward(corner, prev, reach);
    const leave = toward(corner, next, reach);
    d += ` L ${fmt(enter.x)} ${fmt(enter.y)} Q ${fmt(corner.x)} ${fmt(corner.y)} ${fmt(leave.x)} ${fmt(leave.y)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
  return d;
}

export function roundedOrtho(points: Point[], radius = 28): string {
  return roundedPolyline(points, radius);
}

export function elbowPoints(from: Point, to: Point, first: "h" | "v"): Point[] {
  const mid = first === "h" ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  if (len(from, mid) < 2 || len(mid, to) < 2) return [from, to];
  return [from, mid, to];
}

export function jointsAlong(points: Point[]): Joint[] {
  return points.map((point, index) => {
    const prev = points[index - 1];
    const next = points[index + 1];
    const angle = prev ? heading(prev, point) : next ? heading(point, next) : 0;
    return {
      ...point,
      angle,
      kind: index === 0 || index === points.length - 1 ? "port" : points.length > 3 && index === 1 ? "tee" : "ferrule"
    };
  });
}

export function makeRun(points: Point[], index: number, radius = 28): TubeRun | null {
  const usable = points.filter((point, i) => i === 0 || len(point, points[i - 1]) > 1);
  if (usable.length < 2) return null;
  return {
    d: roundedOrtho(usable, radius),
    tone: toneAt(index),
    joints: jointsAlong(usable)
  };
}
