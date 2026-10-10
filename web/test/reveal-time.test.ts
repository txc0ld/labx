import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, numberToHex, toBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { raffleAbi } from "../lib/chain/abi";
import { createReader } from "../lib/chain/reader";
import type { BlockRef, DeploymentManifest } from "../lib/chain/types";
import { fixtureTrust } from "./fixtures/deployment";

const LABX = "0x1111111111111111111111111111111111111111";
const USDC = "0x2222222222222222222222222222222222222222";
const CODE = "0x600160005260206000f3";
const GENESIS_TIME = 1_800_000_000n;

const blockHash = (number: bigint) => keccak256(toBytes(`block-${number}`));
const blockTime = (number: bigint) => GENESIS_TIME + number * 12n;
const blockAt = (number: bigint): BlockRef => ({ number, hash: blockHash(number), timestamp: blockTime(number) });

type GetLogsFilter = { address: string; fromBlock: Hex; toBlock: Hex; topics: readonly (Hex | null)[] };

/** A node with one block every 12 seconds, the reviewed contract code and the given Revealed events. */
function fakeNode({ deploymentBlock, head, reveals = [], getLogs, blockByHash }: {
  deploymentBlock: bigint;
  head: bigint;
  reveals?: readonly { id: bigint; block: bigint }[];
  getLogs?: (filter: GetLogsFilter) => unknown;
  blockByHash?: (hash: Hex) => unknown;
}) {
  const filters: GetLogsFilter[] = [];
  const rpcBlock = (number: bigint) => ({ number: numberToHex(number), hash: blockHash(number), timestamp: numberToHex(blockTime(number)) });
  const client = createPublicClient({ transport: custom({ async request({ method, params }: { method: string; params?: unknown }) {
    const args = (params ?? []) as readonly unknown[];
    switch (method) {
      case "eth_chainId": return numberToHex(31337);
      case "eth_getBlockByNumber": return rpcBlock(args[0] === "latest" ? head : BigInt(args[0] as Hex));
      case "eth_getBlockByHash": {
        const hash = args[0] as Hex;
        if (blockByHash) return blockByHash(hash);
        for (let number = deploymentBlock; number <= head; number++) if (blockHash(number) === hash) return rpcBlock(number);
        return null;
      }
      case "eth_getCode": return CODE;
      case "eth_call": {
        const { functionName } = decodeFunctionData({ abi: raffleAbi, data: (args[0] as { data: Hex }).data });
        if (functionName === "contractVersion") return encodeFunctionResult({ abi: raffleAbi, functionName, result: 3n });
        if (functionName === "usdc") return encodeFunctionResult({ abi: raffleAbi, functionName, result: USDC });
        throw new Error(`Unexpected call ${functionName}`);
      }
      case "eth_getLogs": {
        const filter = args[0] as GetLogsFilter;
        filters.push(filter);
        if (getLogs) return getLogs(filter);
        const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
        return reveals.filter(reveal => reveal.block >= from && reveal.block <= to && numberToHex(reveal.id, { size: 32 }) === filter.topics[1]).map(reveal => revealLog(reveal.id, reveal.block));
      }
      default: throw new Error(`Unexpected RPC ${method}`);
    }
  } }) });
  const manifest: DeploymentManifest = { ...fixtureTrust, chainId: 31337, address: LABX, runtimeCodeHash: keccak256(CODE), version: 3, deploymentBlock, usdc: USDC };
  return { reader: createReader(client, manifest), filters };
}

function revealLog(id: bigint, block: bigint, extra: Record<string, unknown> = {}) {
  return {
    address: LABX,
    topics: encodeEventTopics({ abi: raffleAbi, eventName: "Revealed", args: { id } }),
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keccak256(toBytes("public")), keccak256(toBytes("private"))]),
    blockNumber: numberToHex(block),
    blockHash: blockHash(block),
    transactionHash: keccak256(toBytes(`reveal-${id}`)),
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
    ...extra
  };
}

const ranges = (filters: readonly GetLogsFilter[]) => filters.map(filter => [BigInt(filter.fromBlock), BigInt(filter.toBlock)]);

