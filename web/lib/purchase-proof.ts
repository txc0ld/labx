import { createPublicClient, decodeEventLog, formatUnits, http, parseAbiItem, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import type { Receipt } from "./email";
import type { RequestContext } from "./request-auth";

export const purchaseEvent = parseAbiItem("event PackPurchased(uint256 indexed id, address indexed buyer, uint8 packId, uint32 qty, uint32 bonusEntries, uint256 principal, uint256 fee, bool paidWithEth)");
export type PurchaseIdentity = { transactionHash: Hex; logIndex: number; address: Address };
export type PurchaseProof = Omit<Receipt, "to"> & { buyer: Address; transactionHash: Hex; logIndex: number };
export type PurchaseReader = {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: string; transactionHash: Hex; blockHash: Hex; blockNumber: bigint; logs: readonly { address: Address; logIndex: number | null; data: Hex; topics: readonly Hex[] }[] }>;
  getBlock(args: { blockTag: "finalized" } | { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null }>;
};

export async function verifiedPurchase(identity: PurchaseIdentity, context: RequestContext, reader: PurchaseReader): Promise<PurchaseProof> {
  try {
    if (await reader.getChainId() !== context.chainId) throw new Error();
    const receipt = await reader.getTransactionReceipt({ hash: identity.transactionHash });
    if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== identity.transactionHash.toLowerCase()) throw new Error();
    const finalized = await reader.getBlock({ blockTag: "finalized" });
    if (finalized.number === null || receipt.blockNumber > finalized.number) throw new Error();
    const canonical = await reader.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error();
    const log = receipt.logs.find(item => item.logIndex === identity.logIndex);
    if (!log || log.address.toLowerCase() !== context.contract.toLowerCase()) throw new Error();
    const decoded = decodeEventLog({ abi: [purchaseEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    const event = decoded.args;
    if (event.buyer.toLowerCase() !== identity.address.toLowerCase() || event.qty < 1 || event.id < 1n) throw new Error();
    return {
      buyer: event.buyer, transactionHash: receipt.transactionHash, logIndex: identity.logIndex,
      piece: `Raffle #${event.id}`, pack: `Pack #${event.packId} x ${event.qty}`,
      entries: event.bonusEntries, priceUsdc: formatUnits(event.principal, 6), feeUsdc: formatUnits(event.fee, 6)
    };
  } catch { throw new Error("A finalized LABx purchase could not be verified."); }
}

export function receiptChainReader(): PurchaseReader {
  // Only configured RPC, chain and contract are used; request bodies cannot choose a provider.
  return createPublicClient({ chain: sepolia, transport: http(process.env.NEXT_PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", { timeout: 10_000, retryCount: 1 }) });
}
