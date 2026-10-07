export function isWalletRequestRejected(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === 4001 || error.code === 5000);
}
