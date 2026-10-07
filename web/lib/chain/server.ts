import { createPublicClient, http, type Address, type Hex } from "viem";
import { APPROVED_DEPLOYMENTS, attestDeployment } from "./deployment";
import { sameAddress } from "./validation";
import { parseLocalManifest } from "./manifest";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../published-terms";
import { publicSiteUrl } from "../operator";
import type { WorkflowContext } from "./api-types";
import { workflowMessage } from "./messages";
export async function serverWorkflow() {
  let manifest = APPROVED_DEPLOYMENTS.find(item => item.chainId === 11155111 && process.env.NEXT_PUBLIC_RAFFLE_ADDRESS && sameAddress(item.address, process.env.NEXT_PUBLIC_RAFFLE_ADDRESS));
  let rpc = process.env.NEXT_PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  let origin = new URL(publicSiteUrl()).origin;
  if (process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST) {
    let localManifest;
    try { localManifest = parseLocalManifest(JSON.parse(process.env.NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST)); }
    catch { throw new Error("Local fixture configuration is invalid."); }
    const localRpc = new URL(process.env.NEXT_PUBLIC_LOCAL_RPC_URL || "http://127.0.0.1:8545");
    const localOrigin = new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3113");
    if (!["localhost", "127.0.0.1"].includes(localRpc.hostname) || !["localhost", "127.0.0.1"].includes(localOrigin.hostname)) throw new Error("Local fixtures require loopback endpoints.");
    manifest = localManifest;
    rpc = localRpc.href; origin = localOrigin.origin;
  }
  if (!manifest) throw new Error("A reviewed raffle deployment is not configured.");
  const client = createPublicClient({ transport: http(rpc, { timeout: 15_000, retryCount: 1 }) });
  const attested = await attestDeployment(client, manifest);
  if (attested.kind !== "verified") throw new Error(attested.reason);
  const context: WorkflowContext = { origin, chainId: manifest.chainId, contract: manifest.address, termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
  return { context, manifest, client, block: attested.block };
}
export async function verifyWorkflowAuthorization(args: {
  operation: Parameters<typeof workflowMessage>[0]; context: WorkflowContext; account: Address; input: unknown; deadline: string; signature: Hex;
  verify: (args: { address: Address; message: string; signature: Hex }) => Promise<boolean>; now?: number;
}) {
  const now = BigInt(Math.floor((args.now ?? Date.now()) / 1000));
  if (!/^\d{1,12}$/.test(args.deadline) || BigInt(args.deadline) < now || BigInt(args.deadline) > now + 600n) throw new Error("Wallet authorization expired. Please retry.");
  const message = workflowMessage(args.operation, args.context, args.account, args.input, args.deadline);
  if (!await args.verify({ address: args.account, message, signature: args.signature })) throw new Error("Wallet authorization was refused.");
  return message;
}
