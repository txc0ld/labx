"use client";

import React, { useEffect, useState } from "react";
import PixelScroll from "./pixel-scroll/pixel-scroll";

const ACCENT_COLORS = ["#b37df6", "#b9ff87", "#ff79c0"];
const DIVIDER_HEIGHT = "clamp(120px, 14vw, 200px)";

export function PixelDivider() {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setAnimated(!preference.matches && "ResizeObserver" in window);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  return (
    <div className="pixel-divider" aria-hidden="true">
      {animated ? (
        <PixelScroll
          pixelSize={50}
          height={DIVIDER_HEIGHT}
          colors={ACCENT_COLORS}
          colorRatio={0.25}
          randomness={0.4}
          direction="sweep"
          className="pixel-divider-canvas"
        />
      ) : (
        <span className="pixel-divider-fallback" />
      )}
    </div>
  );
}
