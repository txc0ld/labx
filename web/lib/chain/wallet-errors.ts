export function isWalletRequestRejected(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === 4001 || error.code === 5000);
}

/** The code and message of an error and of the errors it wraps: viem's cause chain and EIP-1193 data. */
function errorDetails(error: unknown) {
  const found: { code: number | undefined; message: string }[] = [], seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    found.push({ code: "code" in value && typeof value.code === "number" ? value.code : undefined, message: "message" in value && typeof value.message === "string" ? value.message : "" });
    for (const key of ["cause", "data", "originalError"]) if (key in value) visit((value as Record<string, unknown>)[key], depth + 1);
  };
  visit(error, 0);
  return found;
}

const PRE_BROADCAST = /insufficient funds|gas required exceeds|intrinsic gas|cannot estimate gas|failed to estimate gas|gas estimation failed|max fee per gas less than block base fee/i;

/**
 * How a wallet failure shows that the wallet's own checks stopped it before it broadcast. "message": its text names one,
 * such as not enough ETH for the fee or a failed gas estimate. "code": only the wallet's internal (-32603) or server
 * (-32000) code says so; some wallets also use these codes after their own RPC already took the send, so this is weaker.
 * null: neither, including a clean rejection, which has its own path. Neither class proves that nothing was sent: the
 * caller still reads the account's pending nonce.
 */
export function preBroadcastEvidence(error: unknown): "message" | "code" | null {
  if (isWalletRequestRejected(error)) return null;
  const details = errorDetails(error);
  if (details.some(({ message }) => PRE_BROADCAST.test(message))) return "message";
  return details.some(({ code }) => code === -32603 || code === -32000) ? "code" : null;
}

/** One plain sentence for a wallet failure that sent nothing. */
export function notSentReason(error: unknown, currency: string): string {
  const text = errorDetails(error).map(item => item.message).join(" ");
  if (/insufficient funds/i.test(text)) return `Your wallet doesn't have enough ${currency} for its network fee. Nothing was sent.`;
  if (/\bgas\b/i.test(text)) return "Your wallet couldn't work out the network fee for this transaction. Nothing was sent.";
  return "Your wallet couldn't send this transaction. Nothing was sent.";
}
