import { fixtureTrust } from "./fixtures/deployment";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  http,
  keccak256,
  numberToHex,
  parseAbiParameters,
  toBytes,
  toEventSelector,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { raffleAbi } from "../lib/chain/abi";
import { createReader } from "../lib/chain/reader";
import { createSellerReader } from "../lib/chain/seller-reader";
import type { BlockRef, DeploymentManifest, Raffle, RaffleSnapshot } from "../lib/chain/types";

const LABX = "0x1111111111111111111111111111111111111111";
const USDC = "0x2222222222222222222222222222222222222222";
const NFT = "0x3333333333333333333333333333333333333333";
const OWNER = "0x4444444444444444444444444444444444444444";
const SELLER = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
const BUYER = "0x7777777777777777777777777777777777777777";
const CODE = "0x600160005260206000f3";
const BLOCK: BlockRef = { number: 100n, hash: keccak256(toBytes("block-100")), timestamp: 1_800_000_000n };
const manifest: DeploymentManifest = { ...fixtureTrust,
  chainId: 31337,
  address: LABX,
  runtimeCodeHash: keccak256(CODE),
  version: 3,
  deploymentBlock: 1n,
  usdc: USDC
};

function raffle(id: bigint, seller: Address = SELLER): Raffle {
  return {
    seller,
    nft: NFT,
    tokenId: id,
    salesEnd: BLOCK.timestamp + 1000n,
    createdAt: BLOCK.timestamp,
    drawnAt: 0n,
    vrfRequestedAt: 0n,
    phase: 0,
    escrowed: false,
    snapshotted: false,
    revealed: false,
    reserveNonce: zeroHash,
    reserveCommit: zeroHash,
    publicHash: zeroHash,
    lotCursor: 0n,
    snapshotTotal: 0n,
    principalEscrow: 0n,
    feeEscrow: 0n,
    vrfRequestId: 0n,
    randomWord: 0n,
    winner: zeroAddress,
    packCount: 1,
    title: `Raffle ${id}`
  };
}

function readerFixture(options: {
  nextId?: bigint;
  sellerFor?: (id: bigint) => Address;
  onRead?: (functionName: string, id: bigint | undefined) => void;
  onTokenUri?: () => void;
} = {}) {
  let latest = BLOCK;
  const calls: string[] = [];
  const rpc = { blocks: 0, chains: 0, codes: 0 };
  const client = createPublicClient({ transport: http("http://127.0.0.1:1") });
  vi.spyOn(client, "getBlock").mockImplementation(async () => {
    rpc.blocks += 1;
    return { number: latest.number, hash: latest.hash, timestamp: latest.timestamp } as never;
  });
  vi.spyOn(client, "getChainId").mockImplementation(async () => {
    rpc.chains += 1;
    return manifest.chainId;
  });
  vi.spyOn(client, "getCode").mockImplementation(async () => {
    rpc.codes += 1;
    return CODE;
  });
  vi.spyOn(client, "readContract").mockImplementation(async (input) => {
    calls.push(input.functionName);
    const id = input.args?.[0] as bigint | undefined;
    options.onRead?.(input.functionName, id);
    switch (input.functionName) {
      case "contractVersion": return 3n;
      case "usdc": return USDC;
      case "nextId": return options.nextId ?? 4n;
      case "getRaffle": return raffle(id ?? 0n, options.sellerFor?.(id ?? 0n) ?? SELLER);
      case "getRaffleAdmission": return { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: OWNER, approvedAtOpening: true };
      case "draftReviewHash": return zeroHash;
      case "getRafflePolicy": return {
        treasury: OWNER,
        termsHash: zeroHash,
        coordinator: OWNER,
        keyHash: zeroHash,
        subscriptionId: 1n,
        callbackGasLimit: 500_000,
        requestConfirmations: 3,
        nativePayment: true,
        buyerFeeBps: 200,
        sellerFeeBps: 200, minBuyerFeeUsdc: 2_500_000n
      };
      case "lotCount": return 0n;
      case "paused": return false;
      case "owner": return OWNER;
      case "ethPathEnabled": return true;
      case "getRaffleAccounting": return { grossPrincipal: 0n, buyerFees: 0n };
      case "DRAW_START_GRACE":
      case "VRF_ABORT_AFTER":
      case "REVEAL_GRACE": return 604_800n;
      case "getPack": return { name: "Member", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 20, sold: 0, active: true };
      case "tokenURI":
        options.onTokenUri?.();
        return `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Remote title", image: "https://example.com/art.png" }))}`;
      default: throw new Error(`Unexpected read ${input.functionName}`);
    }
  });
  return {
    client,
    calls,
    rpcCount() { return calls.length + rpc.blocks + rpc.chains + rpc.codes; },
    moveBlock(hash: Hex = keccak256(toBytes("replacement"))) { latest = { ...latest, hash }; },
    advanceBlock() { latest = { number: latest.number + 1n, hash: keccak256(toBytes(`block-${latest.number + 1n}`)), timestamp: latest.timestamp + 12n }; }
  };
}