describe("draw confirmation time", () => {
  it("reads the block time of the raffle's Revealed event, filtered by its id and ending at the raffle's block", async () => {
    const { reader, filters } = fakeNode({ deploymentBlock: 1n, head: 5_000n, reveals: [{ id: 7n, block: 4_990n }, { id: 8n, block: 4_995n }] });
    await expect(reader.readRevealTime({ id: 7n, block: blockAt(5_000n) })).resolves.toBe(blockTime(4_990n));
    expect(filters).toEqual([{
      address: LABX,
      fromBlock: numberToHex(3_001n),
      toBlock: numberToHex(5_000n),
      topics: [encodeEventTopics({ abi: raffleAbi, eventName: "Revealed" })[0], numberToHex(7n, { size: 32 })]
    }]);
  });

  it("searches back in 2,000-block windows and never before the deployment block", async () => {
    const { reader, filters } = fakeNode({ deploymentBlock: 1_500n, head: 5_000n, reveals: [{ id: 7n, block: 1_600n }] });
    await expect(reader.readRevealTime({ id: 7n, block: blockAt(5_000n) })).resolves.toBe(blockTime(1_600n));
    expect(ranges(filters)).toEqual([[3_001n, 5_000n], [1_500n, 3_000n]]);

    const missing = fakeNode({ deploymentBlock: 1_500n, head: 5_000n });
    await expect(missing.reader.readRevealTime({ id: 7n, block: blockAt(5_000n) })).rejects.toThrow("The draw confirmation was not found.");
    expect(ranges(missing.filters)).toEqual([[3_001n, 5_000n], [1_500n, 3_000n]]);
  });

  it("stops after 20,000 blocks and answers with the oldest searched block's time, which is never before the reveal", async () => {
    const { reader, filters } = fakeNode({ deploymentBlock: 1n, head: 30_000n, reveals: [{ id: 7n, block: 9_000n }] });
    await expect(reader.readRevealTime({ id: 7n, block: blockAt(30_000n) })).resolves.toBe(blockTime(10_001n));
    expect(filters).toHaveLength(10);
    expect(ranges(filters).at(-1)).toEqual([10_001n, 12_000n]);
    expect(blockTime(10_001n)).toBeGreaterThan(blockTime(9_000n));
  });

  it("rejects a failed log read, a removed event, an event from a replaced block and an event after the raffle's block", async () => {
    const at = blockAt(5_000n);
    await expect(fakeNode({ deploymentBlock: 1n, head: 5_000n, getLogs: () => { throw new Error("query exceeds max block range"); } }).reader.readRevealTime({ id: 7n, block: at })).rejects.toThrow();
    await expect(fakeNode({ deploymentBlock: 1n, head: 5_000n, getLogs: () => [revealLog(7n, 4_990n, { removed: true })] }).reader.readRevealTime({ id: 7n, block: at })).rejects.toThrow("The draw confirmation record is invalid.");
    const replaced = fakeNode({ deploymentBlock: 1n, head: 5_000n, reveals: [{ id: 7n, block: 4_990n }], blockByHash: () => ({ number: numberToHex(4_991n), hash: blockHash(4_990n), timestamp: numberToHex(blockTime(4_991n)) }) });
    await expect(replaced.reader.readRevealTime({ id: 7n, block: at })).rejects.toThrow("The draw confirmation record is invalid.");
    const later = fakeNode({ deploymentBlock: 1n, head: 5_000n, reveals: [{ id: 7n, block: 4_990n }], blockByHash: () => ({ number: numberToHex(4_990n), hash: blockHash(4_990n), timestamp: numberToHex(at.timestamp + 1n) }) });
    await expect(later.reader.readRevealTime({ id: 7n, block: at })).rejects.toThrow("The draw confirmation record is invalid.");
  });

  it("rejects a raffle block the node no longer has", async () => {
    const { reader, filters } = fakeNode({ deploymentBlock: 1n, head: 5_000n, reveals: [{ id: 7n, block: 4_990n }] });
    await expect(reader.readRevealTime({ id: 7n, block: { ...blockAt(5_000n), hash: keccak256(toBytes("replaced")) } })).rejects.toThrow("Chain state changed");
    expect(filters).toEqual([]);
  });
});
