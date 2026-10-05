"use client";

import { useId } from "react";

export function Plumbing({ label = "Chrome tube and fluorescent cable linking the panels" }: { label?: string }) {
  const uid = useId().replace(/:/g, "");
  const chrome = `${uid}-chrome`;
  return (
    <svg className="plumbing" viewBox="0 0 1180 72" role="img" aria-label={label}>
      <title>{label}</title>
      <defs>
        <linearGradient id={chrome} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.35" stopColor="#9aa6b8" />
          <stop offset="0.55" stopColor="#f7f8fb" />
          <stop offset="1" stopColor="#6e7888" />
        </linearGradient>
      </defs>
      <path d={`M40 36 H420`} stroke={`url(#${chrome})`} strokeWidth="10" fill="none" strokeLinecap="round" />
      <path d={`M760 36 H1140`} stroke={`url(#${chrome})`} strokeWidth="10" fill="none" strokeLinecap="round" />
      <path
        className="cable"
        d="M40 48 H1140"
        stroke="#8FFFB6"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
        style={{ filter: "drop-shadow(0 0 6px #8FFFB6)" }}
      />
      <circle cx="430" cy="36" r="14" fill="#141018" />
      <circle cx="430" cy="36" r="7" fill="#8049FF" />
      <circle cx="590" cy="36" r="16" fill={`url(#${chrome})`} />
      <circle cx="590" cy="36" r="6" fill="#B9FF87" />
      <circle cx="750" cy="36" r="14" fill="#141018" />
      <circle cx="750" cy="36" r="7" fill="#FF79C0" />
      <style>{`.cable{animation:flow 9s linear infinite}@keyframes flow{to{stroke-dashoffset:-280}}`}</style>
    </svg>
  );
}
