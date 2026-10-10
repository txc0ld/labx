import { parseEther, type Address, type Hex } from "viem";
import type { Store } from "../points";
import type { PreparedAction, RaffleSnapshot } from "../chain/types";
import { assertRunnerCall, nextRunnerAction, type RunnerAction } from "./decide";

export const RUN_MS = 56_000;
export const MAX_SENDS = 6;
export const SCAN_LIMIT = 50;
export const MIN_BALANCE = parseEther("0.01");
const LEASE_BUCKET_MS = 60_000;
const CURSOR_KEY = "draw-runner:cursor";

export type SendResult = { kind: "sent"; hash: Hex } | { kind: "fee-cap" } | { kind: "failed"; hash: Hex | null };

/** Chain access for one run. The viem implementation lives in ./chain. */
export type DrawChain = {
  runner: Address;
  contract: Address;
  /** Contract owner, pinned treasury and Safe owners. Throws when any of them cannot be read. */
  privilegedAddresses(): Promise<readonly Address[]>;
  scan(cursor: bigint, limit: number): Promise<{ candidates: readonly bigint[]; nextCursor: bigint }>;
  read(id: bigint): Promise<RaffleSnapshot>;
  /** Builds and simulates at a pinned block. Throws when the step no longer applies. */
  prepare(action: RunnerAction): Promise<PreparedAction>;
  balance(): Promise<bigint>;
  nonces(): Promise<{ latest: number; pending: number }>;
  send(prepared: PreparedAction, nonce: number): Promise<SendResult>;
  wait(hash: Hex, timeoutMs: number): Promise<"succeeded" | "reverted" | "pending">;
};

export type RunOutcome = "succeeded" | "reverted" | "pending" | "failed" | "skipped";
export type RunItem = { id: string; action: RunnerAction["kind"]; hash: Hex | null; outcome: RunOutcome };
export type RunStatus = "complete" | "busy" | "send-cap" | "deadline" | "low-funds" | "fee-cap" | "pending-transaction" | "send-failed" | "interrupted";
export type RunReport = { status: RunStatus; runner: Address; sends: number; items: RunItem[]; nextCursor: string | null };

export async function runDraw({ chain, store, now, deadline }: { chain: DrawChain; store: Store; now: () => number; deadline: number }): Promise<RunReport> {
  const bucket = Math.floor(now() / LEASE_BUCKET_MS), started = new Date(now()).toISOString();
  // A run lasts under one bucket, so holding this bucket and the next excludes every overlapping run.
  const leased = await store.setIfAbsent({ [`draw-runner:lease:${bucket}`]: started, [`draw-runner:lease:${bucket + 1}`]: started });
  const report: RunReport = { status: "complete", runner: chain.runner, sends: 0, items: [], nextCursor: null };
  if (!leased) return { ...report, status: "busy" };
  if (await chain.balance() < MIN_BALANCE) return { ...report, status: "low-funds" };

  const saved = await store.get(CURSOR_KEY);
  const scan = await chain.scan(saved && /^[1-9]\d{0,77}$/.test(saved) ? BigInt(saved) : 1n, SCAN_LIMIT);
  let nextCursor = scan.nextCursor;
  const stop = (status: RunStatus, id: bigint) => { report.status = status; nextCursor = id; };
  raffles: for (const id of scan.candidates) {
    try {
      for (;;) {
        if (now() >= deadline) { stop("deadline", id); break raffles; }
        const action = nextRunnerAction(await chain.read(id), chain.runner);
        if (!action) break;
        if (report.sends >= MAX_SENDS) { stop("send-cap", id); break raffles; }
        let prepared: PreparedAction;
        try {
          prepared = await chain.prepare(action);
          assertRunnerCall(prepared, action, chain.contract);
        } catch {
          report.items.push({ id: id.toString(), action: action.kind, hash: null, outcome: "skipped" });
          break;
        }
        if (await chain.balance() < MIN_BALANCE) { stop("low-funds", id); break raffles; }
        const nonce = await chain.nonces();
        if (nonce.pending !== nonce.latest) { stop("pending-transaction", id); break raffles; }
        if (now() >= deadline) { stop("deadline", id); break raffles; }
        const sent = await chain.send(prepared, nonce.pending);
        if (sent.kind === "fee-cap") { stop("fee-cap", id); break raffles; }
        report.sends++;
        if (sent.kind === "failed") {
          report.items.push({ id: id.toString(), action: action.kind, hash: sent.hash, outcome: "failed" });
          stop("send-failed", id); break raffles;
        }
        const outcome = await chain.wait(sent.hash, deadline - now());
        report.items.push({ id: id.toString(), action: action.kind, hash: sent.hash, outcome });
        if (outcome === "pending") { stop("pending-transaction", id); break raffles; }
        if (outcome === "reverted") break;
      }
    } catch {
      // A read failed. Resume after this raffle so one unreadable raffle cannot stall the scan.
      stop("interrupted", id + 1n); break;
    }
  }
  try { await store.set(CURSOR_KEY, nextCursor.toString()); } catch { report.status = "interrupted"; }
  return { ...report, nextCursor: nextCursor.toString() };
}
