import { isAddress, isHex, verifyMessage, type Address, type Hex } from "viem";
import { publicSiteUrl } from "./operator";
import { publicChainId, type SupportedChainId } from "./chain/networks";

export type RequestContext = { origin: string; chainId: SupportedChainId; contract: Address };

export function requestContext(env = process.env): RequestContext {
  const contract = env.NEXT_PUBLIC_RAFFLE_ADDRESS, chainId = publicChainId(env.NEXT_PUBLIC_CHAIN_ID);
  if (!chainId || !contract || !isAddress(contract)) {
    throw new Error("Request authorization is not configured.");
  }
  return { origin: new URL(publicSiteUrl()).origin, chainId, contract: contract.toLowerCase() as Address };
}

export function authorizationMessage(operation: string, context: RequestContext, fields: Record<string, unknown>): string {
  return `LABx ${operation} v2\n${JSON.stringify({ origin: context.origin, chainId: context.chainId, contract: context.contract.toLowerCase(), ...fields })}`;
}

export type SignatureVerifier = (input: { address: Address; message: string; signature: Hex }) => Promise<boolean>;

export async function authorizedRequest(address: unknown, deadline: unknown, signature: unknown, message: string, now = Date.now(), verifier: SignatureVerifier = verifyMessage): Promise<boolean> {
  if (typeof address !== "string" || !isAddress(address) || typeof deadline !== "string" || !/^\d{1,12}$/.test(deadline)) return false;
  if (typeof signature !== "string" || !isHex(signature, { strict: true }) || signature.length > 16_386) return false;
  const seconds = BigInt(Math.floor(now / 1000));
  if (BigInt(deadline) < seconds || BigInt(deadline) > seconds + 600n) return false;
  try { return await verifier({ address, message, signature }); } catch { return false; }
}
