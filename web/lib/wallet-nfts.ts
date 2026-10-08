"use client";

import { getAddress, isAddress, type Address } from "viem";
import { safeArtworkUrl } from "./chain/metadata";
import { MAX_RESPONSE_BYTES, boundedWalletNftText, isValidWalletNftCursor, nftTitle, normalizeTokenId, objectRecord, type WalletNft, type WalletNftPage } from "./wallet-nfts-shared";

export { canApplyWalletNftSelection, mergeWalletNftItems, nftTitle, shouldAutofillWalletNftTitle, type WalletNft, type WalletNftPage } from "./wallet-nfts-shared";

function parseClientPage(value: unknown): WalletNftPage {
  const root = objectRecord(value);
  if (!root || root.ok !== true || root.chainId !== 11155111 || !Array.isArray(root.items)) throw new Error(typeof root?.error === "string" ? root.error : "Wallet NFT inventory returned an invalid response.");
  const items: WalletNft[] = root.items.map(raw => {
    const item = objectRecord(raw);
    if (!item || typeof item.contract !== "string" || !isAddress(item.contract) || /^0x0{40}$/i.test(item.contract)) throw new Error("Wallet NFT inventory returned an invalid response.");
    const tokenId = normalizeTokenId(item.tokenId);
    const normalizedImage = typeof item.image === "string" ? safeArtworkUrl(item.image) : null;
    const image = normalizedImage === item.image ? normalizedImage : null;
    if (tokenId === null || typeof item.name !== "string" || typeof item.collection !== "string") throw new Error("Wallet NFT inventory returned an invalid response.");
    return { contract: getAddress(item.contract), tokenId, name: boundedWalletNftText(item.name, 160), collection: boundedWalletNftText(item.collection, 160), image };
  });
  if (items.length > 24 || root.nextCursor !== null && !isValidWalletNftCursor(root.nextCursor)) throw new Error("Wallet NFT inventory returned an invalid response.");
  return { items, nextCursor: root.nextCursor, chainId: 11155111 };
}

export async function fetchWalletNfts(input: { owner: Address; cursor?: string; signal: AbortSignal }): Promise<WalletNftPage> {
  const query = new URLSearchParams({ owner: input.owner });
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  const response = await fetch(`/api/wallet-nfts?${query}`, { method: "GET", credentials: "same-origin", cache: "no-store", signal: input.signal, headers: { Accept: "application/json" } });
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("Wallet NFT inventory returned an invalid response.");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Wallet NFT inventory returned an invalid response."); }
  if (!response.ok) {
    const body = objectRecord(parsed);
    throw new Error(typeof body?.error === "string" ? body.error : "Wallet NFT inventory is unavailable. Enter the NFT manually.");
  }
  return parseClientPage(parsed);
}
