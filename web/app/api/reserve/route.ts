import { workflowRequestBody } from "@/lib/chain/request-body";
import { activeStore } from "@/lib/store";
import { serverWorkflow } from "@/lib/chain/server";
import { parseCommitmentInput, parseEnvelope, saveAuthenticatedCommitment } from "@/lib/workflow-records";
import { erc721Abi } from "viem";
import { sameAddress } from "@/lib/chain/validation";
export async function POST(request: Request) {
  try {
    const body = parseEnvelope(await workflowRequestBody(request)), input = parseCommitmentInput(body.input);
    const { context, client, block } = await serverWorkflow();
    const owner = await client.readContract({ address: input.nft, abi: erc721Abi, functionName: "ownerOf", args: [BigInt(input.tokenId)], blockNumber: block.number });
    if (!sameAddress(owner, body.address)) throw new Error("The connected seller must own the NFT.");
    const result = await saveAuthenticatedCommitment(activeStore(), { ...body, input }, context, args => client.verifyMessage(args));
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ ok: false, error: "Commitment could not be saved. Check wallet ownership, authorization and deployment/storage availability." }, { status: 400 }); }
}
