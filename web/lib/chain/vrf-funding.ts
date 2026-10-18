import { parseAbi, type Address, type PublicClient } from "viem";
import type { RafflePolicy } from "./types";
import { sameAddress } from "./validation";

const coordinatorAbi = parseAbi([
  "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
  "function s_config() view returns (uint16 minimumRequestConfirmations, uint32 maxGasLimit, bool reentrancyLock, uint32 stalenessSeconds, uint32 gasAfterPaymentCalculation, uint32 fulfillmentFlatFeeNativePPM, uint32 fulfillmentFlatFeeLinkDiscountPPM, uint8 nativePremiumPercentage, uint8 linkPremiumPercentage)",
  "function s_provingKeys(bytes32 keyHash) view returns (bool exists, uint64 maxGas)"
]);

export type DrawFunding = {
  /** Native balance of the subscription, in wei. */
  nativeBalance: bigint;
  /** Chainlink's documented minimum subscription balance for this raffle's request; null for LINK billing, which this check does not price. */
  required: bigint | null;
  /** Whether the raffle contract may request from the subscription at all. */
  consumer: boolean;
};

/** Proof verification gas in Chainlink's documented subscription balance estimate. */
export const VRF_VERIFICATION_GAS = 200_000n;

/**
 * Chainlink's documented minimum subscription balance for a VRF v2.5 request: (callback gas + verification gas) at the gas
 * lane's maximum price, plus the premium and the flat fee (a millionth of a token per ppm). It is an estimate of the reserve
 * nodes expect, not an exact threshold: Sepolia raffle 3 waited at 0.1 ETH and was answered at 0.35 ETH, below this
 * estimate of 0.434 ETH for 500,000 callback gas at 500 gwei.
 */
export function vrfMinimumNativeBalance(input: { callbackGasLimit: bigint; maxGasPrice: bigint; premiumPercentage: bigint; flatFeePpm: bigint }): bigint {
  return (input.callbackGasLimit + VRF_VERIFICATION_GAS) * input.maxGasPrice * (100n + input.premiumPercentage) / 100n + input.flatFeePpm * 10n ** 12n;
}

export async function readDrawFunding(client: Pick<PublicClient, "readContract">, policy: RafflePolicy, raffle: Address, blockNumber: bigint): Promise<DrawFunding> {
  const base = { address: policy.coordinator, abi: coordinatorAbi, blockNumber } as const;
  const [, nativeBalance, , , consumers] = await client.readContract({ ...base, functionName: "getSubscription", args: [policy.subscriptionId] });
  const consumer = consumers.some(item => sameAddress(item, raffle));
  // LINK billing is not priced here, so it needs only the subscription.
  if (!policy.nativePayment) return { nativeBalance, required: null, consumer };
  // s_config and s_provingKeys are public getters of the deployed v2.5 coordinator; recheck them when the coordinator changes.
  const [config, [exists, maxGas]] = await Promise.all([
    client.readContract({ ...base, functionName: "s_config" }),
    client.readContract({ ...base, functionName: "s_provingKeys", args: [policy.keyHash] })
  ]);
  if (!exists) throw new Error("The VRF key hash is not registered with its coordinator.");
  const required = vrfMinimumNativeBalance({ callbackGasLimit: BigInt(policy.callbackGasLimit), maxGasPrice: maxGas, premiumPercentage: BigInt(config[7]), flatFeePpm: BigInt(config[5]) });
  return { nativeBalance, required, consumer };
}
