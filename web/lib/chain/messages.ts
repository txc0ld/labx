import type { Address } from "viem";
import type { WorkflowContext } from "./api-types";
export function workflowMessage(operation: "commitment" | "commitment recovery" | "private records", context: WorkflowContext, account: Address, input: unknown, deadline: string): string {
  return `LABx ${operation} v3\n${JSON.stringify({ origin: context.origin, chainId: context.chainId, contract: context.contract.toLowerCase(), address: account.toLowerCase(), termsHash: context.termsHash, termsVersion: context.termsVersion, input, deadline })}`;
}
