import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes, isAddress, isHex, verifyMessage, type Address, type Hex } from "viem";
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
    requestIdentity?: Hex;
  }
): Promise<PublicReserve> {
  const requestKey = input.requestIdentity ? `reserve-request:v3:${input.requestIdentity}` : null;
  if (requestKey) {
    const existing = await store.get(requestKey);
    if (existing) return publishedReserve(await readReserveRecord(store, existing as Hex));
  }
  if (!input.publicSummary.trim() || !input.privateCommitment.trim()) {
    throw new Error("A public summary and a private commitment are both required.");
  }
  if (!input.labx || input.labx === "0x0000000000000000000000000000000000000000") {
    throw new Error("Raffle address is not configured.");
  }
  if (input.chainId !== 11155111n && input.chainId !== 31337n) throw new Error("Sepolia is the only supported chain.");
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
  if (requestKey) {
    const saved = await store.setIfAbsent({ [`reserve:${commit}`]: JSON.stringify(record), [requestKey]: commit });
    if (!saved) {
      const winner = await store.get(requestKey);
      if (!winner) throw new Error("Commitment storage could not be acknowledged.");
      return publishedReserve(await readReserveRecord(store, winner as Hex));
    }
  } else await store.set(`reserve:${commit}`, JSON.stringify(record));
  return publishedReserve(record);

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

export function publishedReserve(record: ReserveRecord): PublicReserve {
  const { salt: _salt, privateHash: _privateHash, ...published } = record;
  return published;
}

export async function readReserveRecord(store: Store, commit: Hex): Promise<ReserveRecord> {
  if (!isHex(commit, { strict: true }) || commit.length !== 66) throw new Error("Invalid commitment hash.");
  const raw = await store.get(`reserve:${commit}`);
  if (!raw) throw new Error("Unknown commitment.");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Commitment record is invalid.");
  const text = (key: string) => {
    if (!(key in parsed)) throw new Error("Commitment record is incomplete.");
    const value: unknown = Reflect.get(parsed, key);
    if (typeof value !== "string") throw new Error("Commitment record is invalid.");
    return value;
  };
  const wallet = (key: string): Address => { const value = text(key); if (!isAddress(value)) throw new Error("Commitment wallet is invalid."); return value; };
  const digest = (key: string): Hex => { const value = text(key); if (!isHex(value, { strict: true }) || value.length !== 66) throw new Error("Commitment hash is invalid."); return value; };
  const tokenId = text("tokenId"), chainId = text("chainId");
  if (!/^\d{1,78}$/.test(tokenId) || !["11155111", "31337"].includes(chainId)) throw new Error("Commitment identifiers are invalid.");
  const record: ReserveRecord = { seller: wallet("seller"), nft: wallet("nft"), tokenId, chainId, labx: wallet("labx"), publicSummary: text("publicSummary"), publicHash: digest("publicHash"), privateHash: digest("privateHash"), salt: digest("salt"), nonce: digest("nonce"), commit: digest("commit") };
  const expected = hashCommitment({ ...record, chainId: BigInt(chainId), tokenId: BigInt(tokenId) });
  if (expected !== commit || record.commit !== commit || keccak256(toBytes(record.publicSummary)) !== record.publicHash) throw new Error("Commitment record failed integrity checks.");
  return record;
}
