import type { HistoryItem } from "@/lib/chain/types";
import type { PrivateRecords } from "@/lib/chain/api-types";
import type { ReadPrivateRecords } from "./PrivateRecordsPanel";
export async function loadPrivateRecordBatches(purchases: readonly HistoryItem[], read: ReadPrivateRecords, current: () => boolean = () => true): Promise<PrivateRecords> {
  const agreements = new Map<string, PrivateRecords["agreements"][number]>();
  const receipts = new Map<string, PrivateRecords["receipts"][number]>();
  for (let start = 0; start < purchases.length; start += 30) {
    if (!current()) throw new Error("Wallet or record selection changed.");
    const batch = purchases.slice(start, start + 30);
    const result = await read({ raffleIds: [...new Set(batch.map(item => item.raffleId.toString()))], purchases: batch.map(({ transactionHash, logIndex }) => ({ transactionHash, logIndex })) });
    for (const item of result.agreements) agreements.set(item.raffleId, item);
    for (const item of result.receipts) receipts.set(`${item.transactionHash.toLowerCase()}:${item.logIndex}`, item);
  }
  return { agreements: [...agreements.values()], receipts: [...receipts.values()] };
}
