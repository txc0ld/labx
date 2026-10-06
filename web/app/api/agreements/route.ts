import { recordAgreement } from "@/lib/agreement-record";
import { activeStore } from "@/lib/store";
import { serverWorkflow } from "@/lib/chain/server";
import { raffleAbi } from "@/lib/chain/abi";
import { requirePublishedTerms, TERMS_VERSION } from "@/lib/published-terms";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (typeof body?.pieceId !== "string" || !/^[1-9]\d{0,77}$/.test(body.pieceId)) throw new Error("An on-chain raffle ID is required.");
    const { context, client, block } = await serverWorkflow();
    const policy = await client.readContract({ address: context.contract, abi: raffleAbi, functionName: "getRafflePolicy", args: [BigInt(body.pieceId)], blockNumber: block.number });
    requirePublishedTerms(policy.termsHash);
    const result = await recordAgreement(activeStore(), body, context, Date.now(), args => client.verifyMessage(args));
    return Response.json({ ok: true, recorded: true, ...result, termsHash: context.termsHash, version: TERMS_VERSION }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ ok: false, error: "Agreement was not saved. Verify the published terms, wallet authorization and persistent storage." }, { status: 400 }); }
}
