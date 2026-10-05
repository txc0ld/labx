import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes, verifyMessage, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
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

export type PublicReserve = Omit<ReserveRecord, "salt" | "privateHash">;

const REVEAL_WINDOW = 10n * 60n;

export function saltedPrivateHash(salt: Hex, plaintext: string): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32, string"), [salt, plaintext]));
}

export function revealMessage(commit: Hex, labx: Address, deadline: bigint): string {
  return `LABx reveal\n${commit}\n${labx}\n${deadline}`;
}

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
): Promise<PublicReserve> {
  if (!input.publicSummary.trim() || !input.privateCommitment.trim()) {
    throw new Error("A public summary and a private commitment are both required.");
  }
  if (!input.labx || input.labx === "0x0000000000000000000000000000000000000000") {
    throw new Error("Raffle address is not configured.");
  }
  if (input.chainId === 0n || input.chainId === 1n) throw new Error("Sepolia is the only supported chain.");
  const nonce = keccak256(toBytes(generatePrivateKey()));
  const salt = keccak256(toBytes(generatePrivateKey()));
  const plaintext = input.privateCommitment.trim();
  const publicHash = keccak256(toBytes(input.publicSummary.trim()));
  const privateHash = saltedPrivateHash(salt, plaintext);
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
  await store.set(`reserve:${commit}`, JSON.stringify({ ...record, privateCommitment: plaintext }));
  const { salt: _salt, privateHash: _privateHash, ...published } = record;
  void _salt;
  void _privateHash;
  return published;
}

export async function revealReserve(
  store: Store,
  input: { commit: Hex; seller: Address; signature: Hex; deadline: bigint; now?: bigint }
): Promise<ReserveRecord> {
  const raw = await store.get(`reserve:${input.commit}`);
  if (!raw) throw new Error("Unknown commitment.");
  const stored = JSON.parse(raw) as ReserveRecord & { privateCommitment: string };
  if (stored.seller.toLowerCase() !== input.seller.toLowerCase()) throw new Error("Seller does not match this commitment.");
  const now = input.now ?? BigInt(Math.trunc(Date.now() / 1000));
  if (input.deadline < now || input.deadline > now + REVEAL_WINDOW) throw new Error("Reveal deadline was refused.");
  const ok = await verifyMessage({
    address: input.seller,
    message: revealMessage(input.commit, stored.labx, input.deadline),
    signature: input.signature
  });
  if (!ok) throw new Error("Reveal signature was refused.");
  const { privateCommitment: _hidden, ...rest } = stored;
  void _hidden;
  return rest;
}
