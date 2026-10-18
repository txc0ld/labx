import type { Address } from "viem";
import type { RaffleService } from "@/lib/chain/ports";
import type { BlockRef, HistoryItem } from "@/lib/chain/types";

export type HistoryContinuation = { cursor: bigint; block: BlockRef };

/** History pages per load: 20,000 blocks, about 2.8 days on Sepolia. */
const PAGES_PER_LOAD = 10;

/** One load of the account's history, newest first, from `from` or the latest block. Every page reads the same pinned block. */
export async function readHistoryPages(service: Pick<RaffleService, "history">, account: Address, from: HistoryContinuation | null) {
  let page = await service.history({ account, toBlock: from?.cursor, block: from?.block });
  const items: HistoryItem[] = [...page.items];
  for (let count = 1; count < PAGES_PER_LOAD && page.nextCursor !== null; count += 1) {
    page = await service.history({ account, toBlock: page.nextCursor, block: page.block });
    items.push(...page.items);
  }
  const continuation: HistoryContinuation | null = page.nextCursor === null ? null : { cursor: page.nextCursor, block: page.block };
  return { items, continuation, block: page.block };
}
