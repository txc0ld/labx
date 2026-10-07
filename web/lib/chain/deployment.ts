import { keccak256, type PublicClient } from "viem";
import { raffleAbi } from "./abi";
import type { BlockRef, DeploymentManifest, DeploymentStatus } from "./types";
import { address, hash, sameAddress } from "./validation";

// Add a release manifest only after bytecode, configuration and operational approval are recorded.
export const APPROVED_DEPLOYMENTS: readonly DeploymentManifest[] = [{
  chainId: 11155111,
  address: "0x8b0332D0ca48908e174F42eA1b3123e63f3F4327",
  runtimeCodeHash: "0x566af43a3c4310211e5214168fab8c72c2996e01ebd4351f154bf88f1453eb31",
  version: 3,
  deploymentBlock: 11865781n,
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  expectedOwner: "0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1",
  expectedPolicy: {
    coordinator: "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B",
    treasury: "0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1",
    termsHash: "0x653a59619128ccbd7b75b40db072ff9aab5c5a547caf1ccaf9de67079c463f25",
    keyHash: "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae",
    subscriptionId: 87872268328198099397228888276383491550742527734296569403303774370612241641662n,
    callbackGasLimit: 500000,
    requestConfirmations: 3,
    nativePayment: true,
    buyerFeeBps: 200,
    sellerFeeBps: 200,
    minBuyerFeeUsdc: 2500000n,
  }
}];
export const LEGACY_RAFFLE = "0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C";
export const LEGACY_RUNTIME_HASH = "0x1779eba7b981194cf65c900bb8a527672d40f1c7088d1e291bedd1bce22a379d";
export async function blockRef(client: PublicClient, requested?: BlockRef): Promise<BlockRef> {
  const block = await client.getBlock(requested ? { blockNumber: requested.number } : { blockTag: "latest" });
  if (block.number === null || block.hash === null || requested && block.hash !== requested.hash) throw new Error("Chain state changed. Refresh before continuing.");
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}
export async function attestDeployment(client: PublicClient, manifest: DeploymentManifest, at?: BlockRef): Promise<DeploymentStatus> {
  address(manifest.address); address(manifest.usdc); hash(manifest.runtimeCodeHash);
  if (![11155111, 31337].includes(manifest.chainId) || manifest.version !== 3 || manifest.deploymentBlock < 0n) return { kind: "mismatch", reason: "Deployment manifest is invalid." };
  if (sameAddress(manifest.address, LEGACY_RAFFLE)) return { kind: "legacy", reason: "This historical contract does not implement the current buyer protections. Transactions are unavailable." };
  const block = await blockRef(client, at);
  if (await client.getChainId() !== manifest.chainId || block.number < manifest.deploymentBlock) return { kind: "mismatch", reason: "The RPC network does not match this deployment." };
  const code = await client.getCode({ address: manifest.address, blockNumber: block.number });
  if (!code || keccak256(code) !== manifest.runtimeCodeHash) return { kind: "mismatch", reason: "Contract bytecode does not match the reviewed deployment." };
  const [version, usdc] = await Promise.all([
    client.readContract({ address: manifest.address, abi: raffleAbi, functionName: "contractVersion", blockNumber: block.number }),
    client.readContract({ address: manifest.address, abi: raffleAbi, functionName: "usdc", blockNumber: block.number })
  ]);
  if (version !== 3n || !sameAddress(usdc, manifest.usdc)) return { kind: "mismatch", reason: "Contract version or payment token does not match the reviewed deployment." };
  return { kind: "verified", manifest, block };
}
