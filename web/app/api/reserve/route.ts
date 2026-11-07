import { workflowRequestBody } from "@/lib/chain/request-body";
import { activeStore } from "@/lib/store";
import { serverWorkflow, signatureVerifier } from "@/lib/chain/server";
import { parseCommitmentInput, parseEnvelope, saveAuthenticatedCommitment } from "@/lib/workflow-records";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, InternalRpcError, erc721Abi } from "viem";
import { sameAddress } from "@/lib/chain/validation";
import { WorkflowMissing, WorkflowRefusal, workflowFailure, type WorkflowStage } from "@/lib/workflow-failure";
/**
 * Whether ownerOf failed because the contract has no such token or no code, not because the node couldn't be reached.
 * viem also reports a node's internal error (-32603) as a revert, so that stays an outage.
 */
function missingToken(error: unknown) {
  return error instanceof BaseError && error.walk(cause => cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError) !== null
    && error.walk(cause => cause instanceof InternalRpcError) === null;
}
export async function POST(request: Request) {
  let stage: WorkflowStage = "request";
  try {
    const body = parseEnvelope(await workflowRequestBody(request)), input = parseCommitmentInput(body.input);
    stage = "deployment";
    const { context, client, block } = await serverWorkflow();
    stage = "records";
    const result = await saveAuthenticatedCommitment(activeStore(), { ...body, input }, context, signatureVerifier(client), async signed => {
      const owner = await client.readContract({ address: signed.nft, abi: erc721Abi, functionName: "ownerOf", args: [BigInt(signed.tokenId)], blockNumber: block.number })
        .catch((error: unknown) => { throw missingToken(error) ? new WorkflowMissing("No such NFT.") : error; });
      if (!sameAddress(owner, body.address)) throw new WorkflowRefusal("The connected seller must own the NFT.");
    });
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return workflowFailure("reserve", stage, error, {
      invalid: "The raffle setup request was invalid.",
      refused: "The signature wasn't accepted, or this wallet doesn't own the NFT.",
      unavailable: "The raffle setup couldn't be saved right now. Try again in a minute.",
      missing: "That NFT couldn't be found. Check the contract and token ID."
    });
  }
}
