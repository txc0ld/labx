import { isAddress, isHex, keccak256, toBytes, verifyMessage, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { amoeAuthorizationMessage, captchaDigest, type AmoeContext } from "./amoe-authorization";
import { verifyChallenge } from "./captcha";
import { publicSiteUrl } from "./operator";
import type { Store } from "./points";

export { captchaDigest } from "./amoe-authorization";

/** Only these curated errors are safe to return from the HTTP boundary. */
export class AmoeRequestError extends Error {}

export function configuredAmoeContext(): AmoeContext {
  const env = process.env;
  const mode = env.AMOE_SIGNER_PRIVATE_KEY ? "signed" : "bench";
  const chainId = env.NEXT_PUBLIC_CHAIN_ID || "11155111";
  const verifyingContract = env.NEXT_PUBLIC_RAFFLE_ADDRESS || "0x0000000000000000000000000000000000000000";
  const termsHash = env.TERMS_HASH || `0x${"0".repeat(64)}`;
  if (chainId !== "11155111" || !isAddress(verifyingContract) || !isHex(termsHash, { strict: true }) || termsHash.length !== 66 ||
      (mode === "signed" && (!env.NEXT_PUBLIC_CHAIN_ID || !env.TERMS_HASH || /^0x0{40}$/i.test(verifyingContract)))) {
    throw new AmoeRequestError("AMOE configuration requires Sepolia, the raffle contract and terms hash.");
  }
  return { domain: new URL(publicSiteUrl()).origin, mode, chainId, verifyingContract, termsHash: termsHash as Hex };
}

export async function signAmoeClaim(args: {
  privateKey: Hex; chainId: bigint; verifyingContract: Address; raffleId: bigint;
  account: Address; captchaDigest: Hex; deadline: bigint; termsHash: Hex;
}): Promise<Hex> {
  const signer = privateKeyToAccount(args.privateKey);
  return signer.signTypedData({
    domain: { name: "LABx", version: "1", chainId: args.chainId, verifyingContract: args.verifyingContract },
    types: { AmoeClaim: [
      { name: "raffleId", type: "uint256" }, { name: "account", type: "address" },
      { name: "captchaDigest", type: "bytes32" }, { name: "deadline", type: "uint256" },
      { name: "termsHash", type: "bytes32" }
    ] },
    primaryType: "AmoeClaim",
    message: { raffleId: args.raffleId, account: args.account, captchaDigest: args.captchaDigest,
      deadline: args.deadline, termsHash: args.termsHash }
  });
}

export type AmoeResult = { mode: "bench"; pieceId: string; address: Address; entries: 1 } | {
  mode: "signed"; pieceId: string; address: Address; entries: 1; signature: Hex;
  captchaDigest: Hex; deadline: string; termsHash: Hex; raffleId: string; verifyingContract: Address;
};

export type AmoeInput = {
  address: Address; pieceId: string; raffleId?: string;
  captchaId: string; answer: string; expiresAt: number; captchaMac?: string; captchaSecret?: string;
  points: number; signerKey?: string | null; context?: AmoeContext;
  authorization?: { signature: Hex; deadline: string }; now?: number;
};

type IssuedRecord = { version: 2; fingerprint: string; result: AmoeResult };

export async function issueAmoeClaim(store: Store, input: AmoeInput): Promise<AmoeResult> {
  const { context, authorization } = input;
  if (!context || !authorization || !/^\d+$/.test(authorization.deadline)) throw new AmoeRequestError("Wallet authorization is required.");
  const now = input.now ?? Date.now();
  const seconds = BigInt(Math.trunc(now / 1000));
  const authDeadline = BigInt(authorization.deadline);
  if (authDeadline < seconds || authDeadline > seconds + 600n) throw new AmoeRequestError("Wallet authorization expired or has an invalid deadline.");
  if (!isAddress(input.address) || !input.pieceId || input.pieceId.length > 200 ||
      (input.raffleId !== undefined && !/^\d{1,78}$/.test(input.raffleId))) throw new AmoeRequestError("Invalid piece or raffle id.");
  const raffleId = input.raffleId ? BigInt(input.raffleId).toString() : "";
  if (context.mode === "signed" && (!raffleId || BigInt(raffleId) === 0n || !input.signerKey)) {
    throw new AmoeRequestError("AMOE signer requires an on-chain raffle id.");
  }
  const digest = captchaDigest(input.captchaId, input.answer, input.expiresAt);
  let authorized = false;
  try {
    authorized = await verifyMessage({ address: input.address, signature: authorization.signature,
      message: amoeAuthorizationMessage({ context, address: input.address, pieceId: input.pieceId,
        raffleId, captchaDigest: digest, deadline: authorization.deadline }) });
  } catch {
    throw new AmoeRequestError("Wallet authorization could not be verified.");
  }
  if (!authorized) throw new AmoeRequestError("Wallet authorization does not match this request.");
  if (!input.captchaSecret || !input.captchaMac || !Number.isSafeInteger(input.expiresAt) ||
      !verifyChallenge(input.captchaSecret, { id: input.captchaId, answer: input.answer, expiresAt: input.expiresAt, mac: input.captchaMac }, now)) {
    throw new AmoeRequestError("Captcha answer was refused.");
  }
  if (!Number.isFinite(input.points) || input.points < 10) throw new AmoeRequestError("Check in with the lab bot before requesting a complimentary entry.");

  let signer = "";
  if (context.mode === "signed") {
    try {
      signer = privateKeyToAccount(input.signerKey as Hex).address.toLowerCase();
    } catch {
      throw new AmoeRequestError("AMOE signer is not configured correctly.");
    }
  }
  const address = input.address.toLowerCase() as Address;
  const fingerprint = JSON.stringify([context.mode, context.domain, context.chainId,
    context.verifyingContract.toLowerCase(), context.termsHash.toLowerCase(), address, input.pieceId, raffleId, signer]);
  const identity = context.mode === "signed"
    ? [context.chainId, context.verifyingContract.toLowerCase(), raffleId, address]
    : [context.domain, "bench", input.pieceId, address];
  const claimKey = `amoe:v2:${keccak256(toBytes(JSON.stringify(identity)))}`;
  const legacyKey = `amoe:${input.pieceId}:${address}`;
  const spentKey = `captcha:${input.captchaId}`;
  const recover = async (): Promise<AmoeResult | null> => {
    const raw = await store.get(claimKey);
    if (!raw) return null;
    const issued = JSON.parse(raw) as IssuedRecord;
    if (issued.version !== 2 || issued.fingerprint !== fingerprint) {
      throw new AmoeRequestError("An entry is already recorded with different configuration; operator reconciliation is required.");
    }
    if (issued.result.mode === "signed" && BigInt(issued.result.deadline) < seconds) {
      throw new AmoeRequestError("The issued authorization expired; operator reconciliation is required.");
    }
    return issued.result;
  };
  const existing = await recover();
  if (existing) return existing;
  if (await store.get(legacyKey)) {
    const raced = await recover();
    if (raced) return raced;
    throw new AmoeRequestError("A legacy entry is already recorded; operator reconciliation is required.");
  }

  let result: AmoeResult = { mode: "bench", pieceId: input.pieceId, address, entries: 1 };
  if (context.mode === "signed") {
    const deadline = seconds + 3600n;
    let signature: Hex;
    try {
      signature = await signAmoeClaim({ privateKey: input.signerKey as Hex, chainId: BigInt(context.chainId),
        verifyingContract: context.verifyingContract, raffleId: BigInt(raffleId), account: address,
        captchaDigest: digest, deadline, termsHash: context.termsHash });
    } catch {
      throw new AmoeRequestError("AMOE signer could not issue the authorization.");
    }
    result = { mode: "signed", pieceId: input.pieceId, address, entries: 1, signature, captchaDigest: digest,
      deadline: deadline.toString(), termsHash: context.termsHash, raffleId, verifyingContract: context.verifyingContract };
  }
  const committed = await store.setIfAbsent({
    [claimKey]: JSON.stringify({ version: 2, fingerprint, result } satisfies IssuedRecord),
    [legacyKey]: JSON.stringify({ claimKey }),
    [spentKey]: JSON.stringify({ claimKey })
  });
  if (committed) return result;
  const winner = await recover();
  if (winner) return winner;
  throw new AmoeRequestError("This captcha was already used or an entry is already recorded. Retry with a fresh challenge.");
}
