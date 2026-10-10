import { decodeFunctionData, type Address } from "viem";
import { raffleAbi } from "../chain/abi";
import { availableActions } from "../chain/workflow";
import { sameAddress } from "../chain/validation";
import type { PreparedAction, Raffle, RaffleSnapshot } from "../chain/types";

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

/** Up to `limit` raffle ids starting at `cursor`, wrapping past the newest raffle back to id 1. */
export function scanWindow(cursor: bigint, nextId: bigint, limit: number): { ids: bigint[]; nextCursor: bigint } {
  const total = nextId - 1n;
  if (total <= 0n) return { ids: [], nextCursor: 1n };
  const start = cursor >= 1n && cursor <= total ? cursor : 1n;
  const count = BigInt(limit) < total ? BigInt(limit) : total;
  const ids = Array.from({ length: Number(count) }, (_, offset) => (start - 1n + BigInt(offset)) % total + 1n);
  return { ids, nextCursor: (start - 1n + count) % total + 1n };
}

/** Rejects any prepared transaction other than the expected zero-value draw call on the raffle contract. */
export function assertRunnerCall(prepared: PreparedAction, action: RunnerAction, contract: Address): void {
  const call = decodeFunctionData({ abi: raffleAbi, data: prepared.data });
  if (!sameAddress(prepared.to, contract) || prepared.value !== 0n || call.functionName !== action.kind || call.args?.[0] !== action.id) {
    throw new Error("The draw runner refused an unexpected transaction.");
  }
  if (action.kind === "snapshot" && call.args?.[1] !== action.maxSteps) throw new Error("The draw runner refused an unexpected transaction.");
}