function count(calls: readonly string[], name: string) {
  return calls.filter(call => call === name).length;
}

describe("bounded raffle reads", () => {
  it("cuts a three-raffle page from the observed 53-RPC baseline to 37 with admission records and draft hashes and never shares globals across calls", async () => {
    const fixture = readerFixture();
    const { listRaffles } = createReader(fixture.client, manifest);

    const first = await listRaffles({ limit: 3 });
    expect(first.items.map(item => item.id)).toEqual([1n, 2n, 3n]);
    expect(fixture.rpcCount()).toBe(37);
    expect(fixture.calls).toHaveLength(30);
    for (const name of ["paused", "owner", "ethPathEnabled", "DRAW_START_GRACE", "VRF_ABORT_AFTER", "REVEAL_GRACE"]) {
      expect(count(fixture.calls, name), name).toBe(1);
    }
    expect(count(fixture.calls, "getRaffle")).toBe(3);
    expect(count(fixture.calls, "getRafflePolicy")).toBe(3);
    expect(count(fixture.calls, "getRaffleAccounting")).toBe(3);
    expect(count(fixture.calls, "getPack")).toBe(3);

    await listRaffles({ limit: 3, block: first.block });
    expect(fixture.rpcCount()).toBe(69);
    for (const name of ["paused", "owner", "ethPathEnabled", "DRAW_START_GRACE", "VRF_ABORT_AFTER", "REVEAL_GRACE"]) {
      expect(count(fixture.calls, name), name).toBe(2);
    }

    fixture.advanceBlock();
    await listRaffles({ limit: 3 });
    expect(fixture.rpcCount()).toBe(106);
    for (const name of ["paused", "owner", "ethPathEnabled", "DRAW_START_GRACE", "VRF_ABORT_AFTER", "REVEAL_GRACE"]) {
      expect(count(fixture.calls, name), name).toBe(3);
    }
  });

  it("scans at most 24 tuples and defers every detail and global read until after seller selection", async () => {
    const fixture = readerFixture({ nextId: 30n, sellerFor: id => id === 24n ? SELLER : OTHER });
    const reader = createReader(fixture.client, manifest);
    const sellerReader = createSellerReader(fixture.client, manifest, reader);

    const page = await sellerReader.listSellerRaffles({ seller: SELLER, limit: 24 });
    expect(page.items.map(item => item.id)).toEqual([24n]);
    expect(page.nextCursor).toBe(25n);
    expect(count(fixture.calls, "getRaffle")).toBe(24);
    expect(count(fixture.calls, "getRafflePolicy")).toBe(1);
    expect(count(fixture.calls, "getRaffleAccounting")).toBe(1);
    expect(count(fixture.calls, "getPack")).toBe(1);
    expect(count(fixture.calls, "paused")).toBe(1);
  });

  it("preserves an empty seller page cursor and fetches details only for a later-page match", async () => {
    const fixture = readerFixture({ nextId: 27n, sellerFor: id => id === 25n ? SELLER : OTHER });
    const sellerReader = createSellerReader(fixture.client, manifest, createReader(fixture.client, manifest));

    const first = await sellerReader.listSellerRaffles({ seller: SELLER, limit: 24 });
    expect(first).toMatchObject({ items: [], nextCursor: 25n });
    expect(count(fixture.calls, "getRaffle")).toBe(24);
    expect(count(fixture.calls, "getRafflePolicy")).toBe(0);
    expect(count(fixture.calls, "getRaffleAccounting")).toBe(0);
    expect(count(fixture.calls, "getPack")).toBe(0);
    expect(count(fixture.calls, "paused")).toBe(0);

    const second = await sellerReader.listSellerRaffles({
      seller: SELLER,
      cursor: first.nextCursor ?? undefined,
      limit: 24,
      block: first.block
    });
    expect(second.items.map(item => item.id)).toEqual([25n]);
    expect(second.nextCursor).toBeNull();
    expect(second.block).toEqual(first.block);
    expect(count(fixture.calls, "getRaffle")).toBe(26);
    expect(count(fixture.calls, "getRafflePolicy")).toBe(1);
    expect(count(fixture.calls, "getRaffleAccounting")).toBe(1);
    expect(count(fixture.calls, "getPack")).toBe(1);
    expect(count(fixture.calls, "paused")).toBe(1);
  });

  it("does no detail or global work for a no-match or empty seller page", async () => {
    const noMatch = readerFixture({ nextId: 3n, sellerFor: () => OTHER });
    const noMatchReader = createReader(noMatch.client, manifest);
    const noMatchSeller = createSellerReader(noMatch.client, manifest, noMatchReader);
    const scanned = await noMatchSeller.listSellerRaffles({ seller: SELLER, limit: 2 });
    expect(scanned.items).toEqual([]);
    expect(scanned.nextCursor).toBeNull();
    expect(count(noMatch.calls, "getRaffle")).toBe(2);
    expect(count(noMatch.calls, "getRafflePolicy")).toBe(0);
    expect(count(noMatch.calls, "paused")).toBe(0);

    const empty = readerFixture({ nextId: 1n });
    const emptyReader = createReader(empty.client, manifest);
    const emptySeller = createSellerReader(empty.client, manifest, emptyReader);
    await expect(emptySeller.listSellerRaffles({ seller: SELLER, limit: 24 })).resolves.toMatchObject({ items: [], nextCursor: null });
    expect(count(empty.calls, "getRaffle")).toBe(0);
    expect(count(empty.calls, "paused")).toBe(0);

    const replacedEmpty = readerFixture({ nextId: 1n, onRead(name) { if (name === "nextId") replacedEmpty.moveBlock(); } });
    await expect(createReader(replacedEmpty.client, manifest).listRaffles()).rejects.toThrow(/Chain state changed/);
  });

  it("does not retain rejected globals and fails a page when its final block hash changes", async () => {
    let failPaused = true;
    const rejected = readerFixture({
      onRead(name) {
        if (name === "paused" && failPaused) {
          failPaused = false;
          throw new Error("paused unavailable");
        }
      }
    });
    const { listRaffles } = createReader(rejected.client, manifest);
    await expect(listRaffles({ limit: 1 })).rejects.toThrow(/paused unavailable/);
    await expect(listRaffles({ limit: 1 })).resolves.toMatchObject({ items: [{ id: 1n }] });
    expect(count(rejected.calls, "paused")).toBe(2);

    const replaced = readerFixture({ onRead(name) { if (name === "getPack") replaced.moveBlock(); } });
    await expect(createReader(replaced.client, manifest).listRaffles({ limit: 1 })).rejects.toThrow(/Chain state changed/);
  });

  it("reads artwork from only the raffle tuple and token URI, then revalidates the block", async () => {
    const fixture = readerFixture();
    const artwork = await createReader(fixture.client, manifest).readArtwork({ id: 1n });
    expect(artwork).toMatchObject({ title: "Raffle 1", image: "https://example.com/art.png" });
    expect(count(fixture.calls, "getRaffle")).toBe(1);
    expect(count(fixture.calls, "tokenURI")).toBe(1);
    for (const name of ["getRafflePolicy", "getRaffleAccounting", "getPack", "paused"]) expect(count(fixture.calls, name), name).toBe(0);

    const replaced = readerFixture({ onTokenUri() { replaced.moveBlock(); } });
    await expect(createReader(replaced.client, manifest).readArtwork({ id: 1n })).rejects.toThrow(/Chain state changed/);
  });

  it("returns recorded fallback artwork only after revalidating the pinned block", async () => {
    const fallback = readerFixture({ onTokenUri() { throw new Error("token URI unavailable"); } });
    await expect(createReader(fallback.client, manifest).readArtwork({ id: 1n })).resolves.toEqual({
      title: "Raffle 1",
      description: "",
      image: null
    });

    const replacedFallback = readerFixture({
      onTokenUri() {
        replacedFallback.moveBlock();
        throw new Error("token URI unavailable");
      }
    });
    await expect(createReader(replacedFallback.client, manifest).readArtwork({ id: 1n })).rejects.toThrow(/Chain state changed/);
  });
});

