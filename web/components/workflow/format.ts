import type { RaffleSnapshot } from "@/lib/chain/types";

const USDC_DECIMALS = 6n;
const USDC_SCALE = 10n ** USDC_DECIMALS;

export function formatUsdc(value: bigint) {
  const whole = value / USDC_SCALE;
  const fraction = (value % USDC_SCALE).toString().padStart(Number(USDC_DECIMALS), "0").replace(/0+$/, "");
  return fraction ? `${whole.toLocaleString("en-US")}.${fraction}` : whole.toLocaleString("en-US");
}

export function parseUsdc(value: string) {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(normalized)) throw new Error("Enter a positive USDC amount with up to 6 decimal places.");
  const [whole, fraction = ""] = normalized.split(".");
  const atomic = BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(Number(USDC_DECIMALS), "0"));
  if (atomic <= 0n) throw new Error("Membership price must be greater than zero.");
  return atomic;
}

export function formatDate(timestamp: bigint) {
  const milliseconds = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(milliseconds)) return "Invalid deadline";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(milliseconds));
}

export const PHASE_LABELS = ["Draft", "Open", "Closed", "Drawing", "Drawn", "Settled", "Cancelled"] as const;

export function phaseLabel(phase: number) {
  return PHASE_LABELS[phase] ?? "Unknown";
}

export function minimumActivePrice(snapshot: RaffleSnapshot) {
  const active = snapshot.packs.filter((pack) => pack.active && pack.sold < pack.maxSupply);
  return active.reduce<bigint | null>((minimum, pack) => minimum === null || pack.priceUsdc < minimum ? pack.priceUsdc : minimum, null);
}

export function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
