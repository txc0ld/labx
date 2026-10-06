import { keccak256, toBytes } from "viem";
import type { Store } from "./points";
import type { PrivateRecords, RecordsInput, WorkflowContext } from "./chain/api-types";
import { authorizationMessage, authorizedRequest } from "./request-auth";
import { agreementMessage } from "./agreement-record";
import { verifyWorkflowAuthorization } from "./chain/server";
import { hash, sameAddress } from "./chain/validation";
import type { SignedWorkflowInput, WorkflowVerifier } from "./workflow-records";
export function parseRecordsInput(input: unknown): RecordsInput {
  if (!input || typeof input !== "object" || !("raffleIds" in input) || !Array.isArray(input.raffleIds) || input.raffleIds.length > 30 || !("purchases" in input) || !Array.isArray(input.purchases) || input.purchases.length > 30) throw new Error("Record selection is invalid.");
  const raffleIds = input.raffleIds.map((id: unknown) => { if (typeof id !== "string" || !/^[1-9]\d{0,77}$/.test(id)) throw new Error("Raffle ID is invalid."); return id; });
  const purchases = input.purchases.map((purchase: unknown) => {
    if (!purchase || typeof purchase !== "object" || !("transactionHash" in purchase) || !("logIndex" in purchase) || typeof purchase.logIndex !== "number" || !Number.isSafeInteger(purchase.logIndex) || purchase.logIndex < 0) throw new Error("Purchase identity is invalid.");
    return { transactionHash: hash(purchase.transactionHash), logIndex: purchase.logIndex };
  });
  return { raffleIds, purchases };
}
export async function privateRecords(store: Store, request: SignedWorkflowInput<RecordsInput>, context: WorkflowContext, verify: WorkflowVerifier): Promise<PrivateRecords> {
  const input = parseRecordsInput(request.input);
  await verifyWorkflowAuthorization({ operation: "private records", context, account: request.address, input, deadline: request.deadline, signature: request.signature, verify });
  const result: PrivateRecords = { agreements: [], receipts: [] };
  for (const raffleId of input.raffleIds) {
    const identity = authorizationMessage("agreement identity", context, { address: request.address.toLowerCase(), pieceId: raffleId, termsHash: context.termsHash.toLowerCase() });
    const raw = await store.get(`agree:v2:${keccak256(toBytes(identity))}`);
    let recorded = false, at: string | null = null;
    if (raw) {
      const record: unknown = JSON.parse(raw);
      if (!record || typeof record !== "object" || !("address" in record) || typeof record.address !== "string" || !sameAddress(record.address, request.address) || !("deadline" in record) || typeof record.deadline !== "string" || !("signature" in record) || !("at" in record) || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at)) || !("identity" in record) || record.identity !== identity) throw new Error("Stored agreement is invalid.");
      const message = agreementMessage({ address: request.address, pieceId: raffleId, terms: true, rules: true, age: true, termsHash: context.termsHash, deadline: record.deadline, signature: "0x" }, context);
      recorded = await authorizedRequest(request.address, record.deadline, record.signature, message, Date.parse(record.at), verify);
      if (!recorded) throw new Error("Stored agreement signature is invalid.");
      at = record.at;
    }
    result.agreements.push({ raffleId, recorded, at });
  }
  for (const purchase of input.purchases) {
    const identity = `${context.chainId}:${context.contract.toLowerCase()}:${purchase.transactionHash.toLowerCase()}:${purchase.logIndex}`;
    const key = `receipt:v2:${keccak256(toBytes(identity))}`;
    const raw = await store.get(key);
    let status: "missing" | "pending" | "delivered" = "missing";
    if (raw) {
      const record: unknown = JSON.parse(raw);
      if (record && typeof record === "object" && "address" in record && typeof record.address === "string" && sameAddress(record.address, request.address) && "identity" in record && record.identity === identity) status = await store.get(`${key}:sent`) === "delivered" ? "delivered" : "pending";
    }
    result.receipts.push({ ...purchase, status });
  }
  return result;
}
