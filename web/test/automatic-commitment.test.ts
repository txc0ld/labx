import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { automaticCommitmentKey, prepareAutomaticCommitment } from "../lib/automatic-commitment";

const NFT = getAddress("0x1111111111111111111111111111111111111111");

afterEach(() => vi.unstubAllGlobals());

describe("automatic seller commitment preparation", () => {
  it("uses 32 browser-CSPRNG bytes and a canonical NFT-based public summary", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 32 }, (_, index) => index));
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const prepared = prepareAutomaticCommitment(NFT, 1n);

    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0]?.[0]).toHaveLength(32);
    expect(prepared).toEqual({
      key: `${NFT.toLowerCase()}:1`,
      input: {
        publicSummary: `LABx draw setup for NFT ${NFT.toLowerCase()} token 1`,
        privateCommitment: "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
      }
    });
    expect(automaticCommitmentKey(NFT, 1n)).toBe(automaticCommitmentKey(NFT, BigInt("01")));
  });

  it("fails closed when secure browser entropy is unavailable or refuses generation", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => prepareAutomaticCommitment(NFT, 1n)).toThrow(/secure random/i);

    vi.stubGlobal("crypto", { getRandomValues: () => { throw new Error("entropy unavailable"); } });
    expect(() => prepareAutomaticCommitment(NFT, 1n)).toThrow(/secure random/i);
  });
});
