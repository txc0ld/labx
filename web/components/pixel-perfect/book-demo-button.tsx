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

const BookDemoButton = React.forwardRef<HTMLButtonElement, BookDemoButtonProps>(
  ({ className, children, variant = "lime", style, ...props }, ref) => (
    <button
      ref={ref}
      className={["btn bd-root", className].filter(Boolean).join(" ")}
      style={{ background: variantStyles[variant].color, color: variantStyles[variant].dot, ...style }}
      {...props}
    >
      <span>{children || "Continue"}</span>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 8h10M8 3l5 5-5 5" />
      </svg>
    </button>
  ),
);

BookDemoButton.displayName = "BookDemoButton";
export default BookDemoButton;
