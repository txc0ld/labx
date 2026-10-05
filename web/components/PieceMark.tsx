export const MARKS = ["cable", "filter", "terminal", "junction"] as const;
export type PieceMarkName = (typeof MARKS)[number];

export function markFor(id: string, mark?: string): PieceMarkName {
  if (MARKS.includes(mark as PieceMarkName)) return mark as PieceMarkName;
  if (id.includes("cable")) return "cable";
  if (id.includes("filter")) return "filter";
  if (id.includes("terminal")) return "terminal";
  return "junction";
}

export function PieceMark({ name, title }: { name: PieceMarkName; title?: string }) {
  return (
    <svg className="piece-mark" viewBox="0 0 64 64" role={title ? "img" : "presentation"} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      {name === "cable" ? <CableGlyph /> : null}
      {name === "filter" ? <FilterGlyph /> : null}
      {name === "terminal" ? <TerminalGlyph /> : null}
      {name === "junction" ? <JunctionGlyph /> : null}
    </svg>
  );
}

function CableGlyph() {
  return (
    <g fill="#000">
      <rect x="8" y="10" width="14" height="18" rx="4" />
      <rect x="42" y="10" width="14" height="18" rx="4" />
      <circle cx="15" cy="19" r="3" fill="#fff" />
      <circle cx="49" cy="19" r="3" fill="#fff" />
      <path d="M15 28c0 14 8 22 17 22s17-8 17-22h-7c0 9-5 15-10 15s-10-6-10-15z" />
    </g>
  );
}

function FilterGlyph() {
  return (
    <g fill="#000">
      <rect x="12" y="8" width="8" height="48" rx="4" />
      <rect x="28" y="18" width="8" height="38" rx="4" />
      <rect x="44" y="12" width="8" height="44" rx="4" />
      <circle cx="16" cy="22" r="5" />
      <circle cx="32" cy="34" r="5" />
      <circle cx="48" cy="26" r="5" />
    </g>
  );
}

function TerminalGlyph() {
  return (
    <g fill="#000">
      <rect x="6" y="10" width="52" height="36" rx="8" />
      <rect x="12" y="16" width="40" height="16" rx="3" fill="#fff" />
      <circle cx="18" cy="40" r="3" fill="#fff" />
      <circle cx="28" cy="40" r="3" fill="#fff" />
      <circle cx="38" cy="40" r="3" fill="#fff" />
      <rect x="46" y="37" width="8" height="6" rx="2" fill="#fff" />
      <rect x="24" y="50" width="16" height="5" rx="2.5" />
    </g>
  );
}

function JunctionGlyph() {
  return (
    <g fill="#000">
      <rect x="27" y="6" width="10" height="52" rx="5" />
      <rect x="6" y="27" width="52" height="10" rx="5" />
      <circle cx="32" cy="32" r="10" />
      <circle cx="32" cy="32" r="4" fill="#fff" />
    </g>
  );
}
