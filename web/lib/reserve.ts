import { generatePrivateKey } from "viem/accounts";
import { keccak256, toBytes, verifyMessage, type Address, type Hex } from "viem";
import { hashCommitment } from "./commitment";
import type { Store } from "./points";

export type ReserveRecord = {
  seller: Address;
  nft: Address;
  tokenId: string;
  publicSummary: string;
  publicHash: Hex;
  privateHash: Hex;
  salt: Hex;
  nonce: Hex;
  commit: Hex;
  chainId: string;
  labx: Address;
};

export async function createReserve(
  store: Store,
  input: {
    seller: Address;
    nft: Address;
    tokenId: string;
    publicSummary: string;
    privateCommitment: string;
    chainId: bigint;
    labx: Address;
  }
): Promise<ReserveRecord> {
  if (!input.publicSummary.trim() || !input.privateCommitment.trim()) {
    throw new Error("A public summary and a private commitment are both required.");
  }
  const nonce = keccak256(toBytes(`${input.seller}:${input.tokenId}:${Date.now()}:${Math.random()}`));
  const salt = keccak256(toBytes(generatePrivateKey()));
  const publicHash = keccak256(toBytes(input.publicSummary.trim()));
  const privateHash = keccak256(toBytes(input.privateCommitment.trim()));
  const commit = hashCommitment({
    chainId: input.chainId,
    labx: input.labx,
    nonce,
    nft: input.nft,
    tokenId: BigInt(input.tokenId),
    publicHash,
    privateHash,
    salt
  });
  const record: ReserveRecord = {
    seller: input.seller,
    nft: input.nft,
    tokenId: input.tokenId,
    publicSummary: input.publicSummary.trim(),
    publicHash,
    privateHash,
    salt,
    nonce,
    commit,
    chainId: input.chainId.toString(),
    labx: input.labx
  };
  await store.set(`reserve:${commit}`, JSON.stringify({ ...record, privateCommitment: input.privateCommitment.trim() }));
  return record;
}

export async function revealReserve(
  store: Store,
  input: { commit: Hex; seller: Address; signature: Hex }
): Promise<Omit<ReserveRecord, "seller"> & { seller: Address }> {
  const raw = await store.get(`reserve:${input.commit}`);
  if (!raw) throw new Error("Unknown commitment.");
  const stored = JSON.parse(raw) as ReserveRecord & { privateCommitment: string };
  if (stored.seller.toLowerCase() !== input.seller.toLowerCase()) throw new Error("Seller does not match this commitment.");
  const ok = await verifyMessage({
    address: input.seller,
    message: `LABx reveal ${input.commit}`,
    signature: input.signature
  });
  if (!ok) throw new Error("Reveal signature was refused.");
  const { privateCommitment: _hidden, ...rest } = stored;
  void _hidden;
  return rest;
}
