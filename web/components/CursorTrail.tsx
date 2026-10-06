"use client";

import { useEffect, useState } from "react";
import PixelCursorTrail from "./pixel-perfect/pixel-cursor-trail";

export function CursorTrail() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!("ResizeObserver" in window) || !("animate" in Element.prototype)) return;
    const preference = window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
    const update = () => setEnabled(preference.matches && !document.hidden);
    update();
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return enabled ? <div className="cursor-trail-layer" aria-hidden="true"><PixelCursorTrail /></div> : null;
}
