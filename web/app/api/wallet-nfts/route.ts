import { createWalletNftHandler } from "@/lib/wallet-nfts-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = createWalletNftHandler({
  apiKey: process.env.ALCHEMY_NFT_API_KEY,
  trustedVercel: process.env.VERCEL === "1"
});

export async function GET(request: Request) {
  return handle(request);
}
