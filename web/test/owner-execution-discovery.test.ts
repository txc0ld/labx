import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, numberToHex, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { ownerExecutionDiscoverer } from "../lib/chain/owner-execution-discovery";
import type { BlockRef, DeploymentManifest, OwnerExecutionIntent } from "../lib/chain/types";

const RAFFLE: Address = "0x1111111111111111111111111111111111111111";
const SAFE: Address = "0x2222222222222222222222222222222222222222";
const OTHER: Address = "0x3333333333333333333333333333333333333333";
const REVIEW: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_A: Hex = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_B: Hex = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const BLOCK_HASH: Hex = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const NEXT_BLOCK_HASH: Hex = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const reviewBlock: BlockRef = { number: 100n, hash: zeroHash, timestamp: 1_800_000_000n };
const head: BlockRef = { number: 2_150n, hash: BLOCK_HASH, timestamp: 1_800_010_000n };

const manifest = {
  chainId: 11155111,
  address: RAFFLE,
  runtimeCodeHash: zeroHash,
  deploymentBlock: 1n
} as unknown as DeploymentManifest;

function intent(kind: "approveRaffle" | "revokeRaffleApproval" = "approveRaffle"): OwnerExecutionIntent {
  const action = kind === "approveRaffle"
    ? { kind, id: 7n, expectedReviewHash: REVIEW, attestations: { canonicalProvenance: true, transferRestrictions: true, drawFunding: true } as const }
    : { kind, id: 7n, expectedReviewHash: REVIEW };
  return {
    action,
    runtimeCodeHash: zeroHash,
    chainId: 11155111,
    from: SAFE,
    to: RAFFLE,
    value: 0n,
    data: "0x1234",
    reviewBlock,
    ownerGeneration: 1n,
    openingPolicyGeneration: 1n,
    reviewRevision: 4n
  };
}

function rpcLog(input: { hash: Hex; blockNumber: bigint; logIndex: number; approver?: Address; id?: bigint; reviewHash?: Hex; kind?: "approveRaffle" | "revokeRaffleApproval"; nextRevision?: bigint }) {
  const kind = input.kind ?? "approveRaffle";
  const eventName = kind === "approveRaffle" ? "RaffleApproved" : "RaffleApprovalRevoked";
  return {
    address: RAFFLE,
    blockHash: input.blockNumber === head.number ? BLOCK_HASH : NEXT_BLOCK_HASH,
    blockNumber: numberToHex(input.blockNumber),
    data: kind === "revokeRaffleApproval" ? encodeAbiParameters([{ type: "uint256" }], [input.nextRevision ?? 5n]) : "0x",
    logIndex: numberToHex(input.logIndex),
    removed: false,
    topics: encodeEventTopics({
      abi: raffleAbi,
      eventName,
      args: { id: input.id ?? 7n, approver: input.approver ?? SAFE, reviewHash: input.reviewHash ?? REVIEW }
    }),
    transactionHash: input.hash,
    transactionIndex: "0x0"
  };
}

function fixture(logs: readonly unknown[]) {
  let checkpointOverride: Hex | null = null;
  const request = vi.fn(async () => logs);
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
    number: blockNumber,
    hash: blockNumber === reviewBlock.number ? reviewBlock.hash : checkpointOverride ?? (blockNumber === head.number ? BLOCK_HASH : NEXT_BLOCK_HASH),
    timestamp: head.timestamp
  }));
  const client = { request, getBlock } as unknown as PublicClient;
  const reader = { checkedBlock: vi.fn(async (requested?: BlockRef) => requested ?? head) };
  return {
    discover: ownerExecutionDiscoverer(client, manifest, reader),
    request,
    setCheckpointHash(hash: Hex) { checkpointOverride = hash; }
  };
}

