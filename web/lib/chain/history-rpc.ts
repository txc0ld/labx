import { BaseError, hexToBigInt, http, isAddress, isHex, numberToHex, type Address, type EIP1193RequestFn, type Transport } from "viem";

/** publicnode's US servers keep only about 25,000 blocks of logs ("pruned history unavailable"); this public gateway keeps all of Sepolia. */
export const SEPOLIA_HISTORY_RPC = "https://sepolia.gateway.tenderly.co";

export function isPrunedHistoryError(error: unknown): boolean {
  return error instanceof BaseError && /pruned history/i.test(`${error.message} ${error.details}`);
}

const MISMATCH = "Older activity from the full-history RPC did not match this network.";
/** Block headers read at once while checking full-history logs, so a dense page stays within the configured RPC's limits. */
const HEADER_READS = 4;

/**
 * The browser's read transport. Every request goes to the configured RPC. Only an eth_getLogs for one contract and block range
 * that it answers with "pruned history" is asked once more, of the full-history RPC, with no retry, and those logs are checked
 * against the configured RPC's blocks. Blocks, calls and every other error stay with the configured RPC.
 */
export function browserReadTransport(rpc: string, historyRpc: string | null): Transport {
  const configured = http(rpc, { timeout: 15_000, retryCount: 1 });
  if (historyRpc === null) return configured;
  const history = http(historyRpc, { timeout: 8_000, retryCount: 0 });
  return params => {
    const primary = configured(params), fallback = history(params);
    const request = (async (args, options) => {
      try { return await primary.request(args, options); }
      catch (error) {
        const filter = args.method === "eth_getLogs" ? rangeFilter((args.params as readonly unknown[] | undefined)?.[0]) : null;
        if (!filter || !isPrunedHistoryError(error)) throw error;
        return canonicalLogs(primary.request, filter, await fallback.request(args));
      }
    }) as typeof primary.request;
    return { ...primary, request };
  };
}
type RangeFilter = { address: Address; fromBlock: bigint; toBlock: bigint };
function rangeFilter(value: unknown): RangeFilter | null {
  const { address, fromBlock, toBlock } = (value ?? {}) as Record<string, unknown>;
  return typeof address === "string" && isAddress(address, { strict: false }) && isHex(fromBlock) && isHex(toBlock)
    ? { address, fromBlock: hexToBigInt(fromBlock), toBlock: hexToBigInt(toBlock) } : null;
}
/** The full-history logs, only if each is a live log of the filtered contract and range in a block whose hash the configured RPC has. */
async function canonicalLogs<T>(primary: EIP1193RequestFn, filter: RangeFilter, logs: T): Promise<T> {
  if (!Array.isArray(logs)) throw new Error(MISMATCH);
  const claimed = logs.map((log: unknown) => {
    const { removed, address, blockNumber, blockHash } = (log ?? {}) as Record<string, unknown>;
    if (removed === true || typeof address !== "string" || address.toLowerCase() !== filter.address.toLowerCase() || !isHex(blockNumber) || !isHex(blockHash)) throw new Error(MISMATCH);
    const number = hexToBigInt(blockNumber);
    if (number < filter.fromBlock || number > filter.toBlock) throw new Error(MISMATCH);
    return { number, hash: blockHash.toLowerCase() };
  });
  const unread = [...new Set(claimed.map(log => log.number))], canonical = new Map<bigint, string | null>();
  const readHeaders = async () => {
    try {
      for (let number = unread.pop(); number !== undefined; number = unread.pop()) {
        const block = await primary({ method: "eth_getBlockByNumber", params: [numberToHex(number), false] }) as { hash?: unknown } | null;
        canonical.set(number, typeof block?.hash === "string" ? block.hash.toLowerCase() : null);
      }
    } catch (error) { unread.length = 0; throw error; }
  };
  await Promise.all(Array.from({ length: HEADER_READS }, readHeaders));
  if (claimed.some(log => canonical.get(log.number) !== log.hash)) throw new Error(MISMATCH);
  return logs;
}
