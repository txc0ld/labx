import { activeStore } from "@/lib/store";
import { serverWorkflow } from "@/lib/chain/server";
import { parseEnvelope, recoverAuthenticatedCommitment } from "@/lib/workflow-records";
import { hash } from "@/lib/chain/validation";
export async function POST(request: Request) {
  try {
    const body = parseEnvelope(await request.json());
    if (!body.input || typeof body.input !== "object" || !("commit" in body.input)) throw new Error("A commitment hash is required.");
    const input = { commit: hash(body.input.commit) };
    const { context, client } = await serverWorkflow();
    const result = await recoverAuthenticatedCommitment(activeStore(), { ...body, input }, context, args => client.verifyMessage(args));
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ ok: false, error: "Commitment recovery was refused or its durable record is unavailable." }, { status: 401 }); }
}
