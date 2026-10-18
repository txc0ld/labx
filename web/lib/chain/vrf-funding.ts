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
  /** Least native balance at which Chainlink's nodes answer this raffle's request; null for LINK billing, which this check does not price. */
  required: bigint | null;
  /** Whether the raffle contract may request from the subscription at all. */
  consumer: boolean;
};

/**
 * Chainlink's VRF v2.5 nodes fulfil a request only when the subscription could pay for it at the gas lane's maximum price,
 * using the coordinator's own native fee formula. Sepolia raffle 3 waited at 0.1 ETH and was fulfilled a minute after the
 * subscription passed this amount (0.334 ETH for 500,000 callback gas at 500 gwei).
 */
export function vrfMinimumNativeBalance(input: { callbackGasLimit: bigint; gasAfterPaymentCalculation: bigint; maxGasPrice: bigint; premiumPercentage: bigint; flatFeePpm: bigint }): bigint {
  return (input.callbackGasLimit + input.gasAfterPaymentCalculation) * input.maxGasPrice * (100n + input.premiumPercentage) / 100n + input.flatFeePpm * 10n ** 12n;
}

export async function readDrawFunding(client: Pick<PublicClient, "readContract">, policy: RafflePolicy, raffle: Address, blockNumber: bigint): Promise<DrawFunding> {
  const base = { address: policy.coordinator, abi: coordinatorAbi, blockNumber } as const;
  const [[, nativeBalance, , , consumers], config, [exists, maxGas]] = await Promise.all([
    client.readContract({ ...base, functionName: "getSubscription", args: [policy.subscriptionId] }),
    client.readContract({ ...base, functionName: "s_config" }),
    client.readContract({ ...base, functionName: "s_provingKeys", args: [policy.keyHash] })
  ]);
  if (!exists) throw new Error("The VRF key hash is not registered with its coordinator.");
  const required = policy.nativePayment
    ? vrfMinimumNativeBalance({ callbackGasLimit: BigInt(policy.callbackGasLimit), gasAfterPaymentCalculation: BigInt(config[4]), maxGasPrice: maxGas, premiumPercentage: BigInt(config[7]), flatFeePpm: BigInt(config[5]) })
    : null;
  return { nativeBalance, required, consumer: consumers.some(item => sameAddress(item, raffle)) };
}
