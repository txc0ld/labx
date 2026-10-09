import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { raffleAbi } from "@/lib/chain/abi";
import { APPROVED_DEPLOYMENTS } from "@/lib/chain/deployment";
import { readFinalizedEvents, type NotificationChainReader, type NotificationWorkflow } from "@/lib/notifications/events";

const manifest = APPROVED_DEPLOYMENTS[0]!;
const eventBlock = manifest.deploymentBlock + 1n;
const finalizedBlock = eventBlock + 1n;
const hashes = {
  latest: `0x${"aa".repeat(32)}` as Hex,
  finalized: `0x${"bb".repeat(32)}` as Hex,
  event: `0x${"cc".repeat(32)}` as Hex,
  tx1: `0x${"dd".repeat(32)}` as Hex,
  tx2: `0x${"ee".repeat(32)}` as Hex
};

function rawCreated(overrides: Record<string, unknown> = {}) {
  return {
    address: manifest.address,
    blockNumber: eventBlock,
    blockHash: hashes.event,
    transactionHash: hashes.tx1,
    transactionIndex: 0,
    logIndex: 2,
    removed: false,
    topics: encodeEventTopics({ abi: raffleAbi, eventName: "RaffleCreated", args: { id: 7n, seller: "0x1111111111111111111111111111111111111111", nft: "0x2222222222222222222222222222222222222222" } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [99n, `0x${"33".repeat(32)}`]),
    ...overrides
  };
}

function rawOpened(overrides: Record<string, unknown> = {}) {
  return {
    address: manifest.address,
    blockNumber: finalizedBlock,
    blockHash: hashes.finalized,
    transactionHash: hashes.tx2,
    transactionIndex: 0,
    logIndex: 1,
    removed: false,
    topics: encodeEventTopics({ abi: raffleAbi, eventName: "Opened", args: { id: 7n } }),
    data: "0x" as Hex,
    ...overrides
  };
}

function source(logs: readonly unknown[], changedHead = false): () => Promise<NotificationWorkflow> {
  let finalizedReads = 0;
  const reader: NotificationChainReader = {
    async getChainId() { return manifest.chainId; },
    async getLogs() { return logs; },
    async getBlock(args) {
      if ("blockTag" in args) {
        finalizedReads += 1;
        return { number: finalizedBlock, hash: changedHead && finalizedReads > 1 ? hashes.latest : hashes.finalized, timestamp: 1_760_000_100n };
      }
      if (args.blockNumber === eventBlock) return { number: eventBlock, hash: hashes.event, timestamp: 1_760_000_000n };
      if (args.blockNumber === finalizedBlock) return { number: finalizedBlock, hash: hashes.finalized, timestamp: 1_760_000_100n };
      throw new Error("unexpected block");
    }
  };
  return async () => ({
    context: { chainId: manifest.chainId, contract: manifest.address, origin: "https://labx.example" },
    manifest,
    client: reader,
    block: { number: finalizedBlock + 1n, hash: hashes.latest, timestamp: 1_760_000_200n }
  });
}

describe("finalized notification event reader", () => {
  it("returns strict, canonical events in chain order with historical labels", async () => {
    const page = await readFinalizedEvents({ fromBlock: eventBlock, toBlock: finalizedBlock, workflow: source([rawOpened(), rawCreated()]) });
    expect(page.events.map(item => [item.eventName, item.label, item.raffleId, item.href])).toEqual([
      ["RaffleCreated", "Draft awaiting review", "7", "/review/7"],
      ["Opened", "Raffle live", "7", "/piece/7"]
    ]);
    expect(page.events[0]?.occurredAt).toBe("2025-10-09T08:53:20.000Z");
    expect(page.finalized.number).toBe(finalizedBlock);
  });

  it.each([
    ["removed log", rawCreated({ removed: true })],
    ["missing transaction hash", rawCreated({ transactionHash: null })],
    ["nonpositive raffle id", rawCreated({ topics: encodeEventTopics({ abi: raffleAbi, eventName: "RaffleCreated", args: { id: 0n, seller: "0x1111111111111111111111111111111111111111" as Address, nft: "0x2222222222222222222222222222222222222222" as Address } }) })],
    ["wrong contract", rawCreated({ address: "0x3333333333333333333333333333333333333333" })]
  ])("fails the whole page for a %s", async (_name, log) => {
    await expect(readFinalizedEvents({ fromBlock: eventBlock, toBlock: finalizedBlock, workflow: source([log]) })).rejects.toThrow();
  });

  it("fails when the pinned finalized head changes during the read", async () => {
    await expect(readFinalizedEvents({ fromBlock: eventBlock, toBlock: finalizedBlock, workflow: source([rawCreated()], true) })).rejects.toThrow(/finalized head changed/);
  });

  it("rejects a provider log outside the requested range before accepting it", async () => {
    await expect(readFinalizedEvents({
      fromBlock: eventBlock,
      toBlock: finalizedBlock,
      workflow: source([rawCreated({ blockNumber: finalizedBlock + 1n })])
    })).rejects.toThrow(/outside the requested range/);
  });
});
