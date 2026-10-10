import {
  BaseError, ContractFunctionRevertedError, EstimateGasExecutionError, ExecutionRevertedError, HttpRequestError, InsufficientFundsError,
  NonceTooLowError, RpcRequestError, TimeoutError, UnknownNodeError, WaitForTransactionReceiptTimeoutError
} from "viem";
import { getNodeError } from "viem/utils";

/** The fixed error label a run report may carry. Never a message or a request body. */
export type ErrorCategory = "InsufficientFunds" | "NonceTooLow" | "EstimateGasRevert" | "Timeout" | "Rpc" | "Other";

export class RunnerTimeoutError extends Error {
  constructor() { super("The draw runner stopped waiting."); this.name = "RunnerTimeoutError"; }
}

/** Settles with `work`, or rejects with RunnerTimeoutError after `ms`. It stops waiting; it cannot cancel the work. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) { work.catch(() => {}); throw new RunnerTimeoutError(); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RunnerTimeoutError()), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

type ErrorClass = abstract new (...args: never[]) => unknown;

/** Labels an error by the viem error classes in its cause chain. Node messages are mapped to classes with viem's own table. */
export function errorCategory(error: unknown): ErrorCategory {
  if (error instanceof RunnerTimeoutError) return "Timeout";
  if (!(error instanceof BaseError)) return "Other";
  const node = nodeAnswered(error) ? getNodeError(error, {}) : null;
  const has = (type: ErrorClass) => node instanceof type || error.walk(cause => cause instanceof type) !== null;
  if (has(TimeoutError) || has(WaitForTransactionReceiptTimeoutError)) return "Timeout";
  if (has(InsufficientFundsError)) return "InsufficientFunds";
  if (has(NonceTooLowError)) return "NonceTooLow";
  if (has(ExecutionRevertedError) || has(ContractFunctionRevertedError)) return has(EstimateGasExecutionError) ? "EstimateGasRevert" : "Other";
  if (has(RpcRequestError) || has(HttpRequestError)) return "Rpc";
  return "Other";
}

/**
 * True when the node answered a broadcast with a rejection viem recognizes, such as insufficient funds or a fee below
 * the base fee, so the transaction entered no pool. "Nonce too low", "already known", an unrecognized node error and
 * a failure in transit leave the outcome unknown.
 */
export function broadcastRefused(error: unknown): boolean {
  if (!nodeAnswered(error)) return false;
  const node = getNodeError(error as BaseError, {});
  return !(node instanceof UnknownNodeError) && !(node instanceof NonceTooLowError);
}

/** True when the node answered with a JSON-RPC error, rather than the request failing in transit. */
function nodeAnswered(error: unknown): boolean {
  return error instanceof BaseError && error.walk(cause => cause instanceof RpcRequestError) !== null;
}
