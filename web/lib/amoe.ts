import { keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Store } from "./points";

export function captchaDigest(id: string, answer: string, expiresAt: number): Hex {
  return keccak256(toBytes(`${id}:${answer.trim()}:${expiresAt}`));
}

export async function signAmoeClaim(args: {
  privateKey: Hex;
  chainId: bigint;
  verifyingContract: Address;
  raffleId: bigint;
  account: Address;
  captchaDigest: Hex;
  deadline: bigint;
  termsHash: Hex;
}): Promise<Hex> {
  const signer = privateKeyToAccount(args.privateKey);
  return signer.signTypedData({
    domain: { name: "LABx", version: "1", chainId: args.chainId, verifyingContract: args.verifyingContract },
    types: {
      AmoeClaim: [
        { name: "raffleId", type: "uint256" },
        { name: "account", type: "address" },
        { name: "captchaDigest", type: "bytes32" },
        { name: "deadline", type: "uint256" },
        { name: "termsHash", type: "bytes32" }
      ]
    },
    primaryType: "AmoeClaim",
    message: {
      raffleId: args.raffleId,
      account: args.account,
      captchaDigest: args.captchaDigest,
      deadline: args.deadline,
      termsHash: args.termsHash
    }
  });
}

export async function issueAmoeClaim(
  store: Store,
  input: {
    address: Address;
    pieceId: string;
    raffleId?: string;
    captchaId: string;
    answer: string;
    expiresAt: number;
    points: number;
    signerKey?: string | null;
    chainId?: bigint;
    verifyingContract?: Address | null;
    termsHash?: Hex | null;
    now?: number;
  }
): Promise<
  | { mode: "bench"; pieceId: string; address: Address; entries: 1 }
  | {
      mode: "signed";
      pieceId: string;
      address: Address;
      entries: 1;
      signature: Hex;
      captchaDigest: Hex;
      deadline: string;
      termsHash: Hex;
      raffleId: string;
      verifyingContract: Address;
    }
> {
  if (input.points < 10) {
    throw new Error("Check in with the lab bot before requesting a complimentary entry.");
  }
  const signerReady = Boolean(input.signerKey);
  if (
    signerReady &&
    (!input.raffleId ||
      !/^\d+$/.test(input.raffleId) ||
      !input.verifyingContract ||
      !input.termsHash ||
      input.chainId === undefined ||
      input.chainId === 1n)
  ) {
    throw new Error("AMOE signer is configured but the raffle, terms hash, or raffle id is missing.");
  }
  const claimKey = `amoe:${input.pieceId || "none"}:${input.address.toLowerCase()}`;
  if (await store.get(claimKey)) throw new Error("A complimentary entry is already recorded for this piece.");
  const spentKey = `captcha:${input.captchaId}`;
  if (await store.get(spentKey)) throw new Error("This captcha was already used.");
  await store.set(spentKey, JSON.stringify({ address: input.address.toLowerCase(), at: input.now ?? Date.now() }));
  await store.set(claimKey, JSON.stringify({ at: new Date(input.now ?? Date.now()).toISOString() }));

  if (!input.signerKey || !input.raffleId || !input.verifyingContract || !input.termsHash || input.chainId === undefined) {
    return { mode: "bench", pieceId: input.pieceId, address: input.address, entries: 1 };
  }
  const digest = captchaDigest(input.captchaId, input.answer, input.expiresAt);
  const deadline = BigInt(Math.trunc((input.now ?? Date.now()) / 1000) + 60 * 60);
  const signature = await signAmoeClaim({
    privateKey: input.signerKey as Hex,
    chainId: input.chainId,
    verifyingContract: input.verifyingContract,
    raffleId: BigInt(input.raffleId),
    account: input.address,
    captchaDigest: digest,
    deadline,
    termsHash: input.termsHash
  });
  return {
    mode: "signed",
    pieceId: input.pieceId,
    address: input.address,
    entries: 1,
    signature,
    captchaDigest: digest,
    deadline: deadline.toString(),
    termsHash: input.termsHash,
    raffleId: input.raffleId,
    verifyingContract: input.verifyingContract
  };
}
