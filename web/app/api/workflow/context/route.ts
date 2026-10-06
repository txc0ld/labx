import { serverWorkflow } from "@/lib/chain/server";
export async function GET() {
  try { const { context } = await serverWorkflow(); return Response.json({ ok: true, context }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ ok: false, error: "A verified workflow deployment is not available." }, { status: 503 }); }
}
