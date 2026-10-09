import { workflowRequestBody } from "@/lib/chain/request-body";
import { activeStore } from "@/lib/store";
import { serverWorkflow } from "@/lib/chain/server";
import { parseEnvelope, parsePreparationRecovery, recoverAuthenticatedPreparation } from "@/lib/workflow-records";
export async function POST(request: Request) {
  try {
    const body = parseEnvelope(await workflowRequestBody(request));
    const input = parsePreparationRecovery(body.input);
    const { context, client } = await serverWorkflow();
    const result = await recoverAuthenticatedPreparation(activeStore(), { ...body, input }, context, args => client.verifyMessage(args));
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, error: "Preparation recovery is unavailable. Reconnect the same wallet and retry recovery." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
