import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, numberToHex, toBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { raffleAbi } from "../lib/chain/abi";
import { createReader } from "../lib/chain/reader";
import { readHistoryPages } from "../components/workflow/history-pages";
import type { DeploymentManifest } from "../lib/chain/types";
import { fixtureTrust } from "./fixtures/deployment";

const LABX = "0x1111111111111111111111111111111111111111";
const USDC = "0x2222222222222222222222222222222222222222";
const BUYER = "0x4444444444444444444444444444444444444444";
const CODE = "0x600160005260206000f3";
/** The v3 deployment block and the Sepolia head on 19 October 2026: 76,627 blocks, or 39 history pages of 2,000 blocks. */
const DEPLOYMENT = 11_865_781n;
const HEAD = 11_942_407n;

const blockHash = (number: bigint) => keccak256(toBytes(`block-${number}`));

type Activity = { event: "PackPurchased" | "Refunded"; id: bigint; block: bigint };

function activityLog({ event, id, block }: Activity) {
  return {
    address: LABX,
    topics: encodeEventTopics({ abi: raffleAbi, eventName: event, args: { id, buyer: BUYER } }),
    data: event === "PackPurchased"
      ? encodeAbiParameters([{ type: "uint8" }, { type: "uint32" }, { type: "uint32" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }], [1, 2, 6, 50_000_000n, 2_500_000n, false])
      : encodeAbiParameters([{ type: "uint256" }], [50_000_000n]),
    blockNumber: numberToHex(block),
    blockHash: blockHash(block),
    transactionHash: keccak256(toBytes(`${event}-${id}-${block}`)),
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false
  };
}

/** A node at HEAD with the reviewed contract code and the buyer's events. Records each eth_getLogs range. */
function fakeNode(activity: readonly Activity[]) {
  const ranges: [bigint, bigint][] = [];
  const client = createPublicClient({ transport: custom({ async request({ method, params }: { method: string; params?: unknown }) {
    const args = (params ?? []) as readonly unknown[];
    switch (method) {
      case "eth_chainId": return numberToHex(31337);
      case "eth_getBlockByNumber": {
        const number = args[0] === "latest" ? HEAD : BigInt(args[0] as Hex);
        return { number: numberToHex(number), hash: blockHash(number), timestamp: numberToHex(1_800_000_000n + number * 12n) };
      }
      case "eth_getCode": return CODE;
      case "eth_call": {
        const { functionName } = decodeFunctionData({ abi: raffleAbi, data: (args[0] as { data: Hex }).data });
        if (functionName === "contractVersion") return encodeFunctionResult({ abi: raffleAbi, functionName, result: 3n });
        if (functionName === "usdc") return encodeFunctionResult({ abi: raffleAbi, functionName, result: USDC });
        throw new Error(`Unexpected call ${functionName}`);
      }
      case "eth_getLogs": {
        const filter = args[0] as { fromBlock: Hex; toBlock: Hex };
        const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
        ranges.push([from, to]);
        return activity.filter(item => item.block >= from && item.block <= to).map(activityLog);
      }
      default: throw new Error(`Unexpected RPC ${method}`);
    }
  } }) });
  const manifest: DeploymentManifest = { ...fixtureTrust, chainId: 31337, address: LABX, runtimeCodeHash: keccak256(CODE), version: 3, deploymentBlock: DEPLOYMENT, usdc: USDC };
  return { reader: createReader(client, manifest), ranges };
}

const ACTIVITY: readonly Activity[] = [
  { event: "PackPurchased", id: 2n, block: DEPLOYMENT + 14_482n },
  { event: "PackPurchased", id: 3n, block: HEAD - 1_500n },
  { event: "Refunded", id: 3n, block: HEAD - 10n }
];

describe("account history", () => {
  it("shows the newest activity on the first page, newest first", async () => {
    const { reader, ranges } = fakeNode(ACTIVITY);
    const page = await reader.history({ account: BUYER });
    expect(page.items.map(item => [item.event, item.blockNumber])).toEqual([["Refunded", HEAD - 10n], ["PackPurchased", HEAD - 1_500n]]);
    expect(ranges).toEqual([[HEAD - 1_999n, HEAD]]);
    expect(page.nextCursor).toBe(HEAD - 2_000n);
  });

  it("pages back to the deployment block and stops there", async () => {
    const { reader, ranges } = fakeNode(ACTIVITY);
    const first = await reader.history({ account: BUYER });
    const items = [...first.items];
    let cursor = first.nextCursor;
    for (let pages = 1; cursor !== null && pages < 50; pages += 1) {
      const page = await reader.history({ account: BUYER, toBlock: cursor, block: first.block });
      items.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(ranges).toHaveLength(39);
    expect(ranges.at(-1)).toEqual([DEPLOYMENT, HEAD - 76_000n]);
    expect(items.map(item => item.blockNumber)).toEqual([HEAD - 10n, HEAD - 1_500n, DEPLOYMENT + 14_482n]);
  });

  it("rejects a page outside the deployment and the pinned block", async () => {
    const { reader } = fakeNode(ACTIVITY);
    const first = await reader.history({ account: BUYER });
    await expect(reader.history({ account: BUYER, toBlock: DEPLOYMENT - 1n, block: first.block })).rejects.toThrow("Invalid history block range.");
    await expect(reader.history({ account: BUYER, toBlock: HEAD + 1n, block: first.block })).rejects.toThrow("Invalid history block range.");
  });
});

describe("profile history loads", () => {
  it("shows a purchase from two days ago on the first load and reaches the deployment block in four loads", async () => {
    const { reader, ranges } = fakeNode([...ACTIVITY, { event: "PackPurchased", id: 4n, block: HEAD - 14_400n }]);
    const first = await readHistoryPages(reader, BUYER, null);
    expect(first.items.map(item => item.blockNumber)).toEqual([HEAD - 10n, HEAD - 1_500n, HEAD - 14_400n]);
    expect(first.continuation).toEqual({ cursor: HEAD - 20_000n, block: first.block });

    const loads = [first];
    for (let load = loads.at(-1)!; load.continuation && loads.length < 10; load = loads.at(-1)!) loads.push(await readHistoryPages(reader, BUYER, load.continuation));
    expect(loads).toHaveLength(4);
    expect(loads.at(-1)!.continuation).toBeNull();
    expect(loads.every(load => load.block.hash === first.block.hash)).toBe(true);
    expect(loads.flatMap(load => load.items).map(item => item.blockNumber)).toEqual([HEAD - 10n, HEAD - 1_500n, HEAD - 14_400n, DEPLOYMENT + 14_482n]);
    expect(ranges).toHaveLength(39);
  });
});
