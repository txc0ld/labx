import { parseEther, parseGwei, type Address, type Hex } from "viem";
import type { Store } from "../points";
import type { PreparedAction, RaffleSnapshot } from "../chain/types";
import { assertRunnerCall, nextRunnerAction, type RunnerAction, type ScanResult } from "./decide";
import { errorCategory, within, type ErrorCategory } from "./errors";

export const RUN_MS = 56_000;
/** All chain and store work ends this long before the run deadline, which leaves time for the cursor write and the report. */
export const FINISH_RESERVE_MS = 4_000;
/** A send starts only with at least this much of the run left, so its broadcast and receipt wait fit. */
export const SEND_MIN_REMAINING_MS = 25_000;
export const SEND_TIMEOUT_MS = 10_000;
const CURSOR_WRITE_MS = 2_000;
export const MAX_SENDS = 6;
/** Most raffles one run reads. Two runs, about ten minutes apart, read every raffle at or above the low-water mark while there are at most twice this many. */
export const SCAN_LIMIT = 500;
/** The scan stops reading raffles after this long, so the steps it finds still have time to run. */
export const SCAN_MS = 20_000;
/** The scan, with its block and count reads, also ends this long before a send would have too little time, which leaves time to check the first step it finds. */
export const SCAN_MARGIN_MS = 5_000;
/** The scan always gets at least this long, so a run that started slowly still reads some raffles. */
export const SCAN_FLOOR_MS = 2_000;
export const MIN_BALANCE = parseEther("0.01");
export const MAX_FEE_PER_GAS = parseGwei("50");
/** Largest gas limit the runner signs for each call. snapshot(100) measured about 4.9M gas; the others under 200k. */
export const GAS_CAP: Readonly<Record<RunnerAction["kind"], bigint>> = { close: 400_000n, snapshot: 7_000_000n, requestRandomness: 400_000n, settle: 400_000n };
/** The vercel.json schedule runs every five minutes on the clock. */
export const LEASE_BUCKET_MS = 300_000;
const CURSOR_KEY = "draw-runner:cursor";
/** "<contract>:<id>": every raffle below id was settled or cancelled when a scan read it. */
const LOW_WATER_KEY = "draw-runner:low-water";

