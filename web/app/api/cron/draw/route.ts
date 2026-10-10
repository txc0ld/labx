import { serverWorkflow } from "@/lib/chain/server";
import { createDrawChain } from "@/lib/draw-runner/chain";
import { createDrawCronHandler } from "@/lib/draw-runner/http";
import { activeStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = createDrawCronHandler({
  store: activeStore,
  async chain(account) {
    const { client, manifest } = await serverWorkflow();
    return createDrawChain({ client, manifest, account });
  }
});