const financialNames = ["PackPurchased", "ProceedsClaimed", "FeeClaimed", "Refunded"] as const;
const financialTopics = financialNames.map(name => toEventSelector(getAbiItem({ abi: raffleAbi, name })));

function rawLog(eventName: typeof financialNames[number], id: bigint, index: number, overrides: Record<string, unknown> = {}) {
  const accountKey = eventName === "FeeClaimed" ? "treasury" : eventName === "ProceedsClaimed" ? "seller" : "buyer";
  const topics = encodeEventTopics({ abi: raffleAbi, eventName, args: { id, [accountKey]: eventName === "FeeClaimed" ? OWNER : eventName === "ProceedsClaimed" ? SELLER : BUYER } });
  const data = eventName === "PackPurchased"
    ? encodeAbiParameters(parseAbiParameters("uint8,uint32,uint32,uint256,uint256,bool"), [0, 1, 1, 25_000_000n, 500_000n, false])
    : encodeAbiParameters(parseAbiParameters("uint256"), [25_000_000n]);
  return {
    address: LABX,
    blockHash: BLOCK.hash,
    blockNumber: numberToHex(BLOCK.number),
    data,
    logIndex: numberToHex(index),
    removed: false,
    topics,
    transactionHash: keccak256(toBytes(`tx-${index}`)),
    transactionIndex: "0x0",
    ...overrides
  };
}

