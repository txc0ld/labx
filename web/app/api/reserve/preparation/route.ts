import { workflowRequestBody } from "@/lib/chain/request-body";
import { activeStore } from "@/lib/store";
import { serverWorkflow } from "@/lib/chain/server";
import { parseEnvelope, parsePreparationRecovery, recoverAuthenticatedPreparation } from "@/lib/workflow-records";
import { workflowFailure, type WorkflowStage } from "@/lib/workflow-failure";
export async function POST(request: Request) {
  let stage: WorkflowStage = "request";
  try {
    const body = parseEnvelope(await workflowRequestBody(request));
    const input = parsePreparationRecovery(body.input);
    stage = "deployment";
    const { context, client } = await serverWorkflow();
    stage = "records";
    const result = await recoverAuthenticatedPreparation(activeStore(), { ...body, input }, context, args => client.verifyMessage(args));
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return workflowFailure("reserve/preparation", stage, error, {
      invalid: "The raffle setup request was invalid.",
      refused: "The signature wasn't accepted. Use the wallet that created this raffle and try again.",
      unavailable: "Your raffle setup couldn't be restored right now. Try again in a minute."
    });
  }
}
