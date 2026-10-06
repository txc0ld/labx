"use client";

import { motion, type Variants } from "framer-motion";
import React, { useState, useSyncExternalStore, type CSSProperties } from "react";
import type { Pack, PackName } from "@/lib/seed";

type SquishyPackCardProps = {
  pack: Pick<Pack, "name" | "priceUsdc" | "bonusEntries" | "remaining">;
  feeUsdc: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (pack: PackName) => void;
};

const PACK_STYLES: Record<PackName, CSSProperties> = {
  Entry: {
    backgroundColor: "#B37DF6",
    backgroundImage: "linear-gradient(125deg, #9E68DD 0%, #D8BAFF 45%, #B37DF6 100%)",
    color: "#000000"
  },
  Bronze: {
    backgroundColor: "#B8753A",
    backgroundImage: "linear-gradient(125deg, #B8753A 0%, #EAC098 45%, #C78A50 100%)",
    color: "#000000"
  },
  Silver: {
    backgroundColor: "#CCCCCC",
    backgroundImage: "linear-gradient(125deg, #AAAEB5 0%, #F2F3F5 45%, #C0C4CA 100%)",
    color: "#000000"
  },
  Gold: {
    backgroundColor: "#FDBD29",
    backgroundImage: "linear-gradient(125deg, #D49A19 0%, #FFE7A3 45%, #FDBD29 100%)",
    color: "#000000"
  },
  Platinum: {
    backgroundColor: "#CCFF00",
    backgroundImage: "linear-gradient(125deg, #A3CC00 0%, #E9FF91 45%, #CCFF00 100%)",
    color: "#000000"
  }
};

const PACK_HEADING_COLORS: Record<PackName, string> = {
  Entry: "#CCFF00",
  Bronze: "#FFE3BD",
  Silver: "#B37DF6",
  Gold: "#FFF4B8",
  Platinum: "#FF79C0"
};

const cardVariants: Variants = {
  rest: { scale: 1 },
  hover: { scale: 1.025 }
};

const backgroundVariants: Variants = {
  rest: { scale: 1 },
  hover: { scale: 1.35 }
};

const circleVariants: Variants = {
  rest: { scaleY: 1, y: 0 },
  hover: { scaleY: 0.55, y: -16 }
};

const ellipseVariants: Variants = {
  rest: { scaleY: 1, y: 0 },
  hover: { scaleY: 2.05, y: -16 }
};

const springyTransition = {
  duration: 0.8,
  ease: "backInOut" as const
};

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void) {
  const mediaQuery = window.matchMedia(reducedMotionQuery);
  mediaQuery.addEventListener("change", onChange);
  return () => mediaQuery.removeEventListener("change", onChange);
}

function reducedMotionSnapshot() {
  return window.matchMedia(reducedMotionQuery).matches;
}

function serverReducedMotionSnapshot() {
  return false;
}

export function SquishyPackCard({
  pack,
  feeUsdc,
  selected,
  disabled,
  onSelect
}: SquishyPackCardProps) {
  const reduceMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    serverReducedMotionSnapshot
  );
  const [focused, setFocused] = useState(false);
  const activeVariant = !reduceMotion && !disabled && focused ? "hover" : "rest";
  const interactiveVariant = !reduceMotion && !disabled ? "hover" : undefined;
  const transition = reduceMotion ? { duration: 0, delay: 0 } : springyTransition;
  const entriesLabel = pack.bonusEntries === 1 ? "entry" : "entries";

  return (
    <motion.label
      className="squishy-pack-card"
      style={PACK_STYLES[pack.name]}
      data-selected={selected ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      variants={cardVariants}
      initial="rest"
      animate={activeVariant}
      whileHover={interactiveVariant}
      transition={transition}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
    >
      <input
        className="sr squishy-pack-radio"
        type="radio"
        name="membership-pack"
        value={pack.name}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(pack.name)}
      />

      <span className="squishy-pack-content">
        <span className="squishy-pack-topline">
          <strong style={{ color: PACK_HEADING_COLORS[pack.name] }}>{pack.name}</strong>
          <span className="squishy-pack-choice" aria-hidden="true">
            {disabled ? "Unavailable" : selected ? "Your pick" : "Pick me"}
          </span>
        </span>
        <span className="squishy-pack-body">
          <span className="squishy-pack-info">
            <span className="squishy-pack-price">
              {pack.priceUsdc}
              <small> USDC</small>
            </span>
            <span className="squishy-pack-entries">
              {pack.bonusEntries} bonus {entriesLabel}
            </span>
          </span>
          <motion.svg
            className="squishy-pack-background"
            viewBox="0 0 160 200"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            focusable="false"
            variants={backgroundVariants}
            transition={transition}
          >
            <motion.circle
              cx="80"
              cy="58"
              r="52"
              fill="#000000"
              variants={circleVariants}
              transition={reduceMotion ? transition : { ...springyTransition, delay: 0.12 }}
            />
            <motion.ellipse
              cx="80"
              cy="152"
              rx="52"
              ry="23"
              fill="#000000"
              variants={ellipseVariants}
              transition={reduceMotion ? transition : { ...springyTransition, delay: 0.12 }}
            />
          </motion.svg>
        </span>
        <span className="squishy-pack-details">
          <span>+{feeUsdc} USDC fee</span>
          <span>{pack.remaining > 0 ? `${pack.remaining} remaining` : "Sold out"}</span>
        </span>
      </span>
    </motion.label>
  );
}

export default SquishyPackCard;
