import {
  decodeEventLog,
  formatLog,
  getAbiItem,
  numberToHex,
  toEventSelector,
  type Address,
  type PublicClient
} from "viem";
import { raffleAbi } from "./abi";
import type { SellerRaffleActivity, SellerFinancialEventName } from "./seller-types";
import type { BlockRef, DeploymentManifest, Page, RaffleSnapshot } from "./types";
import { boundedNumber, positiveId } from "./validation";

type SellerReaderDependency = {
  checkedBlock(requested?: BlockRef): Promise<BlockRef>;
  readRaffle(input: { id: bigint; block?: BlockRef }): Promise<RaffleSnapshot>;
  listRaffles(input?: { cursor?: bigint; limit?: number; block?: BlockRef; seller?: Address }): Promise<Page<RaffleSnapshot>>;
};

const FINANCIAL_EVENTS = ["PackPurchased", "ProceedsClaimed", "FeeClaimed", "Refunded"] as const satisfies readonly SellerFinancialEventName[];
const FINANCIAL_TOPIC_LIST = FINANCIAL_EVENTS.map((name) => toEventSelector(getAbiItem({ abi: raffleAbi, name })));
const FINANCIAL_TOPICS = new Set(FINANCIAL_TOPIC_LIST);
/** Empty 2,000-block windows read in one activity load before handing back a cursor. */
const ACTIVITY_WINDOWS = 10;

export function createSellerReader(client: PublicClient, manifest: DeploymentManifest, reader: SellerReaderDependency) {
  async function listSellerRaffles({ seller, cursor, limit = 12, block }: {
    seller: Address;
    cursor?: bigint;
    limit?: number;
    block?: BlockRef;
  }): Promise<Page<RaffleSnapshot>> {
    boundedNumber(limit, 1, 24);
    return reader.listRaffles({ cursor, limit, block, seller });
  }

  /**
   * The raffle's financial events, newest first, ending at `cursor` (the checked block by default). Reads 2,000-block windows
   * back until one has activity, up to 10 windows (20,000 blocks), so an old raffle's sales appear without clicking through
   * empty pages. `nextCursor` ends the next older window.
   */
  async function listRaffleActivity({ id, cursor, block }: {
    id: bigint;
    cursor?: bigint;
    block?: BlockRef;
  }): Promise<Page<SellerRaffleActivity>> {
    positiveId(id);
    const at = await reader.checkedBlock(block);
    await reader.readRaffle({ id, block: at });
    let toBlock = cursor ?? at.number;
    if (toBlock < manifest.deploymentBlock || toBlock > at.number) throw new Error("Invalid activity block range.");
    for (let windows = 1; ; windows += 1) {
      const fromBlock = toBlock - 1_999n > manifest.deploymentBlock ? toBlock - 1_999n : manifest.deploymentBlock;
      const items = await readActivityWindow(id, fromBlock, toBlock);
      const nextCursor = fromBlock > manifest.deploymentBlock ? fromBlock - 1n : null;
      if (items.length || nextCursor === null || windows === ACTIVITY_WINDOWS) {
        await reader.checkedBlock(at);
        return { items: items.reverse(), nextCursor, block: at };
      }
      toBlock = nextCursor;
    }
  }

  async function readActivityWindow(id: bigint, fromBlock: bigint, toBlock: bigint): Promise<SellerRaffleActivity[]> {
    const rawLogs = await client.request({
      method: "eth_getLogs",
      params: [{
        address: manifest.address,
        fromBlock: numberToHex(fromBlock),
        toBlock: numberToHex(toBlock),
        topics: [FINANCIAL_TOPIC_LIST, numberToHex(id, { size: 32 })]
      }]
    });
    if (rawLogs.length > 5_000) throw new Error("Too many events in this block range. Use a smaller range.");

    const items: SellerRaffleActivity[] = [];
    for (const rawLog of rawLogs) {
      const log = formatLog(rawLog);
      const topic = log.topics[0];
      const financialTopic = topic !== undefined && FINANCIAL_TOPICS.has(topic);
      let event: ReturnType<typeof decodeEventLog<typeof raffleAbi>>;
      try {
        event = decodeEventLog({ abi: raffleAbi, data: log.data, topics: log.topics, strict: true });
      } catch {
        if (financialTopic) throw new Error("Financial event data could not be decoded.");
        continue;
      }

      if (event.eventName !== "PackPurchased" && event.eventName !== "ProceedsClaimed" && event.eventName !== "FeeClaimed" && event.eventName !== "Refunded") continue;
      if (event.args.id !== id) continue;
      if (log.removed || log.transactionHash === null || log.logIndex === null || log.blockNumber === null) throw new Error("Financial event metadata is incomplete.");

      switch (event.eventName) {
        case "PackPurchased":
          items.push({ eventName: event.eventName, args: event.args, transactionHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber });
          break;
        case "ProceedsClaimed":
          items.push({ eventName: event.eventName, args: event.args, transactionHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber });
          break;
        case "FeeClaimed":
          items.push({ eventName: event.eventName, args: event.args, transactionHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber });
          break;
        case "Refunded":
          items.push({ eventName: event.eventName, args: event.args, transactionHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber });
          break;
        default: {
          const exhaustive: never = event;
          void exhaustive;
        }
      }
    }

    return items;
  }

  return { listSellerRaffles, listRaffleActivity };
}
