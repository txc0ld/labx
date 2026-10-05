import { isAddress, type Address, type Hex } from "viem";
import { revealReserve } from "@/lib/reserve";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { commit?: string; seller?: string; signature?: string; deadline?: string | number };
    if (!body.commit || !body.signature || !body.seller || !isAddress(body.seller) || body.deadline === undefined) {
      return fail(new Error("Commit, seller, signature, and deadline are required."));
    }
    const record = await revealReserve(activeStore(), {
      commit: body.commit as Hex,
      seller: body.seller as Address,
      signature: body.signature as Hex,
      deadline: BigInt(body.deadline)
    });
    return json({ ok: true, ...record });
  } catch (error) {
    return fail(error, 401);
  }
}
