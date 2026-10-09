import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { raffleAbi } from "@/lib/chain/abi";
import { APPROVED_DEPLOYMENTS } from "@/lib/chain/deployment";
import { NotificationReadBudgetError, NotificationRpcTimeoutError, readFinalizedEvents, type NotificationChainReader, type NotificationWorkflow } from "@/lib/notifications/events";

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
        return { number: finalizedBlock, hash: changedHead && finalizedReads > 1 ? hashes.latest : hashes.finalized, timestamp: 1_760_000_100n, gasLimit: 30_000_000n };
      }
      if (args.blockNumber === eventBlock) return { number: eventBlock, hash: hashes.event, timestamp: 1_760_000_000n, gasLimit: 30_000_000n };
      if (args.blockNumber === finalizedBlock) return { number: finalizedBlock, hash: hashes.finalized, timestamp: 1_760_000_100n, gasLimit: 30_000_000n };
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

  it("accepts a gas-bounded dense single block and allows finalized height advancement", async () => {
    const logs = Array.from({ length: 101 }, (_, index) => rawOpened({
      blockNumber: eventBlock,
      blockHash: hashes.event,
      transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      transactionIndex: index,
      logIndex: index
    }));
    let finalizedReads = 0;
    const reader: NotificationChainReader = {
      async getChainId() { return manifest.chainId; },
      async getLogs() { return logs; },
      async getBlock(args) {
        if ("blockTag" in args) {
          finalizedReads += 1;
          return finalizedReads === 1
            ? { number: eventBlock, hash: hashes.event, timestamp: 1_760_000_000n, gasLimit: 100_000n }
            : { number: eventBlock + 1n, hash: hashes.finalized, timestamp: 1_760_000_100n, gasLimit: 100_000n };
        }
        return { number: args.blockNumber, hash: args.blockNumber === eventBlock ? hashes.event : hashes.finalized, timestamp: 1_760_000_000n, gasLimit: 100_000n };
      }
    };
    const workflow = async (): Promise<NotificationWorkflow> => ({
      context: { chainId: manifest.chainId, contract: manifest.address, origin: "https://labx.example" },
      manifest,
      client: reader,
      block: { number: eventBlock + 1n, hash: hashes.finalized, timestamp: 1_760_000_100n }
    });
    const page = await readFinalizedEvents({ fromBlock: eventBlock, toBlock: eventBlock, workflow });
    expect(page.events).toHaveLength(101);
    expect(page.singleBlock).toEqual({ number: eventBlock, hash: hashes.event, gasLimit: 100_000n });
  });

  it("rejects a single-block count above the refund-aware gas bound", async () => {
    const logs = Array.from({ length: 5 }, (_, index) => rawOpened({
      blockNumber: eventBlock,
      blockHash: hashes.event,
      transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      transactionIndex: index,
      logIndex: index
    }));
    const reader: NotificationChainReader = {
      async getChainId() { return manifest.chainId; },
      async getLogs() { return logs; },
      async getBlock(args) {
        return { number: "blockTag" in args ? eventBlock : args.blockNumber, hash: hashes.event, timestamp: 1_760_000_000n, gasLimit: 3_600n };
      }
    };
    const workflow = async (): Promise<NotificationWorkflow> => ({
      context: { chainId: manifest.chainId, contract: manifest.address, origin: "https://labx.example" },
      manifest,
      client: reader,
      block: { number: eventBlock, hash: hashes.event, timestamp: 1_760_000_000n }
    });
    await expect(readFinalizedEvents({ fromBlock: eventBlock, toBlock: eventBlock, workflow })).rejects.toThrow(/gas bound/);
  });

  it("does not recursively split a transient timeout", async () => {
    let calls = 0;
    const reader: NotificationChainReader = {
      async getChainId() { return manifest.chainId; },
      async getLogs() { calls += 1; throw new NotificationRpcTimeoutError(); },
      async getBlock(args) {
        return { number: "blockTag" in args ? finalizedBlock : args.blockNumber, hash: hashes.finalized, timestamp: 1_760_000_100n, gasLimit: 30_000_000n };
      }
    };
    const workflow = async (): Promise<NotificationWorkflow> => ({
      context: { chainId: manifest.chainId, contract: manifest.address, origin: "https://labx.example" },
      manifest,
      client: reader,
      block: { number: finalizedBlock, hash: hashes.finalized, timestamp: 1_760_000_100n }
    });
    await expect(readFinalizedEvents({ fromBlock: eventBlock, toBlock: finalizedBlock, workflow }))
      .rejects.toBeInstanceOf(NotificationRpcTimeoutError);
    expect(calls).toBe(1);
  });

  it("fails with a typed error before starting an RPC beyond the request budget", async () => {
    const getChainId = vi.fn(async () => manifest.chainId);
    const reader: NotificationChainReader = {
      getChainId,
      async getLogs() { return []; },
      async getBlock(args) { return { number: "blockTag" in args ? finalizedBlock : args.blockNumber, hash: hashes.finalized, timestamp: 1_760_000_100n, gasLimit: 30_000_000n }; }
    };
    const workflow = async (): Promise<NotificationWorkflow> => ({
      context: { chainId: manifest.chainId, contract: manifest.address, origin: "https://labx.example" },
      manifest,
      client: reader,
      block: { number: finalizedBlock, hash: hashes.finalized, timestamp: 1_760_000_100n }
    });
    await expect(readFinalizedEvents({
      fromBlock: eventBlock,
      toBlock: finalizedBlock,
      workflow,
      budget: { remaining: 1, deadline: Date.now() + 1_000 }
    })).rejects.toBeInstanceOf(NotificationReadBudgetError);
    expect(getChainId).not.toHaveBeenCalled();
  });
});
