"use client";

import React, { useId, type CSSProperties } from "react";
import type { Pack, PackName } from "@/lib/seed";
import { STANDARD_MEMBERSHIP_TIERS } from "@/lib/membership-tiers";

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
    backgroundImage: "radial-gradient(ellipse at 20% 0%, rgba(255,255,255,.22), transparent 60%), linear-gradient(125deg, #9E68DD 0%, #D8BAFF 45%, #B37DF6 100%)",
    color: "#000000"
  },
  Bronze: {
    backgroundColor: "#B8753A",
    backgroundImage: "radial-gradient(ellipse at 20% 0%, rgba(255,255,255,.22), transparent 60%), linear-gradient(125deg, #B8753A 0%, #EAC098 45%, #C78A50 100%)",
    color: "#000000"
  },
  Silver: {
    backgroundColor: "#CCCCCC",
    backgroundImage: "radial-gradient(ellipse at 20% 0%, rgba(255,255,255,.22), transparent 60%), linear-gradient(125deg, #AAAEB5 0%, #F2F3F5 45%, #C0C4CA 100%)",
    color: "#000000"
  },
  Gold: {
    backgroundColor: "#FDBD29",
    backgroundImage: "radial-gradient(ellipse at 20% 0%, rgba(255,255,255,.22), transparent 60%), linear-gradient(125deg, #D49A19 0%, #FFE7A3 45%, #FDBD29 100%)",
    color: "#000000"
  },
  Platinum: {
    backgroundColor: "#CCFF00",
    backgroundImage: "radial-gradient(ellipse at 20% 0%, rgba(255,255,255,.22), transparent 60%), linear-gradient(125deg, #A3CC00 0%, #E9FF91 45%, #CCFF00 100%)",
    color: "#000000"
  }
};

const PACK_HEADING_COLORS: Record<PackName, string> = {
  Entry: "#46206E",
  Bronze: "#53290C",
  Silver: "#444B56",
  Gold: "#614100",
  Platinum: "#3C4B00"
};

type MembershipPackCardProps = {
  name: string;
  price: string;
  bonusEntries: number;
  remaining: number;
  feeLabel?: string;
  value: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
};

export function MembershipPackCard({ name, price, bonusEntries, remaining, feeLabel, value, selected, disabled, onSelect }: MembershipPackCardProps) {
  const tier = STANDARD_MEMBERSHIP_TIERS.find((candidate) => candidate.toLowerCase() === name.trim().toLowerCase()) ?? "Entry";
  const bubbleFillId = useId();
  const entriesLabel = bonusEntries === 1 ? "entry" : "entries";

  return (
    <label
      className="squishy-pack-card"
      style={PACK_STYLES[tier]}
      data-selected={selected ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
    >
      <input
        className="sr squishy-pack-radio"
        type="radio"
        name="membership-pack"
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />

      <span className="squishy-pack-content">
        <span className="squishy-pack-topline">
          <strong style={{ color: PACK_HEADING_COLORS[tier] }}>{name}</strong>
          {(selected || disabled) && (
            <span className="squishy-pack-choice" aria-hidden="true">
              {disabled ? "Unavailable" : "Your pick"}
            </span>
          )}
        </span>
        <span className="squishy-pack-body">
          <span className="squishy-pack-info">
            <span className="squishy-pack-price">
              {price}
              <small> USDC</small>
            </span>
            <span className="squishy-pack-entries">
              {bonusEntries} bonus {entriesLabel}
            </span>
          </span>
          <svg
            className="squishy-pack-background"
            viewBox="0 0 160 200"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <radialGradient id={bubbleFillId} cx="32%" cy="24%" r="78%">
                <stop offset="0%" stopColor="#626262" />
                <stop offset="24%" stopColor="#272727" />
                <stop offset="68%" stopColor="#020202" />
                <stop offset="88%" stopColor="#000000" />
                <stop offset="100%" stopColor="#171717" />
              </radialGradient>
            </defs>
            <circle
              cx="80"
              cy="58"
              r="52"
              fill={`url(#${bubbleFillId})`}
            />
            <ellipse
              cx="80"
              cy="152"
              rx="52"
              ry="23"
              fill={`url(#${bubbleFillId})`}
            />
          </svg>
        </span>
        <span className="squishy-pack-details">
          {feeLabel ? <span>+{feeLabel}</span> : null}
          <span>{remaining > 0 ? `${remaining} remaining` : "Sold out"}</span>
        </span>
      </span>
    </label>
  );
}

export function SquishyPackCard({ pack, feeUsdc, selected, disabled, onSelect }: SquishyPackCardProps) {
  return <MembershipPackCard name={pack.name} price={String(pack.priceUsdc)} bonusEntries={pack.bonusEntries} remaining={pack.remaining} feeLabel={`${feeUsdc} USDC fee`} value={pack.name} selected={selected} disabled={disabled} onSelect={() => onSelect(pack.name)} />;
}

export default SquishyPackCard;
