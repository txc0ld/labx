import { isAddress, type Address } from "viem";
import { createReserve } from "@/lib/reserve";
import { activeStore } from "@/lib/store";
import { fail, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      seller?: string;
      nft?: string;
      tokenId?: string;
      publicSummary?: string;
      privateCommitment?: string;
    };
    if (!body.seller || !isAddress(body.seller)) return fail(new Error("Seller wallet is required."));
    if (!body.nft || !isAddress(body.nft)) return fail(new Error("Prize contract is required."));
    const labx = process.env.NEXT_PUBLIC_RAFFLE_ADDRESS;
    const chainRaw = process.env.NEXT_PUBLIC_CHAIN_ID;
    if (!labx || !isAddress(labx)) return fail(new Error("Raffle address is not configured."));
    if (!chainRaw || chainRaw === "1") return fail(new Error("Sepolia is the only supported chain."));
    const record = await createReserve(activeStore(), {
      seller: body.seller,
      nft: body.nft,
      tokenId: body.tokenId || "0",
      publicSummary: body.publicSummary || "",
      privateCommitment: body.privateCommitment || "",
      chainId: BigInt(chainRaw),
      labx: labx as Address
    });
    return json({ ok: true, ...record });
  } catch (error) {
    return fail(error);
  }
}
