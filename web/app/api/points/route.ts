import { isAddress, type Address } from "viem";
import { readPoints } from "@/lib/points";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address || !isAddress(address)) return fail(new Error("A wallet address is required."));
  const points = await readPoints(activeStore(), address as Address);
  return json({ ok: true, address, ...points, persistent: Boolean(process.env.UPSTASH_REDIS_REST_URL) });
}
