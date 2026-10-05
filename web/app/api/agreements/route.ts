import { assertAgreements } from "@/lib/agreements";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    assertAgreements(body);
    const store = activeStore();
    const key = `agree:${body.address.toLowerCase()}:${body.pieceId || "general"}:${Date.now()}`;
    await store.set(
      key,
      JSON.stringify({ ...body, at: new Date().toISOString() })
    );
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
