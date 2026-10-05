import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyMessage, type Address, type Hex } from "viem";

export type Store = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

export type PointAccount = { balance: number; lastDay: string };

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function checkInMessage(address: Address, day: string): string {
  return `LABx bot check-in\n${address.toLowerCase()}\n${day}`;
}

export function tokensMatch(header: string | null, expected: string | undefined): boolean {
  if (!header || !expected) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function readPoints(store: Store, address: Address): Promise<PointAccount> {
  const raw = await store.get(`points:${address.toLowerCase()}`);
  if (!raw) return { balance: 0, lastDay: "" };
  const parsed = JSON.parse(raw) as PointAccount;
  return { balance: Number(parsed.balance) || 0, lastDay: parsed.lastDay || "" };
}

export async function checkIn(
  store: Store,
  args: { address: Address; signature: Hex; botToken: string | null; expectedToken: string | undefined; now?: number }
): Promise<PointAccount & { awarded: number }> {
  if (!tokensMatch(args.botToken, args.expectedToken)) {
    throw new Error("Bot gate refused the check-in.");
  }
  const day = utcDay(args.now ?? Date.now());
  const ok = await verifyMessage({
    address: args.address,
    message: checkInMessage(args.address, day),
    signature: args.signature
  });
  if (!ok) throw new Error("Check-in signature does not match this wallet.");
  const current = await readPoints(store, args.address);
  if (current.lastDay === day) return { ...current, awarded: 0 };
  const next = { balance: current.balance + 10, lastDay: day };
  await store.set(`points:${args.address.toLowerCase()}`, JSON.stringify(next));
  return { ...next, awarded: 10 };
}
