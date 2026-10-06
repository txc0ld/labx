import { serverWorkflow } from "@/lib/chain/server";
import { parseEnvelope } from "@/lib/workflow-records";
import { parseRecordsInput, privateRecords } from "@/lib/private-records";
import { activeStore } from "@/lib/store";
export async function POST(request: Request) {
  try {
    const body = parseEnvelope(await request.json()), input = parseRecordsInput(body.input);
    const { context, client } = await serverWorkflow();
    const records = await privateRecords(activeStore(), { ...body, input }, context, args => client.verifyMessage(args));
    return Response.json({ ok: true, ...records }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ ok: false, error: "Private records could not be verified for this wallet." }, { status: 401 }); }
}
