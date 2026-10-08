"use client";

import { bytesToHex, type Address } from "viem";

export function automaticCommitmentKey(nft: Address, tokenId: bigint) {
  return `${nft.toLowerCase()}:${tokenId.toString()}`;
}

export function prepareAutomaticCommitment(nft: Address, tokenId: bigint) {
  const secureRandom = globalThis.crypto?.getRandomValues;
  if (typeof secureRandom !== "function") throw new Error("Secure random generation is unavailable. This raffle cannot be prepared safely.");

  const bytes = new Uint8Array(32);
  try {
    secureRandom.call(globalThis.crypto, bytes);
  } catch {
    throw new Error("Secure random generation failed. This raffle cannot be prepared safely.");
  }

  const key = automaticCommitmentKey(nft, tokenId);
  return {
    key,
    input: {
      publicSummary: `LABx draw setup for NFT ${nft.toLowerCase()} token ${tokenId.toString()}`,
      privateCommitment: bytesToHex(bytes)
    }
  };
}
