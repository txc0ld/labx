import { TransactionNotFoundError, WaitForTransactionReceiptTimeoutError, decodeEventLog, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { raffleAbi } from "./abi";
import type { createReader } from "./reader";
import type { DeploymentManifest, OwnerExecutionConfirmation, OwnerExecutionIntent } from "./types";
import { address, hash, positiveId, sameAddress } from "./validation";

function canonicalHash(value: unknown): Hex { return hash(hash(value).toLowerCase()); }
function sameHash(a: unknown, b: unknown): boolean { return canonicalHash(a) === canonicalHash(b); }
function canonicalData(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("Invalid owner execution calldata.");
  return `0x${value.slice(2).toLowerCase()}`;
}

// This confirms chain execution, never a Safe proposal or an EOA journal entry.
export function ownerExecutionConfirmer(client: PublicClient, manifest: DeploymentManifest, reader: ReturnType<typeof createReader>) {
  return async function confirmOwnerExecution({ intent, hash: suppliedExecutionHash, timeoutMs = 60_000 }: {
    intent: OwnerExecutionIntent; hash: Hex; timeoutMs?: number;
  }): Promise<OwnerExecutionConfirmation> {
    const executionHash = canonicalHash(suppliedExecutionHash);
    const reviewBlock = { ...intent.reviewBlock, hash: canonicalHash(intent.reviewBlock.hash) };
    positiveId(intent.action.id); hash(intent.action.expectedReviewHash);
    if (!sameHash(intent.runtimeCodeHash, manifest.runtimeCodeHash) || intent.chainId !== manifest.chainId || !sameAddress(intent.to, manifest.address) || intent.value !== 0n
      || (intent.action.kind !== "approveRaffle" && intent.action.kind !== "revokeRaffleApproval")) throw new Error("Owner execution intent does not match this deployment.");
    const expectedData = encodeFunctionData({ abi: raffleAbi, functionName: intent.action.kind, args: [intent.action.id, intent.action.expectedReviewHash] });
    if (canonicalData(intent.data) !== canonicalData(expectedData)) throw new Error("Owner execution calldata does not match its review.");
    await reader.checkedBlock(reviewBlock);
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({ hash: executionHash, confirmations: 2, timeout: Math.max(1000, Math.min(timeoutMs, 120_000)) });
    } catch (error) {
      if (error instanceof WaitForTransactionReceiptTimeoutError) {
        let transaction;
        try { transaction = await client.getTransaction({ hash: executionHash }); }
        catch (lookupError) {
          if (lookupError instanceof TransactionNotFoundError) throw new Error("Ethereum transaction not found. Use the actual executed Ethereum transaction hash, or retry after broadcast.");
          throw lookupError;
        }
        if (!sameHash(transaction.hash, executionHash)) throw new Error("Returned Ethereum transaction does not match the execution hash.");
        return { kind: "pending", hash: executionHash };
      }
      throw error;
    }
    if (receipt.status !== "success" || !sameHash(receipt.transactionHash, executionHash) || receipt.blockNumber < intent.reviewBlock.number) throw new Error("No successful execution matches this review.");
    const receiptBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (!sameHash(receiptBlock.hash, receipt.blockHash)) throw new Error("Execution block changed. Refresh confirmation.");
    let matched = false;
    let nextRevision: bigint | null = null;
    for (const log of receipt.logs) {
      if (!sameAddress(log.address, manifest.address) || log.removed) continue;
      let decoded;
      try { decoded = decodeEventLog({ abi: raffleAbi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
      if (decoded.eventName !== "RaffleApproved" && decoded.eventName !== "RaffleApprovalRevoked") continue;
      const expectedEvent = intent.action.kind === "approveRaffle" ? "RaffleApproved" : "RaffleApprovalRevoked";
      if (decoded.eventName !== expectedEvent || decoded.args.id !== intent.action.id || !sameAddress(decoded.args.approver, intent.from) || !sameHash(decoded.args.reviewHash, intent.action.expectedReviewHash)) continue;
      if (decoded.eventName === "RaffleApprovalRevoked") {
        if (decoded.args.nextRevision !== intent.reviewRevision + 1n) continue;
        nextRevision = decoded.args.nextRevision;
      }
      matched = true;
    }
    if (!matched) throw new Error("Receipt contains no matching raffle approval event. A Safe proposal or failed inner call is not execution.");
    const review = await reader.readAdmission({ id: intent.action.id });
    if (review.snapshot.block.number < receipt.blockNumber + 1n) throw new Error("Admission state does not include the required execution confirmation depth.");
    const record = review.snapshot.admission.record;
    const generationsMatch = review.ownerGeneration === intent.ownerGeneration && review.openingPolicyGeneration === intent.openingPolicyGeneration && sameAddress(review.snapshot.owner, intent.from);
    const state = intent.action.kind === "approveRaffle"
      ? generationsMatch && sameHash(record.approvedReviewHash, intent.action.expectedReviewHash) && sameAddress(record.approvedBy, intent.from)
        && (review.snapshot.admission.status === "approved" || review.snapshot.admission.status === "opened") ? "approved" : "stale"
      : generationsMatch && review.snapshot.admission.status === "pending" && record.reviewRevision === nextRevision ? "revoked" : "stale";
    // Recheck after all reads so a reorg during reconciliation cannot complete this action.
    if (!sameHash((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash)) throw new Error("Execution block changed. Refresh confirmation.");
    await reader.checkedBlock(review.snapshot.block);
    await reader.checkedBlock(reviewBlock);
    return { kind: "executed", hash: executionHash, blockNumber: receipt.blockNumber, state, review };
  };
}

export function serializeOwnerExecutionIntent(intent: OwnerExecutionIntent): string {
  return JSON.stringify(intent, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}

export function parseOwnerExecutionIntent(raw: string, manifest: DeploymentManifest, owner: Address): OwnerExecutionIntent {
  if (typeof raw !== "string" || raw.length > 8192) throw new Error("Invalid stored owner review.");
  const object = (value: unknown): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid stored owner review.");
    return Object.fromEntries(Object.entries(value));
  };
  const integer = (value: unknown): bigint => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error("Invalid stored review integer.");
    const parsed = BigInt(value);
    if (parsed >= 2n ** 256n) throw new Error("Stored review integer is too large.");
    return parsed;
  };
  const root = object(JSON.parse(raw)), action = object(root.action), block = object(root.reviewBlock);
  const id = integer(action.id); positiveId(id);
  const expectedReviewHash = canonicalHash(action.expectedReviewHash);
  let parsedAction: OwnerExecutionIntent["action"];
  if (action.kind === "approveRaffle") {
    const attestations = object(action.attestations);
    if (attestations.canonicalProvenance !== true || attestations.transferRestrictions !== true || attestations.drawFunding !== true) throw new Error("Stored review attestations are incomplete.");
    parsedAction = { kind: action.kind, id, expectedReviewHash, attestations: { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } };
  } else if (action.kind === "revokeRaffleApproval") parsedAction = { kind: action.kind, id, expectedReviewHash };
  else throw new Error("Unsupported stored owner action.");
  const from = address(root.from), to = address(root.to), runtimeCodeHash = canonicalHash(root.runtimeCodeHash);
  const data = encodeFunctionData({ abi: raffleAbi, functionName: parsedAction.kind, args: [id, expectedReviewHash] });
  if (root.chainId !== manifest.chainId || !sameAddress(from, owner) || !sameAddress(to, manifest.address)
    || !sameHash(runtimeCodeHash, manifest.runtimeCodeHash) || root.value !== "0" || canonicalData(root.data) !== canonicalData(data)) throw new Error("Stored owner review belongs to a different account or deployment.");
  const number = integer(block.number);
  if (number < manifest.deploymentBlock) throw new Error("Stored review predates the deployment.");
  return { action: parsedAction, chainId: manifest.chainId, runtimeCodeHash, from, to, value: 0n, data,
    reviewBlock: { number, hash: canonicalHash(block.hash), timestamp: integer(block.timestamp) },
    ownerGeneration: integer(root.ownerGeneration), openingPolicyGeneration: integer(root.openingPolicyGeneration), reviewRevision: integer(root.reviewRevision) };
}
