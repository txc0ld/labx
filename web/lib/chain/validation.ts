import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
export function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value) || /^0x0{40}$/i.test(value)) throw new Error("A nonzero wallet or contract address is required.");
  return getAddress(value);
}
export function hash(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length !== 66) throw new Error("A 32-byte hash is required.");
  return value;
}
export function positiveId(value: bigint): void {
  if (typeof value !== "bigint" || value <= 0n || value >= 2n ** 256n) throw new Error("Invalid raffle or token identifier.");
}
export function boundedNumber(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("A value is outside the permitted range.");
}
export function sameAddress(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
