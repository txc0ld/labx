import { workflowRequestBody } from "@/lib/chain/request-body";
import { activeStore } from "@/lib/store";
import { serverWorkflow, signatureVerifier } from "@/lib/chain/server";
import { parseEnvelope, recoverAuthenticatedCommitment } from "@/lib/workflow-records";
import { hash } from "@/lib/chain/validation";
import { workflowFailure, type WorkflowStage } from "@/lib/workflow-failure";
export async function POST(request: Request) {
  let stage: WorkflowStage = "request";
  try {
    const body = parseEnvelope(await workflowRequestBody(request));
    if (!body.input || typeof body.input !== "object" || !("commit" in body.input)) throw new Error("A commitment hash is required.");
    const input = { commit: hash(body.input.commit) };
    stage = "deployment";
    const { context, client } = await serverWorkflow();
    stage = "records";
    const result = await recoverAuthenticatedCommitment(activeStore(), { ...body, input }, context, signatureVerifier(client));
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return workflowFailure("reserve/reveal", stage, error, {
      invalid: "The draw setup request was invalid.",
      refused: "The signature wasn't accepted. Use the seller wallet and try again.",
      unavailable: "The draw setup couldn't be loaded right now. Try again in a minute."
    });
  }
}
