import { BaseError, http, type Transport } from "viem";

/** publicnode's US servers keep only about 25,000 blocks of logs ("pruned history unavailable"); this public gateway keeps all of Sepolia. */
export const SEPOLIA_HISTORY_RPC = "https://sepolia.gateway.tenderly.co";

export function isPrunedHistoryError(error: unknown): boolean {
  return error instanceof BaseError && /pruned history/i.test(`${error.message} ${error.details}`);
}

/**
 * The browser's read transport. Every request goes to the configured RPC. Only an eth_getLogs it answers with "pruned history"
 * is asked once more, of the full-history RPC, with no retry; blocks, calls and every other error stay with the configured RPC.
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
        if (args.method !== "eth_getLogs" || !isPrunedHistoryError(error)) throw error;
        return fallback.request(args);
      }
    }) as typeof primary.request;
    return { ...primary, request };
  };
}
