import type { DeploymentManifest, RafflePolicy } from "./types";
import { address, boundedNumber, hash } from "./validation";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local fixture manifest.");
  return Object.fromEntries(Object.entries(value));
}
function uint(value: unknown, bits: number): number {
  if (typeof value !== "number") throw new Error("Invalid policy integer.");
  boundedNumber(value, 0, 2 ** bits - 1);
  return value;
}
function uint256(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || value.length > 78) throw new Error("Invalid manifest integer.");
  const result = BigInt(value);
  if (result >= 2n ** 256n) throw new Error("Invalid manifest integer.");
  return result;
}
export function parseExpectedPolicy(value: unknown): RafflePolicy {
  const policy = object(value);
  if (typeof policy.nativePayment !== "boolean") throw new Error("Invalid policy billing mode.");
  return {
    coordinator: address(policy.coordinator), treasury: address(policy.treasury),
    termsHash: hash(policy.termsHash), keyHash: hash(policy.keyHash),
    subscriptionId: uint256(policy.subscriptionId), callbackGasLimit: uint(policy.callbackGasLimit, 32),
    requestConfirmations: uint(policy.requestConfirmations, 16), nativePayment: policy.nativePayment,
    buyerFeeBps: uint(policy.buyerFeeBps, 16), sellerFeeBps: uint(policy.sellerFeeBps, 16),
    minBuyerFeeUsdc: uint256(policy.minBuyerFeeUsdc)
  };
}
export function parseLocalManifest(value: unknown): DeploymentManifest {
  const data = object(value);
  if (data.chainId !== 31337 || data.version !== 3) throw new Error("Invalid local fixture manifest.");
  return {
    chainId: 31337, version: 3, address: address(data.address), usdc: address(data.usdc),
    runtimeCodeHash: hash(data.runtimeCodeHash), deploymentBlock: uint256(data.deploymentBlock),
    expectedOwner: address(data.expectedOwner), expectedPolicy: parseExpectedPolicy(data.expectedPolicy)
  };
}
