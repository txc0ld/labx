import { isHex, keccak256, toBytes, type Address, type Hex } from "viem";
import { createReserve, readReserveRecord, type PublicReserve, type ReserveRecord } from "./reserve";
import { address, sameAddress } from "./chain/validation";
import { verifyWorkflowAuthorization } from "./chain/server";
import type { CommitmentInput, WorkflowContext } from "./chain/api-types";
import type { Store } from "./points";
export type SignedWorkflowInput<T> = { address: Address; input: T; deadline: string; signature: Hex };
export type WorkflowVerifier = (args: { address: Address; message: string; signature: Hex }) => Promise<boolean>;
export function parseEnvelope(body: unknown): SignedWorkflowInput<unknown> {
  if (!body || typeof body !== "object" || !("address" in body) || !("input" in body) || !("deadline" in body) || typeof body.deadline !== "string" || !("signature" in body) || typeof body.signature !== "string" || !isHex(body.signature, { strict: true }) || body.signature.length > 16_386) throw new Error("A signed wallet request is required.");
  return { address: address(body.address), input: body.input, deadline: body.deadline, signature: body.signature };
}
export function parseCommitmentInput(input: unknown): CommitmentInput {
  if (!input || typeof input !== "object" || !("nft" in input) || !("tokenId" in input) || typeof input.tokenId !== "string" || !/^\d{1,78}$/.test(input.tokenId) || BigInt(input.tokenId) >= 2n ** 256n || !("publicSummary" in input) || typeof input.publicSummary !== "string" || !input.publicSummary.trim() || input.publicSummary.length > 2_000 || !("privateCommitment" in input) || typeof input.privateCommitment !== "string" || !input.privateCommitment.trim() || input.privateCommitment.length > 8_000) throw new Error("Commitment details are invalid or too long.");
  return { nft: address(input.nft), tokenId: BigInt(input.tokenId).toString(), publicSummary: input.publicSummary.trim(), privateCommitment: input.privateCommitment.trim() };
}
export async function saveAuthenticatedCommitment(store: Store, request: SignedWorkflowInput<CommitmentInput>, context: WorkflowContext, verify: WorkflowVerifier): Promise<PublicReserve> {
  const input = parseCommitmentInput(request.input);
  await verifyWorkflowAuthorization({ operation: "commitment", context, account: request.address, input, deadline: request.deadline, signature: request.signature, verify });
  // Deadline-independent identity makes retries recover the same durable commitment.
  const identity = keccak256(toBytes(JSON.stringify([context.chainId, context.contract.toLowerCase(), request.address.toLowerCase(), input])));
  const record = await createReserve(store, { ...input, seller: request.address, chainId: BigInt(context.chainId), labx: context.contract, requestIdentity: identity });
  if (!sameAddress(record.seller, request.address) || !sameAddress(record.labx, context.contract) || record.chainId !== String(context.chainId)) throw new Error("Commitment identity does not match.");
  return record;
}
export async function recoverAuthenticatedCommitment(store: Store, request: SignedWorkflowInput<{ commit: Hex }>, context: WorkflowContext, verify: WorkflowVerifier): Promise<ReserveRecord> {
  await verifyWorkflowAuthorization({ operation: "commitment recovery", context, account: request.address, input: request.input, deadline: request.deadline, signature: request.signature, verify });
  const record = await readReserveRecord(store, request.input.commit);
  if (!sameAddress(record.seller, request.address) || !sameAddress(record.labx, context.contract) || record.chainId !== String(context.chainId)) throw new Error("This commitment does not belong to this wallet and deployment.");
  return record;
}
