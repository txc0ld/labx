import { recordAgreement } from "@/lib/agreement-record";
import { requestContext } from "@/lib/request-auth";
import type { Hex } from "viem";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await recordAgreement(activeStore(), body, { ...requestContext(), termsHash: (process.env.TERMS_HASH || "0x") as Hex });
    return json({ ok: true, ...result });
  } catch (error) {
    const safe = error instanceof Error && /^(A wallet|A valid wallet|All three agreements|Agreement |Sepolia request|Persistent Redis|Store )/.test(error.message);
    return fail(new Error(safe ? (error as Error).message : "Agreement request could not be completed."));
  }
}
