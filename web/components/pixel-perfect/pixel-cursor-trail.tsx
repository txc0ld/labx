"use client";

import { useEffect, useRef, useState } from "react";

const COLUMNS = 20;

const PixelCursorTrail = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cellsRef = useRef<(HTMLDivElement | null)[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const blockSize = size.width / COLUMNS;
  const rows = blockSize > 0 ? Math.ceil(size.height / blockSize) : 0;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ width, height });
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (blockSize <= 0) return;

    const animations = new Set<Animation>();
    const colorize = (cell: HTMLDivElement) => {
      cell.getAnimations().forEach((animation) => animation.cancel());
      const animation = cell.animate(
        [{ backgroundColor: getComputedStyle(cell).color }, { backgroundColor: "transparent" }],
        { duration: 600, easing: "ease-out" },
      );
      animations.add(animation);
      animation.onfinish = animation.oncancel = () => animations.delete(animation);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;

      const col = Math.floor(x / blockSize);
      const row = Math.floor(y / blockSize);
      const cell = cellsRef.current[col * rows + row];
      if (cell) colorize(cell);
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      animations.forEach((animation) => animation.cancel());
      animations.clear();
    };
  }, [blockSize, rows]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden select-none"
    >
      <div className="absolute inset-0 flex">
        {size.width > 0 &&
          Array.from({ length: COLUMNS }).map((_, col) => (
            <div key={col} className="flex flex-1 flex-col">
              {Array.from({ length: rows }).map((_, row) => (
                <div
                  key={row}
                  ref={(node) => {
                    cellsRef.current[col * rows + row] = node;
                  }}
                  className="w-full"
                  style={{ height: blockSize, backgroundColor: "transparent" }}
                />
              ))}
            </div>
          ))}
      </div>
    </div>
  );
};

export default PixelCursorTrail;
