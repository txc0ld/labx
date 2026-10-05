import { keccak256, toBytes, type Address, type Hex } from "viem";

export type AmoeContext = {
  domain: string;
  mode: "bench" | "signed";
  chainId: string;
  verifyingContract: Address;
  termsHash: Hex;
};

export function captchaDigest(id: string, answer: string, expiresAt: number): Hex {
  return keccak256(toBytes(JSON.stringify([id, answer.trim(), expiresAt])));
}

export function amoeAuthorizationMessage(input: {
  context: AmoeContext;
  address: Address;
  pieceId: string;
  raffleId?: string;
  captchaDigest: Hex;
  deadline: string;
}): string {
  return "LABx complimentary entry authorization v2\n" + JSON.stringify({
    domain: input.context.domain,
    mode: input.context.mode,
    chainId: input.context.chainId,
    verifyingContract: input.context.verifyingContract.toLowerCase(),
    termsHash: input.context.termsHash.toLowerCase(),
    agreements: { terms: true, rules: true, age: true },
    address: input.address.toLowerCase(),
    pieceId: input.pieceId,
    raffleId: input.raffleId ? BigInt(input.raffleId).toString() : "",
    captchaDigest: input.captchaDigest,
    deadline: input.deadline
  });
}
