import { BaseError, createPublicClient, custom, ExecutionRevertedError, http, HttpRequestError, isHex, recoverMessageAddress, RpcRequestError, TimeoutError, type Address, type Hex, type PublicClient } from "viem";
import { getNodeError } from "viem/utils";
import { APPROVED_DEPLOYMENTS, attestDeployment } from "./deployment";
import { sameAddress } from "./validation";
import { parseLocalManifest } from "./manifest";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../published-terms";
import { publicSiteUrl } from "../operator";
import type { WorkflowContext } from "./api-types";
import { workflowMessage } from "./messages";
import { WorkflowRefusal } from "../workflow-failure";
import type { SignatureVerifier } from "../request-auth";
/** Server reads never follow an off-chain lookup (CCIP-Read), so a contract named in a request cannot make LABx fetch a URL. */
export function serverClient(rpc: string) {
  return createPublicClient({ ccipRead: false, transport: http(rpc, { timeout: 15_000, retryCount: 1 }) });
}
/**
 * Checks a wallet signature. A plain wallet signature is recovered locally, with no RPC. Any other signature (ERC-1271,
 * ERC-6492 or ERC-8010) needs the node, and viem reports a failed node call as an invalid signature, so this throws when the
 * node gave no verdict (hex data or a revert) or viem could not read its answer, and refuses a signature that cannot be decoded.
 */
export function signatureVerifier(client: Pick<PublicClient, "request">): SignatureVerifier {
  return async ({ address, message, signature }) => {
    try { if (sameAddress(await recoverMessageAddress({ message, signature }), address)) return true; } catch { /* Not a plain wallet signature, so the node decides. */ }
    let asked = false, unanswered = false;
    const observed = createPublicClient({ ccipRead: false, transport: custom({
      async request(args) {
        asked = true;
        let result: unknown;
        try { result = await client.request(args); }
        catch (error) { if (!reverted(error)) unanswered = true; throw error; }
        // Every answer this check reads (eth_call, eth_getCode) is hex data. A missing or null result is no answer.
        // Hex the wallet contract's isValidSignature cannot decode (ERC-1271, or a delegated ERC-8010 wallet) stays a refusal:
        // viem reads it as invalid, and a corrupted provider answer cannot be told from the contract's own, so this fails closed.
        if (!isHex(result)) { unanswered = true; throw new Error("The node returned no result."); }
        return result;
      }
    }, { retryCount: 0 }) });
    // viem throws, rather than answering false, for a signature it cannot decode, before any node request, and for node data it cannot read.
    // Accepted: a crafted ERC-8010 authorization that fails recovery (r = s = 0) only does so after eth_getCode, so it answers 503.
    const valid = await observed.verifyMessage({ address, message, signature }).catch(() => asked ? undefined : false);
    if (valid === undefined || !valid && unanswered) throw new Error("The node did not check the signature.");
    return valid;
  };
}
/** A revert is the wallet contract's answer. A failed HTTP request or a timeout never is, whatever its body says. */
function reverted(error: unknown) {
  if (!(error instanceof BaseError) || error.walk(cause => cause instanceof HttpRequestError || cause instanceof TimeoutError) !== null) return false;
  // Nethermind and OpenEthereum report a revert as -32015 "VM execution error." with data "Reverted 0x…".
  return getNodeError(error, {}) instanceof ExecutionRevertedError
    || error.walk(cause => cause instanceof RpcRequestError && cause.code === -32015 && typeof cause.data === "string" && cause.data.startsWith("Reverted")) !== null;
}
/** publicnode's US servers keep only about 25,000 blocks of logs ("pruned history unavailable"); this public gateway keeps all of Sepolia. */
export const SEPOLIA_HISTORY_RPC = "https://sepolia.gateway.tenderly.co";
/** Asked only for logs the configured RPC has pruned, once per read with no retry. Transactions never use this client. */
export function historyClient(historyRpc: string) {
  return createPublicClient({ ccipRead: false, transport: http(historyRpc, { timeout: 8_000, retryCount: 0 }) });
}
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
  const client = serverClient(rpc);
  const attested = await attestDeployment(client, manifest);
  if (attested.kind !== "verified") throw new Error(attested.reason);
  const context: WorkflowContext = { origin, chainId: manifest.chainId, contract: manifest.address, termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
  const history = manifest.chainId === 11155111 ? historyClient(SEPOLIA_HISTORY_RPC) : null;
  return { context, manifest, client, history, block: attested.block };
}
export async function verifyWorkflowAuthorization(args: {
  operation: Parameters<typeof workflowMessage>[0]; context: WorkflowContext; account: Address; input: unknown; deadline: string; signature: Hex;
  verify: (args: { address: Address; message: string; signature: Hex }) => Promise<boolean>; now?: number;
}) {
  const now = BigInt(Math.floor((args.now ?? Date.now()) / 1000));
  if (!/^\d{1,12}$/.test(args.deadline) || BigInt(args.deadline) < now || BigInt(args.deadline) > now + 600n) throw new WorkflowRefusal("Wallet authorization expired. Please retry.");
  const message = workflowMessage(args.operation, args.context, args.account, args.input, args.deadline);
  if (!await args.verify({ address: args.account, message, signature: args.signature })) throw new WorkflowRefusal("Wallet authorization was refused.");
  return message;
}
