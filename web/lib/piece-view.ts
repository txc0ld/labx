import type { Piece } from "./seed";

export function pieceView(piece: Piece, now: number) {
  const deadline = Date.parse(piece.salesEnd);
  const scheduled = Number.isFinite(deadline);
  const elapsed = scheduled && deadline <= now;
  const hasPacks = piece.packs.some((pack) => pack.remaining > 0);
  const isOpen = piece.phase === "open" && piece.escrowed && scheduled && !elapsed && hasPacks;
  const isEnded = (elapsed && piece.phase !== "draft") || ["closed", "drawing", "drawn", "settled", "cancelled"].includes(piece.phase);
  const status = piece.phase === "open"
    ? !scheduled ? "Schedule unavailable" : elapsed ? "Sales ended" : !piece.escrowed ? "Awaiting escrow" : !hasPacks ? "Packs unavailable" : "Packs open"
    : { draft: "Draft", closed: "Sales closed", drawing: "Drawing", drawn: "Drawn", settled: "Settled", cancelled: "Cancelled" }[piece.phase];
  let timing = "Schedule unavailable";
  if (scheduled) {
    if (elapsed) timing = "Sales deadline passed";
    else if (isOpen) {
      const minutes = Math.max(1, Math.ceil((deadline - now) / 60000));
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      timing = days ? `${days}d ${hours}h left` : hours ? `${hours}h ${minutes % 60}m left` : `${minutes}m left`;
    } else timing = "Sales are not open";
  }
  return { isOpen, isEnded, status, timing, scheduled };
}

export function closingDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date)
    : "Not scheduled";
}
