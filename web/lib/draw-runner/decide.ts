import { decodeFunctionData, type Address } from "viem";
import { raffleAbi } from "../chain/abi";
import { availableActions } from "../chain/workflow";
import { sameAddress } from "../chain/validation";
import type { PreparedAction, Raffle, RaffleSnapshot } from "../chain/types";
import { within } from "./errors";

export const SNAPSHOT_BATCH = 100n;

export type RunnerAction =
  | { kind: "close" | "requestRandomness" | "settle"; id: bigint }
  | { kind: "snapshot"; id: bigint; maxSteps: bigint };

/** The single permissionless draw step the runner may send for this raffle now, or null. */
export function nextRunnerAction(snapshot: RaffleSnapshot, runner: Address): RunnerAction | null {
  const r = snapshot.raffle, id = snapshot.id;
  const beforeDrawDeadline = snapshot.block.timestamp < r.salesEnd + snapshot.drawStartGrace;
  const enabled = new Set(availableActions(snapshot, {
    account: runner, snapshot, principal: 0n, fee: 0n, usdcBalance: 0n, usdcAllowance: 0n, nftOwner: null, nftApproved: false
  }).filter(action => action.enabled).map(action => action.kind));
  if (r.phase === 1 && enabled.has("close") && snapshot.lotCount > 0n && beforeDrawDeadline) return { kind: "close", id };
  if (r.phase === 2 && enabled.has("snapshot") && beforeDrawDeadline) return { kind: "snapshot", id, maxSteps: SNAPSHOT_BATCH };
  if (r.phase === 2 && enabled.has("requestRandomness")) return { kind: "requestRandomness", id };
  if (r.phase === 4 && enabled.has("settle")) return { kind: "settle", id };
  return null;
}

/** Cheap filter over the raw raffle tuple. nextRunnerAction on a full snapshot decides. */
export function mayNeedRunner(r: Raffle, at: { now: bigint; drawStartGrace: bigint; revealGrace: bigint }): boolean {
  const beforeDrawDeadline = at.now < r.salesEnd + at.drawStartGrace;
  if (r.phase === 1) return at.now >= r.salesEnd && beforeDrawDeadline;
  if (r.phase === 2) return beforeDrawDeadline;
  if (r.phase === 4) return r.revealed || at.now >= r.drawnAt + at.revealGrace;
  return false;
}

/** Settled and cancelled raffles never change phase again. */
export function finalPhase(r: Raffle): boolean {
  return r.phase === 5 || r.phase === 6;
}

/** Up to `limit` raffle ids starting at `cursor`, wrapping past the newest raffle back to the low-water mark. */
export function scanWindow(cursor: bigint, lowWater: bigint, nextId: bigint, limit: number): { ids: bigint[]; nextCursor: bigint } {
  const size = nextId - lowWater;
  if (size <= 0n) return { ids: [], nextCursor: lowWater };
  const start = cursor >= lowWater && cursor < nextId ? cursor : lowWater;
  const count = BigInt(limit) < size ? BigInt(limit) : size;
  const ids = Array.from({ length: Number(count) }, (_, offset) => lowWater + (start - lowWater + BigInt(offset)) % size);
  return { ids, nextCursor: lowWater + (start - lowWater + count) % size };
}

/** Raffle reads the scan keeps in flight at once. */
export const SCAN_CONCURRENCY = 8;

export type ScanResult = { candidates: bigint[]; nextCursor: bigint; lowWater: bigint; stop: "deadline" | "interrupted" | null };

/**
 * Reads up to `limit` raffles from `cursor` in scanWindow order, at most SCAN_CONCURRENCY at a time, and keeps the ids
 * whose raffle passes `keep`. The scan ends at the first read that fails or has not finished within `timeoutMs`, and
 * only the raffles before that point count. The next cursor is the first raffle not read, or the one after a raffle
 * whose read failed, so one unreadable raffle cannot stall the scan. The low-water mark moves up over counted raffles
 * that pass `final` and stops at the first raffle that does not, or that was not counted.
 */
export async function scanRaffles<T>({ cursor, lowWater, nextId, limit, timeoutMs, read, keep, final }: {
  cursor: bigint; lowWater: bigint; nextId: bigint; limit: number; timeoutMs: number;
  read: (id: bigint) => Promise<T>; keep: (raffle: T) => boolean; final: (raffle: T) => boolean;
}): Promise<ScanResult> {
  // A mark above the raffle count was not saved for these raffles, so the scan starts over from the first one.
  const from = lowWater >= 1n && lowWater <= nextId ? lowWater : 1n;
  const { ids, nextCursor } = scanWindow(cursor, from, nextId, limit);
  const results: ({ raffle: T } | "failed")[] = [];
  let started = 0, halted = false;
  async function worker() {
    while (!halted && started < ids.length) {
      const index = started++;
      try { results[index] = { raffle: await read(ids[index]) }; } catch { results[index] = "failed"; halted = true; }
    }
  }
  await within(Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, ids.length) }, worker)), timeoutMs).catch(() => {});
  halted = true;
  let done = 0;
  while (done < ids.length && typeof results[done] === "object") done++;
  const counted = ids.slice(0, done).map((id, index) => ({ id, raffle: (results[index] as { raffle: T }).raffle }));
  const candidates = counted.filter(item => keep(item.raffle)).map(item => item.id);
  const isFinal = new Map(counted.map(item => [item.id, final(item.raffle)]));
  let mark = from;
  while (isFinal.get(mark)) mark++;
  if (done === ids.length) return { candidates, nextCursor, lowWater: mark, stop: null };
  if (results[done] === "failed") return { candidates, nextCursor: ids[done + 1] ?? nextCursor, lowWater: mark, stop: "interrupted" };
  return { candidates, nextCursor: ids[done], lowWater: mark, stop: "deadline" };
}

/** Rejects any prepared transaction other than the expected zero-value draw call on the raffle contract. */
export function assertRunnerCall(prepared: PreparedAction, action: RunnerAction, contract: Address): void {
  const call = decodeFunctionData({ abi: raffleAbi, data: prepared.data });
  if (!sameAddress(prepared.to, contract) || prepared.value !== 0n || call.functionName !== action.kind || call.args?.[0] !== action.id) {
    throw new Error("The draw runner refused an unexpected transaction.");
  }
  if (action.kind === "snapshot" && call.args?.[1] !== action.maxSteps) throw new Error("The draw runner refused an unexpected transaction.");
}
