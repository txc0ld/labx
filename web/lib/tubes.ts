export type Point = { x: number; y: number };
export type TubeTone = "lime" | "mint" | "purple" | "pink";
export type TubeState = "idle" | "active" | "flowing" | "disabled";
export type FittingKind = "chrome" | "ceramic";

export type HubBox = { x: number; y: number; w: number; h: number };

export type Spoke = {
  pts: Point[];
  from: Point;
  to: Point;
  fa: number;
  ta: number;
  fit: FittingKind;
  fitFrom: boolean;
  fitTo: boolean;
};

export function fmt(n: number) {
  return n.toFixed(1);
}

export function boxOf(root: DOMRect, node: Element): HubBox {
  const rect = node.getBoundingClientRect();
  return { x: rect.left - root.left, y: rect.top - root.top, w: rect.width, h: rect.height };
}

export function point(box: HubBox, edge: "top" | "bottom" | "left" | "right", t = 0.5): Point {
  if (edge === "top") return { x: box.x + box.w * t, y: box.y };
  if (edge === "bottom") return { x: box.x + box.w * t, y: box.y + box.h };
  if (edge === "left") return { x: box.x, y: box.y + box.h * t };
  return { x: box.x + box.w, y: box.y + box.h * t };
}

export function angleAt(a: Point, b: Point) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Orthogonal waypoints → fillet with L + Q (no hard H/V kinks). */
export function roundedOrtho(points: Point[], radius: number): string {
  if (points.length < 2) return "";
  const r = Math.max(4, radius);
  let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const dx1 = cur.x - prev.x;
    const dy1 = cur.y - prev.y;
    const dx2 = next.x - cur.x;
    const dy2 = next.y - cur.y;
    const len1 = Math.hypot(dx1, dy1) || 1;
    const len2 = Math.hypot(dx2, dy2) || 1;
    const rr = Math.min(r, len1 / 2, len2 / 2);
    const ax = cur.x - (dx1 / len1) * rr;
    const ay = cur.y - (dy1 / len1) * rr;
    const bx = cur.x + (dx2 / len2) * rr;
    const by = cur.y + (dy2 / len2) * rr;
    d += ` L ${fmt(ax)} ${fmt(ay)} Q ${fmt(cur.x)} ${fmt(cur.y)} ${fmt(bx)} ${fmt(by)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
  return d;
}

export function hubRoutes(boxes: Partial<Record<string, HubBox>>): Spoke[] {
  const routes: Spoke[] = [];
  const { hero, left, well, right, p0, p1, p2, p3 } = boxes;
  const pieces = [p0, p1, p2, p3].filter((box): box is HubBox => Boolean(box));
  const spoke = (
    pts: Point[],
    fit: FittingKind,
    ends: { fitFrom?: boolean; fitTo?: boolean } = {}
  ): Spoke => ({
    pts,
    from: pts[0],
    to: pts[pts.length - 1],
    fa: angleAt(pts[0], pts[1] ?? pts[0]),
    ta: angleAt(pts[pts.length - 2] ?? pts[0], pts[pts.length - 1]),
    fit,
    fitFrom: ends.fitFrom !== false,
    fitTo: ends.fitTo !== false
  });

  if (hero && well) {
    const a = point(hero, "bottom", 0.5);
    const b = point(well, "top", 0.5);
    const midY = a.y + Math.min(40, (b.y - a.y) * 0.35);
    routes.push(spoke([a, { x: a.x, y: midY }, { x: b.x, y: midY }, b], "ceramic"));
  }
  if (hero && left) {
    const a = point(hero, "bottom", 0.16);
    const b = point(left, "top", 0.5);
    const drop = a.y + 28;
    routes.push(spoke([a, { x: a.x, y: drop }, { x: b.x, y: drop }, b], "chrome"));
  }
  if (hero && right) {
    const a = point(hero, "bottom", 0.84);
    const b = point(right, "top", 0.5);
    const drop = a.y + 28;
    routes.push(spoke([a, { x: a.x, y: drop }, { x: b.x, y: drop }, b], "chrome"));
  }
  if (left && well) {
    const a = point(left, "right", 0.45);
    const b = point(well, "left", 0.45);
    const midX = a.x + (b.x - a.x) * 0.5;
    routes.push(spoke([a, { x: midX, y: a.y }, { x: midX, y: b.y }, b], "ceramic"));
  }
  if (right && well) {
    const a = point(well, "right", 0.45);
    const b = point(right, "left", 0.45);
    const midX = a.x + (b.x - a.x) * 0.5;
    routes.push(spoke([a, { x: midX, y: a.y }, { x: midX, y: b.y }, b], "ceramic"));
  }
  if (pieces.length) {
    const manifoldY = Math.min(...pieces.map((box) => box.y)) - 28;
    const tops = pieces.map((box) => point(box, "top", 0.5));
    const railLeft = Math.min(...tops.map((pt) => pt.x));
    const railRight = Math.max(...tops.map((pt) => pt.x));
    if (well) {
      const a = point(well, "bottom", 0.5);
      routes.push(spoke([a, { x: a.x, y: manifoldY }], "chrome", { fitTo: false }));
    }
    if (left) {
      const a = point(left, "bottom", 0.5);
      routes.push(spoke([a, { x: a.x, y: manifoldY }], "chrome", { fitTo: false }));
    }
    if (right) {
      const a = point(right, "bottom", 0.5);
      routes.push(spoke([a, { x: a.x, y: manifoldY }], "chrome", { fitTo: false }));
    }
    routes.push(
      spoke(
        [
          { x: railLeft, y: manifoldY },
          { x: railRight, y: manifoldY }
        ],
        "chrome",
        { fitFrom: false, fitTo: false }
      )
    );
    tops.forEach((top) => {
      routes.push(spoke([{ x: top.x, y: manifoldY }, top], "ceramic", { fitFrom: false, fitTo: true }));
    });
  }
  return routes;
}