describe("owner execution discovery", () => {
  it("returns every deterministic matching outer Ethereum hash and rejects unrelated events", async () => {
    const f = fixture([
      rpcLog({ hash: HASH_B, blockNumber: 120n, logIndex: 3 }),
      rpcLog({ hash: zeroHash, blockNumber: 110n, logIndex: 1, approver: OTHER }),
      rpcLog({ hash: HASH_A, blockNumber: 110n, logIndex: 2 }),
      rpcLog({ hash: HASH_A, blockNumber: 110n, logIndex: 4 })
    ]);
    const result = await f.discover({ intent: intent(), timeoutMs: 1_000 });
    expect(result.candidates).toEqual([HASH_A, HASH_B]);
    expect(result.scanned).toEqual({ fromBlock: 100n, toBlock: 2_099n });
    expect(result.caughtUp).toBe(false);
    expect(result.cursor.nextBlock).toBe(2_100n);
  });

  it("requires the exact revocation revision and resets a noncanonical cursor checkpoint", async () => {
    const f = fixture([
      rpcLog({ hash: HASH_A, blockNumber: 110n, logIndex: 1, kind: "revokeRaffleApproval", nextRevision: 5n }),
      rpcLog({ hash: HASH_B, blockNumber: 120n, logIndex: 2, kind: "revokeRaffleApproval", nextRevision: 6n })
    ]);
    const first = await f.discover({ intent: intent("revokeRaffleApproval"), timeoutMs: 1_000 });
    expect(first.candidates).toEqual([HASH_A]);
    f.setCheckpointHash(HASH_B);
    const reset = await f.discover({ intent: intent("revokeRaffleApproval"), cursor: first.cursor, timeoutMs: 1_000 });
    expect(reset.reset).toBe(true);
    expect(reset.scanned.fromBlock).toBe(reviewBlock.number);
  });

  it("bounds RPC time and candidate count without inventing an execution", async () => {
    const stalled = fixture([]);
    stalled.request.mockImplementation(() => new Promise(() => undefined));
    await expect(stalled.discover({ intent: intent(), timeoutMs: 25 })).rejects.toThrow(/timed out/i);

    const crowded = fixture(Array.from({ length: 33 }, (_, index) => rpcLog({
      hash: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex,
      blockNumber: 110n + BigInt(index),
      logIndex: index
    })));
    await expect(crowded.discover({ intent: intent(), timeoutMs: 1_000 })).rejects.toThrow(/too many matching owner events/i);
  });

  it("rejects a page whose canonical checkpoint changes while logs are being read", async () => {
    const logs = [rpcLog({ hash: HASH_A, blockNumber: 110n, logIndex: 1 })];
    const f = fixture(logs);
    f.request.mockImplementation(async () => {
      f.setCheckpointHash(HASH_B);
      return logs;
    });
    await expect(f.discover({ intent: intent(), timeoutMs: 1_000 })).rejects.toThrow(/block changed/i);
  });

  it("filters malformed event encodings and log identities before returning candidates", async () => {
    const malformedData = { ...rpcLog({ hash: HASH_A, blockNumber: 110n, logIndex: 1 }), data: "0x12" as Hex };
    const extraTopicBase = rpcLog({ hash: HASH_B, blockNumber: 111n, logIndex: 2 });
    const extraTopic = { ...extraTopicBase, topics: [...extraTopicBase.topics, zeroHash] as typeof extraTopicBase.topics };
    const malformedHash = { ...rpcLog({ hash: HASH_A, blockNumber: 112n, logIndex: 3 }), transactionHash: "0x05" as Hex };
    const staleBlock = { ...rpcLog({ hash: HASH_A, blockNumber: 114n, logIndex: 4 }), blockHash: HASH_B };
    const approval = fixture([malformedData, extraTopic, malformedHash, staleBlock]);
    expect((await approval.discover({ intent: intent(), timeoutMs: 1_000 })).candidates).toEqual([]);

    const malformedRevisionData = {
      ...rpcLog({ hash: HASH_A, blockNumber: 113n, logIndex: 5, kind: "revokeRaffleApproval", nextRevision: 5n }),
      data: `${encodeAbiParameters([{ type: "uint256" }], [5n])}00` as Hex
    };
    const revocation = fixture([malformedRevisionData]);
    expect((await revocation.discover({ intent: intent("revokeRaffleApproval"), timeoutMs: 1_000 })).candidates).toEqual([]);
  });

  it("skips malformed RPC items without starving later valid candidates", async () => {
    const missingTopics = { ...rpcLog({ hash: HASH_A, blockNumber: 110n, logIndex: 1 }), topics: undefined };
    const f = fixture([null, missingTopics, rpcLog({ hash: HASH_B, blockNumber: 111n, logIndex: 2 })]);
    await expect(f.discover({ intent: intent(), timeoutMs: 1_000 })).resolves.toMatchObject({ candidates: [HASH_B] });
  });
});
