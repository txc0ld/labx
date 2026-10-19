import { formatEther, type Address, type Hex, type PublicClient } from "viem";
import { feeCurrency } from "./networks";
import { NotSentError } from "./submission-errors";

/** The smallest tip LABx suggests, 0.001 gwei, so an RPC that answers 0 or a few wei still yields a tip validators take. */
export const PRIORITY_FEE_FLOOR = 1_000_000n;

export type FeeSuggestion = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
type FeeClient = Pick<PublicClient, "getBlock" | "estimateMaxPriorityFeePerGas" | "estimateGas" | "getBalance">;

/**
 * The network's EIP-1559 fee suggestion from the configured RPC: its tip, at least PRIORITY_FEE_FLOOR, on top of twice the
 * latest base fee, which keeps the fee valid while the base fee rises for several full blocks.
 */
export async function suggestFees(client: Pick<FeeClient, "getBlock" | "estimateMaxPriorityFeePerGas">): Promise<FeeSuggestion> {
  const [block, tip] = await Promise.all([client.getBlock({ blockTag: "latest" }), client.estimateMaxPriorityFeePerGas()]);
  if (block.baseFeePerGas === null) throw new Error("This network does not report EIP-1559 fees.");
  const maxPriorityFeePerGas = tip > PRIORITY_FEE_FLOOR ? tip : PRIORITY_FEE_FLOOR;
  return { maxFeePerGas: block.baseFeePerGas * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas };
}

/** An ETH amount rounded up to two significant digits, as in "0.00097". */
export function aboutEth(wei: bigint): string {
  const scale = 10n ** BigInt(Math.max(0, wei.toString().length - 2));
  return formatEther((wei + scale - 1n) / scale * scale);
}

/**
 * Estimates the transaction's gas at `blockNumber`, the block its fresh simulation used, and refuses it before any wallet
 * request or pending record when gas × 1.5 × maxFeePerGas + value is more than the account's ETH there. Wallets set their
 * own gas limit about 1.5 times their estimate and need the balance to cover that limit. Returns the fees to suggest.
 */
export async function checkNetworkFee(client: FeeClient, chainId: number, transaction: { account: Address; to: Address; data: Hex; value: bigint; blockNumber: bigint }): Promise<FeeSuggestion> {
  const { account, to, data, value, blockNumber } = transaction;
  const [fees, balance] = await Promise.all([suggestFees(client), client.getBalance({ address: account, blockNumber })]);
  const currency = feeCurrency(chainId);
  const gas = await client.estimateGas({ account, to, data, value, blockNumber }).catch((error: unknown) => {
    if (balance < value || /insufficient funds/i.test(error instanceof Error ? error.message : "")) throw new NotSentError(`Your wallet doesn't have enough ${currency} for this payment and the network fee.`);
    throw new NotSentError("This transaction would fail on the network right now, so your wallet wasn't opened. Refresh and try again.");
  });
  const needed = gas * 3n / 2n * fees.maxFeePerGas + value;
  if (balance < needed) throw new NotSentError(`Your wallet needs about ${aboutEth(needed)} ${currency} for ${value > 0n ? "this payment and " : ""}the network fee.`);
  return fees;
}
