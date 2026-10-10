const USDC_SCALE = 1_000_000n;

/** USDC for people: grouped whole units and at least two decimals (12.50), keeping any finer precision. */
export function formatUsdcAmount(value: bigint): string {
  const fraction = (value % USDC_SCALE).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${(value / USDC_SCALE).toLocaleString("en-US")}.${fraction}`;
}