function snapshot(id: bigint): RaffleSnapshot {
  return {
    id,
    block: BLOCK,
    raffle: raffle(id),
    admission: { status: "opened", reviewHash: null, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: OWNER, approvedAtOpening: true } },
    packs: [],
    policy: { treasury: OWNER, termsHash: zeroHash, coordinator: OWNER, keyHash: zeroHash, subscriptionId: 1n, callbackGasLimit: 500_000, requestConfirmations: 3, nativePayment: true, buyerFeeBps: 200, sellerFeeBps: 200, minBuyerFeeUsdc: 2_500_000n },
    lotCount: 0n,
    paused: false,
    owner: OWNER,
    ethEnabled: true,
    accounting: { grossPrincipal: 0n, buyerFees: 0n },
    drawStartGrace: 604_800n,
    randomnessGrace: 604_800n,
    revealGrace: 604_800n
  };
}

describe("transport-filtered seller activity", () => {
  it("sends one bounded raw filter and strictly keeps only the requested raffle's four financial events", async () => {
    const requests: { method: string; params?: readonly unknown[] }[] = [];
    const logs = [
      ...financialNames.map((name, index) => rawLog(name, 7n, index)),
      rawLog("Refunded", 8n, 5),
      {
        ...rawLog("Refunded", 7n, 6),
        topics: encodeEventTopics({ abi: raffleAbi, eventName: "Opened", args: { id: 7n } }),
        data: "0x"
      }
    ];
    const client = createPublicClient({ transport: custom({ async request(request) {
      requests.push(request);
      if (request.method !== "eth_getLogs") throw new Error(`Unexpected RPC ${request.method}`);
      return logs;
    } }) });
    const reader = {
      checkedBlock: vi.fn(async () => BLOCK),
      readRaffle: vi.fn(async ({ id }: { id: bigint }) => snapshot(id)),
      listRaffles: vi.fn()
    };

    const page = await createSellerReader(client, manifest, reader).listRaffleActivity({ id: 7n });
    expect(page.items.map(item => item.eventName)).toEqual(financialNames);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({ method: "eth_getLogs", params: [{
      address: LABX,
      fromBlock: numberToHex(manifest.deploymentBlock),
      toBlock: numberToHex(BLOCK.number),
      topics: [financialTopics, numberToHex(7n, { size: 32 })]
    }] });
    expect(reader.checkedBlock).toHaveBeenCalledTimes(2);
  });

  it("propagates provider, malformed-event, metadata, result-limit and final-hash failures", async () => {
    async function activityWith(result: unknown, finalError?: Error) {
      const client = createPublicClient({ transport: custom({ async request() {
        if (result instanceof Error) throw result;
        return result;
      } }) });
      let checks = 0;
      const reader = {
        checkedBlock: vi.fn(async () => {
          checks += 1;
          if (checks === 2 && finalError) throw finalError;
          return BLOCK;
        }),
        readRaffle: vi.fn(async ({ id }: { id: bigint }) => snapshot(id)),
        listRaffles: vi.fn()
      };
      return createSellerReader(client, manifest, reader).listRaffleActivity({ id: 7n });
    }

    await expect(activityWith(new Error("provider unavailable"))).rejects.toThrow(/provider unavailable/);
    await expect(activityWith([rawLog("Refunded", 7n, 0, { data: "0x12" })])).rejects.toThrow(/could not be decoded/);
    await expect(activityWith([rawLog("Refunded", 7n, 0, { removed: true })])).rejects.toThrow(/metadata is incomplete/);
    await expect(activityWith([rawLog("Refunded", 7n, 0, { transactionHash: null })])).rejects.toThrow(/metadata is incomplete/);
    await expect(activityWith(Array.from({ length: 5_001 }, (_, index) => rawLog("Refunded", 7n, index)))).rejects.toThrow(/Too many events/);
    await expect(activityWith([], new Error("Chain state changed."))).rejects.toThrow(/Chain state changed/);
  });
});
