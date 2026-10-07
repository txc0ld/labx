import {
  decodeEventLog,
  getAbiItem,
  toEventSelector,
  type Address,
  type PublicClient
} from "viem";
import { raffleAbi } from "./abi";
import type { SellerRaffleActivity, SellerFinancialEventName } from "./seller-types";
import type { BlockRef, DeploymentManifest, Page, RaffleSnapshot } from "./types";
import { boundedNumber, positiveId, sameAddress } from "./validation";

type SellerReaderDependency = {
  checkedBlock(requested?: BlockRef): Promise<BlockRef>;
  readRaffle(input: { id: bigint; block?: BlockRef }): Promise<RaffleSnapshot>;
  listRaffles(input?: { cursor?: bigint; limit?: number; block?: BlockRef }): Promise<Page<RaffleSnapshot>>;
};

const FINANCIAL_EVENTS = ["PackPurchased", "ProceedsClaimed", "FeeClaimed", "Refunded"] as const satisfies readonly SellerFinancialEventName[];
const FINANCIAL_TOPICS = new Set(FINANCIAL_EVENTS.map((name) => toEventSelector(getAbiItem({ abi: raffleAbi, name }))));

export function createSellerReader(client: PublicClient, manifest: DeploymentManifest, reader: SellerReaderDependency) {
  async function listSellerRaffles({ seller, cursor, limit = 12, block }: {
    seller: Address;
    cursor?: bigint;
    limit?: number;
    block?: BlockRef;
  }): Promise<Page<RaffleSnapshot>> {
    boundedNumber(limit, 1, 24);
    const page = await reader.listRaffles({ cursor, limit, block });
    return {
      ...page,
      items: page.items.filter((snapshot) => sameAddress(snapshot.raffle.seller, seller))
    };
  }

  async function listRaffleActivity({ id, cursor, block }: {
    id: bigint;
    cursor?: bigint;
    block?: BlockRef;
  }): Promise<Page<SellerRaffleActivity>> {
    positiveId(id);
    const at = await reader.checkedBlock(block);
    await reader.readRaffle({ id, block: at });
    const fromBlock = cursor ?? manifest.deploymentBlock;
    if (fromBlock < manifest.deploymentBlock || fromBlock > at.number) throw new Error("Invalid activity block range.");
    const toBlock = fromBlock + 1_999n < at.number ? fromBlock + 1_999n : at.number;
    const logs = await client.getLogs({ address: manifest.address, fromBlock, toBlock });
    if (logs.length > 5_000) throw new Error("Too many events in this block range. Use a smaller range.");

    const items: SellerRaffleActivity[] = [];
    for (const log of logs) {
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

    return { items, nextCursor: toBlock < at.number ? toBlock + 1n : null, block: at };
  }

  return { listSellerRaffles, listRaffleActivity };
}
