import { keccak256, type PublicClient } from "viem";
import { raffleAbi } from "./abi";
import type { BlockRef, DeploymentManifest, DeploymentStatus } from "./types";
import { address, hash, sameAddress } from "./validation";

// Add a release manifest only after bytecode, configuration and operational approval are recorded.
export const APPROVED_DEPLOYMENTS: readonly DeploymentManifest[] = [];
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
