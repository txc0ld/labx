import { isAddress, isHex, verifyMessage, type Address, type Hex } from "viem";
import { publicSiteUrl } from "./operator";

export type RequestContext = { origin: string; chainId: 11155111; contract: Address };

export function requestContext(env = process.env): RequestContext {
  const contract = env.NEXT_PUBLIC_RAFFLE_ADDRESS;
  if (env.NEXT_PUBLIC_CHAIN_ID !== "11155111" || !contract || !isAddress(contract)) {
    throw new Error("Sepolia request authorization is not configured.");
  }
  return { origin: new URL(publicSiteUrl()).origin, chainId: 11155111, contract: contract.toLowerCase() as Address };
}

export function authorizationMessage(operation: string, context: RequestContext, fields: Record<string, unknown>): string {
  return `LABx ${operation} v2\n${JSON.stringify({ origin: context.origin, chainId: context.chainId, contract: context.contract.toLowerCase(), ...fields })}`;
}

export async function authorizedRequest(address: unknown, deadline: unknown, signature: unknown, message: string, now = Date.now()): Promise<boolean> {
  if (typeof address !== "string" || !isAddress(address) || typeof deadline !== "string" || !/^\d{1,12}$/.test(deadline)) return false;
  if (typeof signature !== "string" || !isHex(signature, { strict: true }) || signature.length !== 132) return false;
  const seconds = BigInt(Math.floor(now / 1000));
  if (BigInt(deadline) < seconds || BigInt(deadline) > seconds + 600n) return false;
  try { return await verifyMessage({ address, message, signature: signature as Hex }); } catch { return false; }
}
