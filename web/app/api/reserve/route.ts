import { workflowRequestBody } from "@/lib/chain/request-body";
import { activeStore } from "@/lib/store";
import { serverWorkflow } from "@/lib/chain/server";
import { parseCommitmentInput, parseEnvelope, saveAuthenticatedCommitment } from "@/lib/workflow-records";
import { erc721Abi } from "viem";
import { sameAddress } from "@/lib/chain/validation";
import { WorkflowRefusal, workflowFailure, type WorkflowStage } from "@/lib/workflow-failure";
export async function POST(request: Request) {
  let stage: WorkflowStage = "request";
  try {
    const body = parseEnvelope(await workflowRequestBody(request)), input = parseCommitmentInput(body.input);
    stage = "deployment";
    const { context, client, block } = await serverWorkflow();
    stage = "records";
    const result = await saveAuthenticatedCommitment(activeStore(), { ...body, input }, context, args => client.verifyMessage(args), async signed => {
      const owner = await client.readContract({ address: signed.nft, abi: erc721Abi, functionName: "ownerOf", args: [BigInt(signed.tokenId)], blockNumber: block.number });
      if (!sameAddress(owner, body.address)) throw new WorkflowRefusal("The connected seller must own the NFT.");
    });
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return workflowFailure("reserve", stage, error, {
      invalid: "The raffle setup request was invalid.",
      refused: "The signature wasn't accepted, or this wallet doesn't own the NFT.",
      unavailable: "The raffle setup couldn't be saved right now. Try again in a minute."
    });
  }
}
