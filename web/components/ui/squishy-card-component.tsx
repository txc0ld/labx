"use client";

import { motion, type Variants } from "framer-motion";
import React, { useState, useSyncExternalStore } from "react";
import type { Pack, PackName } from "@/lib/seed";

type SquishyPackCardProps = {
  pack: Pick<Pack, "name" | "priceUsdc" | "bonusEntries" | "remaining">;
  feeUsdc: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (pack: PackName) => void;
};

const PACK_ACCENTS: Record<PackName, "#b9ff87" | "#b37df6" | "#ff79c0"> = {
  Entry: "#b9ff87",
  Bronze: "#b37df6",
  Silver: "#ff79c0",
  Gold: "#b9ff87",
  Platinum: "#b37df6"
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
      style={{ backgroundColor: PACK_ACCENTS[pack.name] }}
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
          <strong>{pack.name}</strong>
          <span className="squishy-pack-choice" aria-hidden="true">
            {selected ? "Selected" : "Select"}
          </span>
        </span>
        <span className="squishy-pack-price">
          {pack.priceUsdc}
          <small> USDC</small>
        </span>
        <span className="squishy-pack-entries">
          {pack.bonusEntries} bonus {entriesLabel}
        </span>
        <span className="squishy-pack-details">
          <span>+{feeUsdc} USDC fee</span>
          <span>{pack.remaining > 0 ? `${pack.remaining} remaining` : "Sold out"}</span>
        </span>
      </span>

      <motion.svg
        className="squishy-pack-background"
        viewBox="0 0 320 240"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        variants={backgroundVariants}
        transition={transition}
      >
        <motion.circle
          cx="160"
          cy="72"
          r="76"
          fill="#f8f9fa"
          variants={circleVariants}
          transition={reduceMotion ? transition : { ...springyTransition, delay: 0.12 }}
        />
        <motion.ellipse
          cx="160"
          cy="190"
          rx="78"
          ry="34"
          fill="#f8f9fa"
          variants={ellipseVariants}
          transition={reduceMotion ? transition : { ...springyTransition, delay: 0.12 }}
        />
      </motion.svg>
    </motion.label>
  );
}

export default SquishyPackCard;
