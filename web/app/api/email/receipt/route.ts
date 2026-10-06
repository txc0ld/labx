import { isHex } from "viem";
import { address, hash } from "@/lib/chain/validation";
import { workflowRequestBody } from "@/lib/chain/request-body";
import { deliverPurchaseReceipt, resendSender } from "@/lib/receipt-delivery";
import { serverWorkflow } from "@/lib/chain/server";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = await workflowRequestBody(request);
    const key = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    if (!key || !from) return fail(new Error("Receipt delivery is not configured."), 503);
    const { context, client } = await serverWorkflow();
    const transportIdentity = createHash("sha256").update(key).digest("hex");
    if (typeof body.to !== "string" || typeof body.logIndex !== "number" || typeof body.deadline !== "string" || typeof body.signature !== "string" || !isHex(body.signature)) throw new Error("Receipt request is invalid.");
    const input = { address: address(body.address), to: body.to, transactionHash: hash(body.transactionHash), logIndex: body.logIndex, deadline: body.deadline, signature: body.signature };
    const result = await deliverPurchaseReceipt(activeStore(), input, context, client, resendSender(key), from, transportIdentity, Date.now(), args => client.verifyMessage(args));
    return json({ ok: true, ...result });
  } catch (error) {
    // Do not expose RPC/provider URLs, headers or upstream error bodies.
    const safe = error instanceof Error && /^(A valid|A purchase|A finalized|Receipt |Sepolia request|Persistent Redis|Store )/.test(error.message);
    return fail(new Error(safe ? (error as Error).message : "Receipt request could not be completed."));
  }
}
import { createHash } from "node:crypto";
