import { decodeEventLog, encodeAbiParameters, encodeEventTopics, formatLog, numberToHex, type Hex, type PublicClient } from "viem";
import { raffleAbi } from "./abi";
import type { BlockRef, DeploymentManifest, OwnerExecutionIntent } from "./types";
import { address, hash, positiveId, sameAddress } from "./validation";

const BLOCK_PAGE_SIZE = 2_000n;
const MAX_CANDIDATES = 32;

export type OwnerExecutionDiscoveryCursor = {
  nextBlock: bigint;
  checkpoint: BlockRef;
};

export type OwnerExecutionDiscoveryPage = {
  candidates: readonly Hex[];
  cursor: OwnerExecutionDiscoveryCursor;
  scanned: { fromBlock: bigint; toBlock: bigint };
  head: BlockRef;
  caughtUp: boolean;
  reset: boolean;
};

type DiscoveryReader = {
  checkedBlock(requested?: BlockRef): Promise<BlockRef>;
};

function sameHash(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddressHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isRpcQuantity(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
}

function hasCanonicalLogShape(value: unknown, expectedData: Hex) {
  if (typeof value !== "object" || value === null) return false;
  const log = value as Record<string, unknown>;
  return isAddressHex(log.address)
    && isBytes32(log.blockHash)
    && isRpcQuantity(log.blockNumber)
    && isRpcQuantity(log.logIndex)
    && isBytes32(log.transactionHash)
    && isRpcQuantity(log.transactionIndex)
    && typeof log.removed === "boolean"
    && Array.isArray(log.topics)
    && log.topics.length === 4
    && log.topics.every(isBytes32)
    && typeof log.data === "string"
    && sameHash(log.data, expectedData);
}

function validateIntent(intent: OwnerExecutionIntent, manifest: DeploymentManifest) {
  positiveId(intent.action.id);
  hash(intent.action.expectedReviewHash);
  address(intent.from);
  if ((intent.action.kind !== "approveRaffle" && intent.action.kind !== "revokeRaffleApproval")
    || intent.chainId !== manifest.chainId || !sameAddress(intent.to, manifest.address) || intent.value !== 0n
    || !sameHash(hash(intent.runtimeCodeHash), hash(manifest.runtimeCodeHash))
    || intent.reviewBlock.number < manifest.deploymentBlock) throw new Error("Owner execution discovery does not match this deployment.");
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Owner execution discovery timeout is invalid.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owner execution discovery timed out. Retry when the RPC is available.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function ownerExecutionDiscoverer(client: PublicClient, manifest: DeploymentManifest, reader: DiscoveryReader) {
  return async function discoverOwnerExecutions({ intent, cursor, timeoutMs = 10_000 }: {
    intent: OwnerExecutionIntent;
    cursor?: OwnerExecutionDiscoveryCursor;
    timeoutMs?: number;
  }): Promise<OwnerExecutionDiscoveryPage> {
    return withTimeout((async () => {
      validateIntent(intent, manifest);
      await reader.checkedBlock(intent.reviewBlock);
      const head = await reader.checkedBlock();
      let fromBlock = intent.reviewBlock.number;
      let reset = false;

      if (cursor !== undefined) {
        if (cursor.nextBlock !== cursor.checkpoint.number + 1n || cursor.checkpoint.number < intent.reviewBlock.number) throw new Error("Owner execution discovery cursor is invalid.");
        const checkpoint = await client.getBlock({ blockNumber: cursor.checkpoint.number });
        if (checkpoint.hash === null || !sameHash(checkpoint.hash, cursor.checkpoint.hash)) reset = true;
        else fromBlock = cursor.nextBlock;
      }

      if (fromBlock > head.number) {
        const checkpoint = cursor && !reset ? cursor.checkpoint : intent.reviewBlock;
        return {
          candidates: [],
          cursor: { nextBlock: checkpoint.number + 1n, checkpoint },
          scanned: { fromBlock, toBlock: checkpoint.number },
          head,
          caughtUp: true,
          reset
        };
      }

      const toBlock = fromBlock + BLOCK_PAGE_SIZE - 1n < head.number ? fromBlock + BLOCK_PAGE_SIZE - 1n : head.number;
      const eventName = intent.action.kind === "approveRaffle" ? "RaffleApproved" : "RaffleApprovalRevoked";
      const topics = encodeEventTopics({
        abi: raffleAbi,
        eventName,
        args: { id: intent.action.id, approver: intent.from, reviewHash: intent.action.expectedReviewHash }
      });
      const checkpointBlock = await client.getBlock({ blockNumber: toBlock });
      if (checkpointBlock.hash === null || checkpointBlock.number === null) throw new Error("Owner execution discovery checkpoint is unavailable.");
      const rawLogs = await client.request({
        method: "eth_getLogs",
        params: [{ address: manifest.address, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock), topics }]
      });
      const canonical = await client.getBlock({ blockNumber: toBlock });
      if (canonical.hash === null || !sameHash(canonical.hash, checkpointBlock.hash)) throw new Error("Owner execution discovery block changed. Retry the scan.");
      if (!Array.isArray(rawLogs)) throw new Error("Owner execution discovery returned an invalid log page.");
      if (rawLogs.length > MAX_CANDIDATES) throw new Error("Too many matching owner events in one bounded block page.");

      const expectedData = intent.action.kind === "approveRaffle"
        ? "0x"
        : encodeAbiParameters([{ type: "uint256" }], [intent.reviewRevision + 1n]);
      const logs = (rawLogs as readonly unknown[]).flatMap(rawLog => {
        if (!hasCanonicalLogShape(rawLog, expectedData)) return [];
        try { return [formatLog(rawLog as (typeof rawLogs)[number])]; }
        catch { return []; }
      }).sort((a, b) => {
        const blockOrder = (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : (a.blockNumber ?? 0n) > (b.blockNumber ?? 0n) ? 1 : 0;
        return blockOrder || (a.logIndex ?? 0) - (b.logIndex ?? 0);
      });
      const candidates: Hex[] = [];
      const seen = new Set<string>();
      for (const log of logs) {
        if (log.removed || log.blockHash === null || log.transactionHash === null || log.blockNumber === null || log.blockNumber < fromBlock || log.blockNumber > toBlock || !sameAddress(log.address, manifest.address)) continue;
        let decoded: ReturnType<typeof decodeEventLog<typeof raffleAbi>>;
        try { decoded = decodeEventLog({ abi: raffleAbi, data: log.data, topics: log.topics, strict: true }); }
        catch { continue; }
        if (decoded.eventName !== eventName || decoded.args.id !== intent.action.id || !sameAddress(decoded.args.approver, intent.from)
          || !sameHash(decoded.args.reviewHash, intent.action.expectedReviewHash)) continue;
        if (decoded.eventName === "RaffleApprovalRevoked" && decoded.args.nextRevision !== intent.reviewRevision + 1n) continue;
        const eventBlock = await client.getBlock({ blockNumber: log.blockNumber });
        if (eventBlock.hash === null || !sameHash(eventBlock.hash, log.blockHash)) continue;
        const key = log.transactionHash.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(log.transactionHash);
        }
      }

      const checkpoint: BlockRef = { number: checkpointBlock.number, hash: checkpointBlock.hash, timestamp: checkpointBlock.timestamp };
      await reader.checkedBlock(intent.reviewBlock);
      return {
        candidates,
        cursor: { nextBlock: checkpoint.number + 1n, checkpoint },
        scanned: { fromBlock, toBlock },
        head,
        caughtUp: toBlock === head.number,
        reset
      };
    })(), timeoutMs);
  };
}
