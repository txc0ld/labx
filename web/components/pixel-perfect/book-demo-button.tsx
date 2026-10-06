"use client";
import React from "react";

export type BookDemoVariant =
  | "lime"
  | "sky"
  | "rose"
  | "amber"
  | "emerald"
  | "violet"
  | "orange"
  | "magenta";

interface BookDemoButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BookDemoVariant;
}

const variantStyles: Record<
  BookDemoVariant,
  { color: string; dot: string }
> = {
  lime: { color: "#b9ff87", dot: "#0f0f0f" },
  sky: { color: "#a5e0ff", dot: "#0a1f3a" },
  rose: { color: "#ffc4d3", dot: "#3a0a1f" },
  amber: { color: "#ffd66e", dot: "#3a210a" },
  emerald: { color: "#a8efc5", dot: "#0a2a1a" },
  violet: { color: "#b37df6", dot: "#1f0a3a" },
  orange: { color: "#ffb88a", dot: "#3a190a" },
  magenta: { color: "#f5a8e0", dot: "#3a0a2a" },
};

const DoubleChevron = ({ index, color }: { index: number; color: string }) => {
  const base = index * 0.12;
  const dots: { cx: number; cy: number; d: number }[] = [
    { cx: 2, cy: 2, d: 0 },
    { cx: 5, cy: 5, d: 0.05 },
    { cx: 8, cy: 8, d: 0.1 },
    { cx: 5, cy: 11, d: 0.15 },
    { cx: 2, cy: 14, d: 0.2 },
    { cx: 6, cy: 2, d: 0.05 },
    { cx: 9, cy: 5, d: 0.1 },
    { cx: 12, cy: 8, d: 0.15 },
    { cx: 9, cy: 11, d: 0.2 },
    { cx: 6, cy: 14, d: 0.25 },
  ];
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="16"
      viewBox="0 0 14 16"
      className="shrink-0 overflow-visible"
    >
      <g fill={color}>
        {dots.map((p, i) => (
          <circle
            key={i}
            cx={p.cx}
            cy={p.cy}
            r="1"
            className="bd-dot"
            style={{ animationDelay: `${base + p.d}s` }}
          />
        ))}
      </g>
    </svg>
  );
};

const BookDemoButton = React.forwardRef<HTMLButtonElement, BookDemoButtonProps>(
  ({ className, children, variant = "lime", ...props }, ref) => {
    const v = variantStyles[variant];
    return (
      <button
        ref={ref}
        className={[
          "group/btn bd-root disabled:pointer-events-none disabled:opacity-50 relative inline-flex min-h-11 w-36 rounded-[12px] overflow-hidden transition-transform active:scale-[0.97]",
          className,
        ].filter(Boolean).join(" ")}
        style={{
          background: "#242326",
          borderRadius: 18,
          boxShadow: "var(--control-dark-bevel)",
        }}
        {...props}
      >
        <style>{`
          @keyframes bd-dot-wave {
            0%, 65%, 100% { opacity: 0.3; transform: translateX(0) scale(0.8); }
            32% { opacity: 1; transform: translateX(0.5px) scale(1.08); }
          }
          .bd-dot {
            transform-box: fill-box;
            transform-origin: center;
            /* Calm, slow shimmer at rest... */
            animation: bd-dot-wave 1.8s cubic-bezier(0.45,0.05,0.55,0.95) infinite;
          }
          /* ...that springs to life (and marches faster) on hover/focus. */
          .bd-root:hover .bd-dot,
          .bd-root:focus-visible .bd-dot {
            animation-duration: 0.95s;
          }
          @media (prefers-reduced-motion: reduce) {
            .bd-dot { animation: none; opacity: 1; transform: none; }
          }
        `}</style>

        <span className="relative ml-14 mr-4 flex min-w-0 flex-1 items-center justify-center py-2 text-center text-white font-medium text-[14px] leading-tight break-words tracking-tight transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/btn:translate-x-2 group-hover/btn:opacity-0 group-focus-visible/btn:translate-x-2 group-focus-visible/btn:opacity-0 motion-reduce:transition-none">
          {children || "Continue"}
        </span>

        <span
          className="absolute top-1 left-1 bottom-1 z-10 w-9 group-hover/btn:w-[calc(100%-0.5rem)] group-focus-visible/btn:w-[calc(100%-0.5rem)] group-active/btn:w-[calc(100%-0.5rem)] flex items-center justify-start overflow-hidden rounded-xl pl-3 pr-2.5 gap-2.5 transition-[width,gap] duration-260 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{
            background: v.color,
            borderRadius: 14,
            boxShadow: "var(--control-bevel)",
          }}
        >
          <DoubleChevron index={0} color={v.dot} />
          <DoubleChevron index={1} color={v.dot} />
          <DoubleChevron index={2} color={v.dot} />
          <DoubleChevron index={3} color={v.dot} />
          <DoubleChevron index={4} color={v.dot} />
        </span>
      </button>
    );
  },
);

BookDemoButton.displayName = "BookDemoButton";

export default BookDemoButton;
