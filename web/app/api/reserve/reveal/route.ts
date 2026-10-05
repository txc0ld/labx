import { isAddress, type Address, type Hex } from "viem";
import { revealReserve } from "@/lib/reserve";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { commit?: string; seller?: string; signature?: string };
    if (!body.commit || !body.signature || !body.seller || !isAddress(body.seller)) {
      return fail(new Error("Commit, seller, and signature are required."));
    }
    const record = await revealReserve(activeStore(), {
      commit: body.commit as Hex,
      seller: body.seller as Address,
      signature: body.signature as Hex
    });
    return json({ ok: true, ...record });
  } catch (error) {
    return fail(error, 401);
  }
}