export type Quote = { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export type SendResult =
  | { kind: "sent"; hash: Hex }
  /** The node answered with an error, so the transaction is in no pool. */
  | { kind: "refused"; error: ErrorCategory }
  /** The transaction may or may not be in a pool. */
  | { kind: "unknown"; hash: Hex; error: ErrorCategory };

/** Chain access for one run. The viem implementation lives in ./chain. */
export type DrawChain = {
  runner: Address;
  contract: Address;
  /** Owner, pending owner, treasuries, and the Safe owners and modules of any of them with code, two levels down. Throws when any of them cannot be read. */
  privilegedAddresses(): Promise<readonly Address[]>;
  /**
   * Pins a block, reads the raffle count and up to `limit` raffles from `cursor`, never below `lowWater`, and returns
   * those that may need a step and the new low-water mark. Everything before the final block check stops after `timeoutMs`.
   */
  scan(cursor: bigint, lowWater: bigint, limit: number, timeoutMs: number): Promise<ScanResult>;
  read(id: bigint): Promise<RaffleSnapshot>;
  /** Builds and simulates at a pinned block. Throws when the step no longer applies. */
  prepare(action: RunnerAction): Promise<PreparedAction>;
  balance(): Promise<bigint>;
  nonces(): Promise<{ latest: number; pending: number }>;
  /** Current fees and a gas limit from a fresh estimate. Throws when the estimate fails, for example because someone else took the step. */
  quote(prepared: PreparedAction): Promise<Quote>;
  /** Signs with the quote and broadcasts, waiting at most timeoutMs for the node. */
  send(prepared: PreparedAction, nonce: number, quote: Quote, timeoutMs: number): Promise<SendResult>;
  /** Throws when no receipt arrives within timeoutMs. */
  wait(hash: Hex, timeoutMs: number): Promise<"succeeded" | "reverted">;
};

export type RunOutcome = "succeeded" | "reverted" | "unknown" | "failed" | "skipped" | "low-funds" | "gas-cap";
/** "Refused" marks a prepared call that the runner's own allowlist rejected. */
export type RunItem = { id: string; action: RunnerAction["kind"]; hash: Hex | null; outcome: RunOutcome; error: ErrorCategory | "Refused" | null };
export type RunStatus = "complete" | "busy" | "send-cap" | "deadline" | "low-funds" | "fee-cap" | "pending-transaction" | "send-failed" | "interrupted";
export type RunReport = { ok: boolean; status: RunStatus; runner: Address; sends: number; items: RunItem[]; nextCursor: string | null };
const HEALTHY: ReadonlySet<RunStatus> = new Set(["complete", "busy", "send-cap", "deadline"]);

/**
 * Lease keys for every five-minute bucket that [start, deadline] touches. Two runs whose intervals share an instant
 * both hold that instant's bucket, so the atomic setIfAbsent lets only one of them run. A run that starts on schedule
 * ends inside its own bucket and writes one row.
 */
export function leaseKeys(start: number, deadline: number): string[] {
  const first = Math.floor(start / LEASE_BUCKET_MS), last = Math.floor(deadline / LEASE_BUCKET_MS);
  return Array.from({ length: last - first + 1 }, (_, offset) => `draw-runner:lease:5m:${first + offset}`);
}

/** Balance a send needs: every unit of its gas limit at the maximum fee, plus a tenth for fee movement before it lands. */
export function requiredBalance(quote: Quote): bigint {
  return quote.gasLimit * quote.maxFeePerGas * 11n / 10n;
}

export async function runDraw({ chain, store, now, deadline }: { chain: DrawChain; store: Store; now: () => number; deadline: number }): Promise<RunReport> {
  const workEnd = deadline - FINISH_RESERVE_MS;
  const bounded = <T>(work: Promise<T>) => within(work, workEnd - now());
  const started = now();
  const leased = await bounded(store.setIfAbsent(Object.fromEntries(leaseKeys(started, deadline).map(key => [key, new Date(started).toISOString()]))));
  const report: RunReport = { ok: true, status: "complete", runner: chain.runner, sends: 0, items: [], nextCursor: null };
  if (!leased) return { ...report, status: "busy" };
  if (await bounded(chain.balance()) < MIN_BALANCE) return { ...report, ok: false, status: "low-funds" };

  const [savedCursor, savedLowWater] = await bounded(Promise.all([store.get(CURSOR_KEY), store.get(LOW_WATER_KEY)]));
  const savedId = (value: string | null) => value && /^[1-9]\d{0,77}$/.test(value) ? BigInt(value) : 1n;
  // The mark names its contract, so a mark saved for another deployment is ignored.
  const markPrefix = `${chain.contract.toLowerCase()}:`;
  const lowWater = savedLowWater?.startsWith(markPrefix) ? savedId(savedLowWater.slice(markPrefix.length)) : 1n;
  // The scan, including its block and count reads, ends early enough that the first step it finds can still be sent.
  const scanMs = Math.max(SCAN_FLOOR_MS, Math.min(SCAN_MS, deadline - SEND_MIN_REMAINING_MS - SCAN_MARGIN_MS - now()));
  const scan = await bounded(chain.scan(savedId(savedCursor), lowWater, SCAN_LIMIT, scanMs));
  let nextCursor = scan.nextCursor;
  // Progress means a raffle's check finished, or a scan that found nothing still moved the cursor on.
  let progressed = scan.candidates.length === 0 && scan.nextCursor !== savedId(savedCursor);
  // A scan that ran out of time or hit a failed read still hands over the raffles it read; the cursor resumes after them.
  if (scan.stop) report.status = scan.stop;
  const stop = (status: RunStatus, id: bigint) => { report.status = status; nextCursor = id; };
  raffles: for (const id of scan.candidates) {
    const record = (action: RunnerAction, hash: Hex | null, outcome: RunOutcome, error: RunItem["error"]) => {
      progressed = true;
      report.items.push({ id: id.toString(), action: action.kind, hash, outcome, error });
    };
    try {
      for (;;) {
        if (deadline - now() < SEND_MIN_REMAINING_MS) { stop("deadline", id); break raffles; }
        const action = nextRunnerAction(await bounded(chain.read(id)), chain.runner);
        if (!action) { progressed = true; break; }
        if (report.sends >= MAX_SENDS) { stop("send-cap", id); break raffles; }
        let prepared: PreparedAction;
        try {
          prepared = await bounded(chain.prepare(action));
        } catch (error) {
          // The step no longer applies, or it could not be checked. A revert carries no label.
          const category = errorCategory(error);
          record(action, null, "skipped", category === "Other" ? null : category);
          break;
        }
        try {
          assertRunnerCall(prepared, action, chain.contract);
        } catch {
          // The builder produced something other than the chosen step. Nothing is sent, and the report is not ok.
          record(action, null, "failed", "Refused");
          break;
        }
        let quote: Quote;
        try {
          quote = await bounded(chain.quote(prepared));
        } catch (error) {
          const category = errorCategory(error);
          // Someone else took the step after the pinned simulation. Nothing was sent; go on to the next raffle.
          if (category === "EstimateGasRevert") { record(action, null, "skipped", category); break; }
          if (category === "InsufficientFunds") { record(action, null, "low-funds", category); break; }
          record(action, null, "failed", category);
          stop("interrupted", id + 1n); break raffles;
        }
        if (quote.maxFeePerGas > MAX_FEE_PER_GAS) { stop("fee-cap", id); break raffles; }
        if (quote.gasLimit > GAS_CAP[action.kind]) { record(action, null, "gas-cap", null); break; }
        // An unaffordable step is left for a later run. Cheaper steps on later raffles still go ahead.
        if (await bounded(chain.balance()) < requiredBalance(quote)) { record(action, null, "low-funds", null); break; }
        const nonce = await bounded(chain.nonces());
        if (nonce.pending !== nonce.latest) { stop("pending-transaction", id); break raffles; }
        if (deadline - now() < SEND_MIN_REMAINING_MS) { stop("deadline", id); break raffles; }
        const sent = await chain.send(prepared, nonce.pending, quote, Math.min(SEND_TIMEOUT_MS, workEnd - now()));
        if (sent.kind === "refused") {
          if (sent.error === "InsufficientFunds") { record(action, null, "low-funds", sent.error); break; }
          record(action, null, "failed", sent.error);
          stop("send-failed", id + 1n); break raffles;
        }
        report.sends++;
        if (sent.kind === "unknown") {
          record(action, sent.hash, "unknown", sent.error);
          stop("pending-transaction", id); break raffles;
        }
        let outcome: "succeeded" | "reverted";
        try {
          outcome = await bounded(chain.wait(sent.hash, workEnd - now()));
        } catch (error) {
          record(action, sent.hash, "unknown", errorCategory(error));
          stop("pending-transaction", id); break raffles;
        }
        record(action, sent.hash, outcome, null);
        if (outcome === "reverted") break;
      }
    } catch {
      // A read failed or ran out of time. Resume after this raffle so one unreadable raffle cannot stall the scan.
      stop("interrupted", id + 1n); break;
    }
  }
  try {
    await within(Promise.all([store.set(CURSOR_KEY, nextCursor.toString()), store.set(LOW_WATER_KEY, `${markPrefix}${scan.lowWater}`)]), CURSOR_WRITE_MS);
  } catch { report.status = "interrupted"; }
  // A run that hit its deadline without finishing a single check has stalled, so it is not ok.
  report.ok = HEALTHY.has(report.status) && (report.status !== "deadline" || progressed)
    && report.items.every(item => item.outcome === "succeeded" || (item.outcome === "skipped" && (item.error === null || item.error === "EstimateGasRevert")));
  return { ...report, nextCursor: nextCursor.toString() };
}
