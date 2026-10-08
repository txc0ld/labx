import type { Address } from "viem";

export type WalletNft = { contract: Address; tokenId: string; name: string; collection: string; image: string | null };
export type WalletNftPage = { items: readonly WalletNft[]; nextCursor: string | null; chainId: 11155111 };

export const MAX_CURSOR_LENGTH = 2_048;
export const MAX_RESPONSE_BYTES = 65_536;
const MAX_UINT256 = 2n ** 256n;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

export function boundedWalletNftText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(CONTROL_CHARACTERS_GLOBAL, " ").replace(/\s+/g, " ").trim();
  const encoder = new TextEncoder();
  if (encoder.encode(clean).length <= maxBytes) return clean;
  let result = "";
  for (const character of clean) {
    if (encoder.encode(result + character).length > maxBytes) break;
    result += character;
  }
  return result.trim();
}

export function nftTitle(item: Pick<WalletNft, "name" | "collection" | "tokenId">): string {
  return boundedWalletNftText(item.name || `${item.collection || "NFT"} #${item.tokenId}`, 80);
}

export function normalizeTokenId(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 78 || !/^(?:0|[1-9]\d*|0x[0-9a-fA-F]+)$/.test(value)) return null;
  try { const parsed = BigInt(value); return parsed >= 0n && parsed < MAX_UINT256 ? parsed.toString() : null; }
  catch { return null; }
}

export function isValidWalletNftCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_LENGTH && !CONTROL_CHARACTERS.test(value);
}

export function canApplyWalletNftSelection(input: {
  capturedSelectionGeneration: number;
  currentSelectionGeneration: number;
  capturedNftEditGeneration: number;
  currentNftEditGeneration: number;
  sameService: boolean;
  identityLocked: boolean;
}): boolean {
  return input.capturedSelectionGeneration === input.currentSelectionGeneration
    && input.capturedNftEditGeneration === input.currentNftEditGeneration
    && input.sameService
    && !input.identityLocked;
}

export function shouldAutofillWalletNftTitle(input: { currentTitle: string; trackedAutomaticTitle: string | null; titleUnchanged: boolean }): boolean {
  return input.titleUnchanged && (!input.currentTitle.trim() || input.trackedAutomaticTitle !== null && input.currentTitle === input.trackedAutomaticTitle);
}

export function mergeWalletNftItems(input: { current: readonly WalletNft[]; incoming: readonly WalletNft[]; append: boolean }): { items: readonly WalletNft[]; capped: boolean } {
  const candidates = input.append ? [...input.current, ...input.incoming] : input.incoming;
  const seen = new Set<string>();
  const items: WalletNft[] = [];
  for (const item of candidates) {
    const key = `${item.contract.toLowerCase()}:${item.tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (items.length < 240) items.push(item);
  }
  return { items, capped: seen.size > items.length };
}
