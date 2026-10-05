export type Holder = { address: string; weight: number };

export type Lot = { address: string; weight: number; expiresAt: number };

/** Freeze unexpired lots into cumulative weights. Mirrors LabxRaffle.snapshot. */
export function snapshotLots(lots: Lot[], now: number): { total: number; holders: Holder[]; cumulative: number[] } {
  const holders: Holder[] = [];
  const cumulative: number[] = [];
  let total = 0;
  for (const lot of lots) {
    if (lot.weight <= 0 || lot.expiresAt <= now) continue;
    total += lot.weight;
    cumulative.push(total);
    holders.push({ address: lot.address, weight: lot.weight });
  }
  return { total, holders, cumulative };
}

/** Binary search on cumulative weights. `word % total` matches the contract. */
export function pickWinner(cumulative: number[], holders: Holder[], word: bigint): string {
  if (cumulative.length === 0 || holders.length !== cumulative.length) {
    throw new Error("Empty snapshot");
  }
  const total = BigInt(cumulative[cumulative.length - 1]);
  const target = word % total;
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BigInt(cumulative[mid]) > target) hi = mid;
    else lo = mid + 1;
  }
  return holders[lo].address;
}
