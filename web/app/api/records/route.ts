import { workflowRequestBody } from "@/lib/chain/request-body";
import { serverWorkflow } from "@/lib/chain/server";
import { parseEnvelope } from "@/lib/workflow-records";
import { parseRecordsInput, privateRecords } from "@/lib/private-records";
import { activeStore } from "@/lib/store";
import { workflowFailure, type WorkflowStage } from "@/lib/workflow-failure";
export async function POST(request: Request) {
  let stage: WorkflowStage = "request";
  try {
    const body = parseEnvelope(await workflowRequestBody(request)), input = parseRecordsInput(body.input);
    stage = "deployment";
    const { context, client } = await serverWorkflow();
    stage = "records";
    const records = await privateRecords(activeStore(), { ...body, input }, context, args => client.verifyMessage(args));
    return Response.json({ ok: true, ...records }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return workflowFailure("records", stage, error, {
      invalid: "The records request was invalid.",
      refused: "Private records could not be verified for this wallet.",
      unavailable: "Private records couldn't be loaded right now. Try again in a minute."
    });
  }
}
