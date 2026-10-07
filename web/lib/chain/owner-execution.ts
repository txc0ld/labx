import { decodeEventLog, encodeFunctionData, type Hex, type PublicClient } from "viem";
import { raffleAbi } from "./abi";
import type { createReader } from "./reader";
import type { DeploymentManifest, OwnerExecutionConfirmation, OwnerExecutionIntent } from "./types";
import { hash, positiveId, sameAddress } from "./validation";

// This confirms chain execution, never a Safe proposal or an EOA journal entry.
export function ownerExecutionConfirmer(client: PublicClient, manifest: DeploymentManifest, reader: ReturnType<typeof createReader>) {
  return async function confirmOwnerExecution({ intent, hash: executionHash, timeoutMs = 60_000 }: {
    intent: OwnerExecutionIntent; hash: Hex; timeoutMs?: number;
  }): Promise<OwnerExecutionConfirmation> {
    hash(executionHash); positiveId(intent.action.id); hash(intent.action.expectedReviewHash);
    if (intent.chainId !== manifest.chainId || !sameAddress(intent.to, manifest.address) || intent.value !== 0n
      || (intent.action.kind !== "approveRaffle" && intent.action.kind !== "revokeRaffleApproval")) throw new Error("Owner execution intent does not match this deployment.");
    const expectedData = encodeFunctionData({ abi: raffleAbi, functionName: intent.action.kind, args: [intent.action.id, intent.action.expectedReviewHash] });
    if (intent.data !== expectedData) throw new Error("Owner execution calldata does not match its review.");
    await reader.checkedBlock(intent.reviewBlock);
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({ hash: executionHash, confirmations: 2, timeout: Math.max(1000, Math.min(timeoutMs, 120_000)) });
    } catch (error) {
      if (error instanceof Error && /Timeout|timed out/i.test(error.name + error.message)) return { kind: "pending", hash: executionHash };
      throw error;
    }
    if (receipt.status !== "success" || receipt.transactionHash !== executionHash || receipt.blockNumber < intent.reviewBlock.number) throw new Error("No successful execution matches this review.");
    const receiptBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (receiptBlock.hash !== receipt.blockHash) throw new Error("Execution block changed. Refresh confirmation.");
    let matched = false;
    let nextRevision: bigint | null = null;
    for (const log of receipt.logs) {
      if (!sameAddress(log.address, manifest.address) || log.removed) continue;
      let decoded;
      try { decoded = decodeEventLog({ abi: raffleAbi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
      if (decoded.eventName !== "RaffleApproved" && decoded.eventName !== "RaffleApprovalRevoked") continue;
      const expectedEvent = intent.action.kind === "approveRaffle" ? "RaffleApproved" : "RaffleApprovalRevoked";
      if (decoded.eventName !== expectedEvent || decoded.args.id !== intent.action.id || !sameAddress(decoded.args.approver, intent.from) || decoded.args.reviewHash !== intent.action.expectedReviewHash) continue;
      if (decoded.eventName === "RaffleApprovalRevoked") {
        if (decoded.args.nextRevision !== intent.reviewRevision + 1n) continue;
        nextRevision = decoded.args.nextRevision;
      }
      matched = true;
    }
    if (!matched) throw new Error("Receipt contains no matching raffle approval event. A Safe proposal or failed inner call is not execution.");
    const review = await reader.readAdmission({ id: intent.action.id });
    const record = review.snapshot.admission.record;
    const generationsMatch = review.ownerGeneration === intent.ownerGeneration && review.openingPolicyGeneration === intent.openingPolicyGeneration && sameAddress(review.snapshot.owner, intent.from);
    const state = intent.action.kind === "approveRaffle"
      ? generationsMatch && record.approvedReviewHash === intent.action.expectedReviewHash && sameAddress(record.approvedBy, intent.from)
        && (review.snapshot.admission.status === "approved" || review.snapshot.admission.status === "opened") ? "approved" : "stale"
      : generationsMatch && review.snapshot.admission.status === "pending" && record.reviewRevision === nextRevision ? "revoked" : "stale";
    // Recheck after all reads so a reorg during reconciliation cannot complete this action.
    if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error("Execution block changed. Refresh confirmation.");
    await reader.checkedBlock(review.snapshot.block);
    return { kind: "executed", hash: executionHash, blockNumber: receipt.blockNumber, state, review };
  };
}
