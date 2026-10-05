import { isAddress, isHex, keccak256, toBytes, type Address, type Hex } from "viem";
import { assertAgreements, type AgreementInput } from "./agreements";
import { authorizationMessage, authorizedRequest, type RequestContext } from "./request-auth";
import type { Store } from "./points";

export type AgreementRequest = AgreementInput & { pieceId: string; termsHash: Hex; deadline: string; signature: Hex };
export type AgreementContext = RequestContext & { termsHash: Hex };

export function agreementMessage(input: AgreementRequest, context: AgreementContext): string {
  return authorizationMessage("agreement", context, {
    address: input.address.toLowerCase(), pieceId: input.pieceId, termsHash: context.termsHash.toLowerCase(),
    terms: true, rules: true, age: true, deadline: input.deadline
  });
}

export async function recordAgreement(store: Store, input: AgreementRequest, context: AgreementContext, now = Date.now()) {
  assertAgreements(input);
  if (!isAddress(input.address) || typeof input.pieceId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.pieceId)) throw new Error("A valid wallet and piece are required.");
  if (!isHex(context.termsHash, { strict: true }) || context.termsHash.length !== 66 || /^0x0+$/.test(context.termsHash)) throw new Error("Agreement version is not configured.");
  if (typeof input.termsHash !== "string" || input.termsHash.toLowerCase() !== context.termsHash.toLowerCase()) throw new Error("Agreement version does not match.");
  const message = agreementMessage(input, context);
  if (!await authorizedRequest(input.address, input.deadline, input.signature, message, now)) throw new Error("Agreement authorization was refused.");
  const identity = authorizationMessage("agreement identity", context, {
    address: input.address.toLowerCase(), pieceId: input.pieceId, termsHash: context.termsHash.toLowerCase()
  });
  const key = `agree:v2:${keccak256(toBytes(identity))}`;
  const record = {
    version: 2, identity, address: input.address.toLowerCase() as Address, pieceId: input.pieceId,
    context, terms: true, rules: true, age: true, deadline: input.deadline, signature: input.signature,
    message, at: new Date(now).toISOString(), evidence: "wallet-signed assertion; not proof of purchase, age or legal enforceability"
  };
  await store.setIfAbsent({ [key]: JSON.stringify(record) });
  const raw = await store.get(key);
  let saved: typeof record;
  try { saved = JSON.parse(raw || "null") as typeof record; } catch { throw new Error("Agreement record is invalid."); }
  if (!saved || saved.version !== 2 || saved.identity !== identity || saved.address !== record.address || saved.pieceId !== record.pieceId || saved.terms !== true || saved.rules !== true || saved.age !== true || JSON.stringify(saved.context) !== JSON.stringify(context) || !Number.isFinite(Date.parse(saved.at))) throw new Error("Agreement record is invalid.");
  const expected = agreementMessage({ ...input, deadline: saved.deadline }, context);
  if (saved.message !== expected || !await authorizedRequest(saved.address, saved.deadline, saved.signature, expected, Date.parse(saved.at))) throw new Error("Agreement record is invalid.");
  return { key };
}
