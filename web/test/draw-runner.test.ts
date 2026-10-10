import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createPublicClient, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionData, encodeFunctionResult, EstimateGasExecutionError, ExecutionRevertedError, http, HttpRequestError, InsufficientFundsError, keccak256, pad, parseEther,
  parseAbi, parseGwei, TimeoutError, toHex, WaitForTransactionReceiptTimeoutError, zeroAddress, zeroHash, type Address, type Hex
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { raffleAbi } from "../lib/chain/abi";
import type { PreparedAction, Raffle, RaffleSnapshot } from "../lib/chain/types";
import { MemoryStore } from "../lib/store";
import type { Store } from "../lib/points";
import { assertRunnerCall, finalPhase, mayNeedRunner, nextRunnerAction, SCAN_CONCURRENCY, scanRaffles, scanWindow, type RunnerAction, type ScanResult } from "../lib/draw-runner/decide";
import { createDrawChain, privilegedAddresses } from "../lib/draw-runner/chain";
import { errorCategory, RunnerTimeoutError, within } from "../lib/draw-runner/errors";
import { createDrawCronHandler, runnerAccount } from "../lib/draw-runner/http";
import {
  GAS_CAP, LEASE_BUCKET_MS, leaseKeys, MAX_FEE_PER_GAS, MIN_BALANCE, requiredBalance, RUN_MS, SCAN_FLOOR_MS, SCAN_LIMIT, SCAN_MS, type DrawChain, type Quote, type RunItem, type SendResult
} from "../lib/draw-runner/run";

// Anvil's public test mnemonic. These keys hold nothing outside a local test chain.
const anvilMnemonic = "test test test test test test test test test test test junk";
function anvilKey(index: number): Hex {
  const key = mnemonicToAccount(anvilMnemonic, { addressIndex: index }).getHdKey().privateKey;
  if (!key) throw new Error("Anvil key missing.");
  return toHex(key);
}
const runnerKey = anvilKey(5);
const runner = mnemonicToAccount(anvilMnemonic, { addressIndex: 5 }).address;
const contract: Address = "0x5555555555555555555555555555555555555555";
const seller: Address = "0x1111111111111111111111111111111111111111";
const owner: Address = "0x3333333333333333333333333333333333333333";
const secret = "draw-cron-secret-0123456789";
const DAY = 86_400n, GRACE = 7n * DAY, SALES_END = 1_000_000n;

function snapshot(overrides: Partial<Raffle> = {}, extra: { now?: bigint; lotCount?: bigint; paused?: boolean } = {}): RaffleSnapshot {
  return {
    id: 7n, block: { number: 1n, hash: zeroHash, timestamp: extra.now ?? SALES_END },
    raffle: {
      seller, nft: "0x2222222222222222222222222222222222222222", tokenId: 1n,
      salesEnd: SALES_END, createdAt: 1n, drawnAt: 0n, vrfRequestedAt: 0n, phase: 1, escrowed: true, snapshotted: false, revealed: false,
      reserveNonce: zeroHash, reserveCommit: zeroHash, publicHash: zeroHash, lotCursor: 0n, snapshotTotal: 0n,
      principalEscrow: 2_000_000n, feeEscrow: 40_000n, vrfRequestId: 0n, randomWord: 0n, winner: zeroAddress, packCount: 1, title: "Fixture",
      ...overrides
    },
    admission: { status: "opened", reviewHash: null, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: owner, approvedAtOpening: true } },
    packs: [], policy: {
      treasury: owner, termsHash: zeroHash, coordinator: zeroAddress, keyHash: zeroHash,
      subscriptionId: 1n, callbackGasLimit: 500_000, requestConfirmations: 3, nativePayment: true, buyerFeeBps: 200, sellerFeeBps: 200, minBuyerFeeUsdc: 2_500_000n
    },
    lotCount: extra.lotCount ?? 2n, paused: extra.paused ?? false, owner, ethEnabled: false,
    accounting: { grossPrincipal: 2_000_000n, buyerFees: 40_000n }, drawStartGrace: GRACE, randomnessGrace: GRACE, revealGrace: GRACE
  };
}

describe("draw runner decision table", () => {
  const cases: [string, RaffleSnapshot, RunnerAction | null][] = [
    ["draft", snapshot({ phase: 0 }), null],
    ["open before the sales deadline", snapshot({}, { now: SALES_END - 1n }), null],
    ["open at the sales deadline", snapshot({}, { now: SALES_END }), { kind: "close", id: 7n }],
    ["open after the sales deadline", snapshot({}, { now: SALES_END + DAY }), { kind: "close", id: 7n }],
    ["open while paused", snapshot({}, { now: SALES_END, paused: true }), { kind: "close", id: 7n }],
    ["open with zero lots", snapshot({}, { now: SALES_END + DAY, lotCount: 0n }), null],
    ["open one second before the draw-start deadline", snapshot({}, { now: SALES_END + GRACE - 1n }), { kind: "close", id: 7n }],
    ["open at the draw-start deadline", snapshot({}, { now: SALES_END + GRACE }), null],
    ["closed and not counted", snapshot({ phase: 2 }, { now: SALES_END + 1n }), { kind: "snapshot", id: 7n, maxSteps: 100n }],
    ["closed and partly counted", snapshot({ phase: 2, lotCursor: 100n, snapshotTotal: 300n }, { now: SALES_END + 1n, lotCount: 250n }), { kind: "snapshot", id: 7n, maxSteps: 100n }],
    ["closed and not counted at the draw-start deadline", snapshot({ phase: 2 }, { now: SALES_END + GRACE }), null],
    ["closed and counted", snapshot({ phase: 2, snapshotted: true, snapshotTotal: 6n }, { now: SALES_END + 1n }), { kind: "requestRandomness", id: 7n }],
    ["closed and counted one second before the draw-start deadline", snapshot({ phase: 2, snapshotted: true, snapshotTotal: 6n }, { now: SALES_END + GRACE - 1n }), { kind: "requestRandomness", id: 7n }],
    ["closed and counted at the draw-start deadline", snapshot({ phase: 2, snapshotted: true, snapshotTotal: 6n }, { now: SALES_END + GRACE }), null],
    ["closed with an empty count", snapshot({ phase: 2, snapshotted: true, snapshotTotal: 0n }, { now: SALES_END + 1n }), null],
    ["drawing", snapshot({ phase: 3, vrfRequestedAt: SALES_END + 1n }, { now: SALES_END + GRACE * 3n }), null],
    ["drawn and confirmed", snapshot({ phase: 4, drawnAt: SALES_END + 10n, revealed: true }, { now: SALES_END + 11n }), { kind: "settle", id: 7n }],
    ["drawn, not confirmed, inside the reveal grace", snapshot({ phase: 4, drawnAt: SALES_END + 10n }, { now: SALES_END + 10n + GRACE - 1n }), null],
    ["drawn, not confirmed, at the end of the reveal grace", snapshot({ phase: 4, drawnAt: SALES_END + 10n }, { now: SALES_END + 10n + GRACE }), { kind: "settle", id: 7n }],
    ["settled", snapshot({ phase: 5, revealed: true }, { now: SALES_END + GRACE * 4n }), null],
    ["cancelled", snapshot({ phase: 6 }, { now: SALES_END + GRACE * 4n }), null]
  ];
  it.each(cases)("%s", (_, state, expected) => {
    expect(nextRunnerAction(state, runner)).toEqual(expected);
  });
  it.each(cases)("the scan filter keeps %s whenever the runner has work", (_, state, expected) => {
    const kept = mayNeedRunner(state.raffle, { now: state.block.timestamp, drawStartGrace: state.drawStartGrace, revealGrace: state.revealGrace });
    if (expected) expect(kept).toBe(true);
  });
  it("drops raffles the runner never acts on from the scan", () => {
    const at = { drawStartGrace: GRACE, revealGrace: GRACE };
    expect(mayNeedRunner(snapshot({ phase: 0 }).raffle, { ...at, now: SALES_END })).toBe(false);
    expect(mayNeedRunner(snapshot().raffle, { ...at, now: SALES_END - 1n })).toBe(false);
    expect(mayNeedRunner(snapshot({ phase: 3 }).raffle, { ...at, now: SALES_END })).toBe(false);
    expect(mayNeedRunner(snapshot({ phase: 4, drawnAt: SALES_END }).raffle, { ...at, now: SALES_END + 1n })).toBe(false);
    expect(mayNeedRunner(snapshot({ phase: 5 }).raffle, { ...at, now: SALES_END })).toBe(false);
    expect(mayNeedRunner(snapshot({ phase: 6 }).raffle, { ...at, now: SALES_END })).toBe(false);
  });
});

describe("draw runner scan window", () => {
  it("covers every raffle when there are fewer than the limit", () => {
    expect(scanWindow(1n, 1n, 1n, 50)).toEqual({ ids: [], nextCursor: 1n });
    expect(scanWindow(1n, 1n, 4n, 50)).toEqual({ ids: [1n, 2n, 3n], nextCursor: 1n });
    expect(scanWindow(2n, 1n, 4n, 50)).toEqual({ ids: [2n, 3n, 1n], nextCursor: 2n });
  });
  it("resumes from the cursor and wraps past the newest raffle", () => {
    const first = scanWindow(1n, 1n, 121n, 50);
    expect(first.ids[0]).toBe(1n); expect(first.ids.at(-1)).toBe(50n); expect(first.nextCursor).toBe(51n);
    const third = scanWindow(101n, 1n, 121n, 50);
    expect(third.ids.slice(0, 2)).toEqual([101n, 102n]); expect(third.ids.slice(19, 21)).toEqual([120n, 1n]);
    expect(third.ids).toHaveLength(50); expect(third.nextCursor).toBe(31n);
  });
  it("restarts at the first raffle when the saved cursor is out of range", () => {
    expect(scanWindow(0n, 1n, 4n, 2)).toEqual({ ids: [1n, 2n], nextCursor: 3n });
    expect(scanWindow(99n, 1n, 4n, 2)).toEqual({ ids: [1n, 2n], nextCursor: 3n });
  });
  it("starts at the low-water mark and wraps back to it instead of to the first raffle", () => {
    expect(scanWindow(1n, 11n, 21n, 50)).toEqual({ ids: Array.from({ length: 10 }, (_, index) => BigInt(index + 11)), nextCursor: 11n });
    expect(scanWindow(18n, 11n, 21n, 5)).toEqual({ ids: [18n, 19n, 20n, 11n, 12n], nextCursor: 13n });
    expect(scanWindow(5n, 21n, 21n, 50)).toEqual({ ids: [], nextCursor: 21n });
  });
});

describe("draw runner low-water mark", () => {
  const raffles = (phases: readonly number[]) => phases.map(phase => snapshot({ phase }).raffle);
  function scan(phases: readonly number[], options: { cursor?: bigint; lowWater?: bigint; limit?: number; timeoutMs?: number; read?: (id: bigint) => Promise<Raffle> | undefined } = {}) {
    const all = raffles(phases);
    return scanRaffles({
      cursor: options.cursor ?? 1n, lowWater: options.lowWater ?? 1n, nextId: BigInt(phases.length + 1), limit: options.limit ?? SCAN_LIMIT, timeoutMs: options.timeoutMs ?? 10_000,
      read: async id => options.read?.(id) ?? all[Number(id) - 1], keep: () => false, final: finalPhase
    });
  }

  it("counts only settled and cancelled raffles as final", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(phase => finalPhase(snapshot({ phase }).raffle))).toEqual([false, false, false, false, false, true, true]);
  });
  it("moves over settled and cancelled raffles from the mark and stops at the first that is not", async () => {
    expect((await scan([5, 6, 5, 0, 5, 6])).lowWater).toBe(4n);
    for (const phase of [0, 1, 2, 3, 4]) expect((await scan([5, phase, 5])).lowWater).toBe(2n);
    expect((await scan([5, 6, 5])).lowWater).toBe(4n);
  });
  it("never moves past a raffle whose read failed or did not finish", async () => {
    expect(await scan([5, 5, 5, 5, 5], { read: id => id === 3n ? Promise.reject(new Error("rpc failed")) : undefined })).toMatchObject({ lowWater: 3n, stop: "interrupted" });
    expect(await scan([5, 5, 5, 5, 5], { timeoutMs: 30, read: id => id === 3n ? new Promise<never>(() => {}) : undefined })).toMatchObject({ lowWater: 3n, stop: "deadline" });
  });
  it("does not move when the mark is outside the raffles read, and follows a wrap back to it", async () => {
    expect(await scan([5, 5, 5, 5, 5, 5], { cursor: 4n, limit: 2 })).toMatchObject({ lowWater: 1n, nextCursor: 6n });
    expect(await scan([5, 5, 5, 0, 5, 5], { cursor: 5n, limit: 5 })).toMatchObject({ lowWater: 4n, nextCursor: 4n });
  });
  it("starts from the first raffle when the mark is above the raffle count", async () => {
    const read: bigint[] = [];
    expect(await scan([0, 5], { lowWater: 9n, read: id => { read.push(id); return undefined; } })).toMatchObject({ lowWater: 1n });
    expect(read).toEqual([1n, 2n]);
  });
});

describe("draw runner scan reads", () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => BigInt(index + 1));
  const even = (id: bigint) => id % 2n === 0n;

  const never = () => false;

  it("reads the window at most SCAN_CONCURRENCY at a time and keeps the raffles that pass", async () => {
    expect(SCAN_CONCURRENCY).toBe(8);
    let active = 0, peak = 0;
    const read = async (id: bigint) => { active++; peak = Math.max(peak, active); await new Promise(done => setTimeout(done, 1)); active--; return id; };
    const result = await scanRaffles({ cursor: 991n, lowWater: 1n, nextId: 1001n, limit: SCAN_LIMIT, timeoutMs: 10_000, read, keep: even, final: never });
    expect(peak).toBe(SCAN_CONCURRENCY);
    expect(result).toEqual({ candidates: [...ids(1000).slice(990), ...ids(490)].filter(even), nextCursor: 491n, lowWater: 1n, stop: null });
  });

  it("keeps the raffles before a failed read and resumes after it", async () => {
    const read = async (id: bigint) => { if (id === 7n) throw new Error("rpc failed"); return id; };
    expect(await scanRaffles({ cursor: 1n, lowWater: 1n, nextId: 21n, limit: 20, timeoutMs: 10_000, read, keep: () => true, final: never }))
      .toEqual({ candidates: ids(6), nextCursor: 8n, lowWater: 1n, stop: "interrupted" });
    expect(await scanRaffles({ cursor: 1n, lowWater: 1n, nextId: 21n, limit: 7, timeoutMs: 10_000, read, keep: () => true, final: never }))
      .toEqual({ candidates: ids(6), nextCursor: 8n, lowWater: 1n, stop: "interrupted" });
  });

  it("keeps the raffles read before the time ran out, resumes at the first unread raffle and starts no read after that", async () => {
    const reads: bigint[] = [];
    const read = (id: bigint) => { reads.push(id); return id === 5n ? new Promise<bigint>(() => {}) : new Promise<bigint>(done => setTimeout(() => done(id), 2)); };
    expect(await scanRaffles({ cursor: 1n, lowWater: 1n, nextId: 1001n, limit: SCAN_LIMIT, timeoutMs: 30, read, keep: () => true, final: never }))
      .toEqual({ candidates: ids(4), nextCursor: 5n, lowWater: 1n, stop: "deadline" });
    const count = reads.length;
    expect(count).toBeGreaterThan(SCAN_CONCURRENCY);
    expect(count).toBeLessThan(SCAN_LIMIT);
    await new Promise(done => setTimeout(done, 30));
    expect(reads).toHaveLength(count);
  });
});

function prepared(action: RunnerAction, changes: Partial<PreparedAction> = {}): PreparedAction {
  const data = action.kind === "snapshot"
    ? encodeFunctionData({ abi: raffleAbi, functionName: "snapshot", args: [action.id, action.maxSteps] })
    : encodeFunctionData({ abi: raffleAbi, functionName: action.kind, args: [action.id] });
  return { action, account: runner, chainId: 31337, to: contract, value: 0n, data, title: action.kind, amountUsdc: 0n, recipient: contract, block: { number: 1n, hash: zeroHash, timestamp: 1n }, walletRevision: 0, ...changes };
}

describe("draw runner call allowlist", () => {
  it("accepts the expected zero-value raffle call", () => {
    expect(() => assertRunnerCall(prepared({ kind: "close", id: 7n }), { kind: "close", id: 7n }, contract)).not.toThrow();
    expect(() => assertRunnerCall(prepared({ kind: "snapshot", id: 7n, maxSteps: 100n }), { kind: "snapshot", id: 7n, maxSteps: 100n }, contract)).not.toThrow();
  });
  const close: RunnerAction = { kind: "close", id: 7n };
  it.each([
    ["another contract", prepared(close, { to: seller }), close],
    ["nonzero value", prepared(close, { value: 1n }), close],
    ["another function", prepared(close, { data: encodeFunctionData({ abi: raffleAbi, functionName: "cancel", args: [7n] }) }), close],
    ["another raffle", prepared({ kind: "close", id: 8n }), close],
    ["another batch size", prepared({ kind: "snapshot", id: 7n, maxSteps: 300n }), { kind: "snapshot", id: 7n, maxSteps: 100n } as RunnerAction]
  ])("refuses %s", (_, call, expected) => {
    expect(() => assertRunnerCall(call, expected, contract)).toThrow("The draw runner refused an unexpected transaction.");
  });
});

describe("draw runner key", () => {
  it.each([
    ["missing", undefined], ["empty", ""], ["short", runnerKey.slice(0, 64)], ["short without 0x", runnerKey.slice(3)],
    ["long without 0x", `${runnerKey.slice(2)}0`], ["with an uppercase 0X", `0X${runnerKey.slice(2)}`], ["with a doubled prefix", `0x${runnerKey}`],
    ["with whitespace", `${runnerKey} `], ["without 0x and with whitespace", ` ${runnerKey.slice(2)}`], ["not hex", `0x${"zz".repeat(32)}`],
    ["zero", `0x${"00".repeat(32)}`], ["zero without 0x", "00".repeat(32)], ["above the curve order", `0x${"ff".repeat(32)}`]
  ])("rejects a %s key", (_, value) => {
    expect(runnerAccount(value)).toBeNull();
  });
  it("derives the runner address from a valid key with or without the 0x prefix", () => {
    expect(runnerAccount(runnerKey)?.address).toBe(runner);
    expect(runnerKey.slice(2)).toMatch(/^[0-9a-f]{64}$/);
    expect(runnerAccount(runnerKey.slice(2))?.address).toBe(runner);
    expect(runnerAccount(runnerKey.slice(2).toUpperCase())?.address).toBe(runner);
  });
});

describe("privileged address discovery", () => {
  const manifest = {
    chainId: 31337 as const, version: 3 as const, address: contract, usdc: seller, runtimeCodeHash: zeroHash, deploymentBlock: 0n,
    expectedOwner: owner, expectedPolicy: snapshot().policy
  };
  const treasury: Address = "0x4444444444444444444444444444444444444444";
  const signer: Address = "0x6666666666666666666666666666666666666666";
  const nested: Address = "0x7777777777777777777777777777777777777777";
  const deep: Address = "0x8888888888888888888888888888888888888888";
  /** Every EIP-7702 account in these tests delegates to this address. */
  const delegate: Address = "0xabababababababababababababababababababab";
  const safeAbi = parseAbi([
    "function getOwners() view returns (address[])",
    "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)"
  ]);
  const offchainLookupAbi = parseAbi(["error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)"]);
  type SafeCall = "getOwners" | "getModulesPaginated";
  type Answer = { result: Hex } | { error: { code: number; message: string; data?: Hex } } | "network";
  const reverted: Answer = { error: { code: 3, message: "execution reverted" } };
  type Safe = { owners: readonly Address[]; modules?: readonly Address[]; next?: Address; fail?: SafeCall; answer?: Partial<Record<SafeCall, Answer>> };
  /** A fake JSON-RPC node behind a real viem client, so call errors are classified the way a live node's would be. */
  function world(state: { owner?: Address; pendingOwner?: Address; treasury?: Address; safes?: Record<Address, Safe>; delegated?: readonly Address[]; emptyDelegate?: boolean; failCode?: Address; failRead?: string }) {
    const safes = new Map(Object.entries(state.safes ?? {}).map(([address, safe]) => [address.toLowerCase(), safe]));
    const calls: string[] = [];
    const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
    function answer(method: string, params: readonly unknown[]): Answer {
      if (method === "eth_getCode") {
        const address = params[0] as Address;
        calls.push(`getCode:${address}`);
        if (state.failCode && same(address, state.failCode)) return "network";
        if (state.delegated?.some(item => same(item, address))) return { result: `0xef0100${delegate.slice(2)}` };
        if (same(address, delegate)) return { result: state.emptyDelegate ? "0x" : "0x6080" };
        return { result: safes.has(address.toLowerCase()) ? "0x6080" : "0x" };
      }
      if (method !== "eth_call") throw new Error(`Unexpected ${method}.`);
      const { to, data } = params[0] as { to: Address; data: Hex };
      const call = decodeFunctionData({ abi: [...raffleAbi, ...safeAbi], data });
      calls.push(`${call.functionName}:${to}`);
      if (same(to, contract)) {
        if (state.failRead === call.functionName) return reverted;
        const value = call.functionName === "owner" ? state.owner ?? owner : call.functionName === "pendingOwner" ? state.pendingOwner ?? zeroAddress : state.treasury ?? owner;
        return { result: encodeAbiParameters([{ type: "address" }], [value]) };
      }
      const safe = safes.get(to.toLowerCase());
      if (!safe || safe.fail === call.functionName) return reverted;
      const override = safe.answer?.[call.functionName as SafeCall];
      if (override) return override;
      if (call.functionName === "getOwners") return { result: encodeFunctionResult({ abi: safeAbi, functionName: "getOwners", result: safe.owners }) };
      expect(call.args).toEqual(["0x0000000000000000000000000000000000000001", 50n]);
      return { result: encodeFunctionResult({ abi: safeAbi, functionName: "getModulesPaginated", result: [safe.modules ?? [], safe.next ?? "0x0000000000000000000000000000000000000001"] }) };
    }
    const fetchFn = async (_: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: readonly unknown[] };
      const reply = answer(body.method, body.params);
      if (reply === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...reply }), { headers: { "Content-Type": "application/json" } });
    };
    const client = createPublicClient({ transport: http("http://127.0.0.1:1/rpc", { fetchFn: fetchFn as typeof fetch, retryCount: 0 }) });
    return { client, calls };
  }
  const list = (state: Parameters<typeof world>[0]) => privilegedAddresses(world(state).client, manifest, 1n);

  it("lists the owner and treasuries without a Safe call when they are wallets", async () => {
    const { client, calls } = world({ treasury });
    await expect(privilegedAddresses(client, manifest, 1n)).resolves.toEqual([owner, treasury]);
    expect(calls.filter(call => call.startsWith("get") && !call.startsWith("getCode"))).toEqual([]);
  });
  it("adds the pending owner", async () => {
    await expect(list({ pendingOwner: runner })).resolves.toEqual([owner, runner]);
  });
  it("adds every Safe signer and every enabled module when the owner is a Safe", async () => {
    await expect(list({ safes: { [owner]: { owners: [signer, runner] } } })).resolves.toEqual([owner, signer, runner]);
    await expect(list({ safes: { [owner]: { owners: [signer], modules: [runner] } } })).resolves.toEqual([owner, signer, runner]);
  });
  it("treats an EIP-7702 account whose delegate has no code as a wallet, without a Safe call", async () => {
    const { client, calls } = world({ safes: { [owner]: { owners: [signer, runner] } }, delegated: [signer], emptyDelegate: true });
    await expect(privilegedAddresses(client, manifest, 1n)).resolves.toEqual([owner, signer, runner]);
    expect(calls).toContain(`getCode:${signer}`);
    expect(calls).toContain(`getCode:${delegate}`);
    expect(calls.filter(call => call.endsWith(`:${signer}`))).toEqual([`getCode:${signer}`]);
    await expect(list({ pendingOwner: runner, delegated: [runner], emptyDelegate: true })).resolves.toEqual([owner, runner]);
  });
  const both = (answer: Answer) => ({ answer: { getOwners: answer, getModulesPaginated: answer } });
  it.each<[string, Partial<Safe>]>([
    ["reverts both Safe calls", both(reverted)],
    ["answers both Safe calls with gas required exceeds allowance", both({ error: { code: -32000, message: "gas required exceeds allowance (0)" } })],
    ["returns no data", both({ result: "0x" })],
    ["returns data that does not decode", both({ result: "0x1234" })],
    ["reverts with a reason", both({ error: { code: 3, message: "execution reverted: not a Safe", data: "0x08c379a0" } })],
    ["answers only the signer list", { fail: "getModulesPaginated" }],
    ["answers only the module list", { fail: "getOwners" }]
  ])("fails when an EIP-7702 account's delegate has code and %s", async (_, safe) => {
    await expect(list({ treasury, delegated: [treasury], safes: { [treasury]: { owners: [runner], modules: [runner], ...safe } } })).rejects.toThrow();
  });
  it("fails when an EIP-7702 account's delegate code cannot be read", async () => {
    await expect(list({ treasury, delegated: [treasury], failCode: delegate })).rejects.toThrow();
  });
  it("adds and expands the signers and modules of an EIP-7702 account whose delegate answers like a Safe", async () => {
    await expect(list({ treasury, delegated: [treasury], safes: { [treasury]: { owners: [signer], modules: [runner] } } })).resolves.toEqual([owner, treasury, signer, runner]);
    await expect(list({ treasury, delegated: [treasury], safes: { [treasury]: { owners: [nested] }, [nested]: { owners: [signer], modules: [runner] } } }))
      .resolves.toEqual([owner, treasury, nested, signer, runner]);
    await expect(list({ delegated: [signer], safes: { [owner]: { owners: [signer] }, [signer]: { owners: [deep], modules: [runner] } } })).resolves.toEqual([owner, signer, deep, runner]);
  });
  it("adds the signers of a treasury Safe that differs from the owner", async () => {
    await expect(list({ treasury, safes: { [treasury]: { owners: [runner] } } })).resolves.toEqual([owner, treasury, runner]);
  });
  it("adds the signers of a pending owner Safe", async () => {
    await expect(list({ pendingOwner: nested, safes: { [nested]: { owners: [runner] } } })).resolves.toEqual([owner, nested, runner]);
  });
  it("follows a Safe owned by another Safe one level down, and stops there", async () => {
    const { client, calls } = world({ safes: { [owner]: { owners: [signer, nested] }, [nested]: { owners: [deep], modules: [runner] }, [deep]: { owners: ["0x9999999999999999999999999999999999999999"] } } });
    await expect(privilegedAddresses(client, manifest, 1n)).resolves.toEqual([owner, signer, nested, deep, runner]);
    expect(calls).not.toContain(`getCode:${deep}`);
    expect(calls).not.toContain(`getOwners:${deep}`);
  });
  it.each([
    ["the owner", { failRead: "owner" }],
    ["the pending owner", { failRead: "pendingOwner" }],
    ["the treasury", { failRead: "treasury" }],
    ["the owner's code", { failCode: owner }],
    ["the Safe signer list", { safes: { [owner]: { owners: [signer], fail: "getOwners" as const } } }],
    ["the Safe module list", { safes: { [owner]: { owners: [signer], fail: "getModulesPaginated" as const } } }],
    ["a nested Safe module list", { safes: { [owner]: { owners: [nested] }, [nested]: { owners: [signer], fail: "getModulesPaginated" as const } } }],
    ["a treasury contract that is not a Safe", { treasury, safes: { [treasury]: { owners: [], fail: "getOwners" as const } } }],
    ["a treasury contract whose module call returns no data", { treasury, safes: { [treasury]: { owners: [], answer: { getModulesPaginated: { result: "0x" as Hex } } } } }]
  ])("fails when %s cannot be read", async (_, state) => {
    await expect(list(state)).rejects.toThrow();
  });
  it.each([
    ["the connection drops", { getOwners: "network" as const }],
    ["the node answers with an internal error", { getModulesPaginated: { error: { code: -32603, message: "internal error" } } }],
    ["the node answers with another error", { getOwners: { error: { code: -32000, message: "header not found" } } }]
  ])("fails instead of assuming a wallet when an EIP-7702 account's Safe call gets no answer because %s", async (_, answer) => {
    await expect(list({ treasury, delegated: [treasury], safes: { [treasury]: { owners: [], answer } } })).rejects.toThrow();
  });
  it.each([
    ["a contract owner", owner, {}],
    ["an EIP-7702 treasury whose delegate has code", treasury, { treasury, delegated: [treasury] }]
  ] as const)("never follows an off-chain lookup that %s answers, and refuses with 503", async (_, probed, state) => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: "0x" }));
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", runnerKey);
    try {
      const lookup = encodeErrorResult({ abi: offchainLookupAbi, errorName: "OffchainLookup", args: [probed, ["https://gateway.example/{sender}/{data}"], "0x", "0x12345678", "0x"] });
      const reply: Answer = { error: { code: 3, message: "execution reverted", data: lookup } };
      const { client } = world({ ...state, safes: { [probed]: { owners: [], answer: { getOwners: reply, getModulesPaginated: reply } } } });
      const { chain, sent } = fakeChain({ 1: open() });
      chain.privilegedAddresses = () => privilegedAddresses(client, manifest, 1n);
      const { response, body } = await call(chain);
      expect(response.status).toBe(503);
      expect(body).toEqual({ ok: false, error: "The draw runner could not check the deployment." });
      expect(sent).toEqual([]);
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore(); logged.mockRestore(); vi.unstubAllEnvs();
    }
  });
  it("fails when a Safe has more modules than one page", async () => {
    await expect(list({ safes: { [owner]: { owners: [signer], modules: [nested], next: nested } } })).rejects.toThrow("A Safe has more modules than the runner reads.");
    await expect(list({ treasury, delegated: [treasury], safes: { [treasury]: { owners: [], modules: [nested], next: nested } } })).rejects.toThrow("A Safe has more modules than the runner reads.");
  });
});

type FakeRaffle = { phase: number; lots: bigint; cursor: bigint; snapshotted: boolean; revealed: boolean };
type FakeOptions = {
  privileged?: readonly Address[] | Error;
  balance?: bigint;
  pending?: number;
  prepareFails?: Set<string>;
  /** Changes to raffle 1's prepared call, so it differs from the step the runner chose. */
  prepareWrong?: Partial<PreparedAction>;
  read?: (id: bigint) => Promise<never> | undefined;
  /** Replaces the scan's read of one raffle, for example with one that fails, is slow or never returns. */
  scanRead?: (id: bigint, raffle: Raffle) => Promise<Raffle> | undefined;
  quote?: (action: RunnerAction) => Quote | Error | undefined;
  send?: (action: RunnerAction) => SendResult | undefined;
  wait?: "succeeded" | "reverted" | Error | "hang";
  onSend?: () => void;
  onNonces?: () => void;
};
const cheap: Quote = { gasLimit: 100_000n, maxFeePerGas: parseGwei("2"), maxPriorityFeePerGas: parseGwei("1") };
function fakeChain(raffles: Record<string, FakeRaffle>, options: FakeOptions = {}) {
  const sent: { id: string; action: RunnerAction["kind"]; nonce: number }[] = [];
  const attempts: string[] = [];
  const scanned: bigint[] = [];
  let nonce = 0;
  function current(id: bigint): RaffleSnapshot {
    const r = raffles[id.toString()];
    return { ...snapshot({ phase: r.phase, snapshotted: r.snapshotted, snapshotTotal: r.snapshotted ? r.lots : 0n, lotCursor: r.cursor, revealed: r.revealed, drawnAt: SALES_END }, { now: SALES_END + 1n, lotCount: r.lots }), id };
  }
  const chain: DrawChain = {
    runner, contract,
    async privilegedAddresses() { if (options.privileged instanceof Error) throw options.privileged; return options.privileged ?? [owner]; },
    scan(cursor, lowWater, limit, timeoutMs) {
      return scanRaffles({
        cursor, lowWater, nextId: BigInt(Object.keys(raffles).length + 1), limit, timeoutMs,
        async read(id) { scanned.push(id); return options.scanRead?.(id, current(id).raffle) ?? current(id).raffle; },
        keep: raffle => mayNeedRunner(raffle, { now: SALES_END + 1n, drawStartGrace: GRACE, revealGrace: GRACE }),
        final: finalPhase
      });
    },
    async read(id) {
      const override = options.read?.(id);
      if (override) return override;
      return current(id);
    },
    async prepare(action) {
      if (options.prepareFails?.has(action.id.toString())) throw new Error("execution reverted: BadPhase()");
      return prepared(action, action.id === 1n ? options.prepareWrong : {});
    },
    async balance() { return options.balance ?? parseEther("1"); },
    async nonces() { options.onNonces?.(); return { latest: nonce, pending: nonce + (options.pending ?? 0) }; },
    async quote(call) {
      const result = options.quote?.(call.action as RunnerAction) ?? cheap;
      if (result instanceof Error) throw result;
      return result;
    },
    async send(call, at) {
      const action = call.action as RunnerAction;
      attempts.push(`${action.id}:${action.kind}`);
      const override = options.send?.(action);
      if (override) return override;
      options.onSend?.();
      sent.push({ id: action.id.toString(), action: action.kind, nonce: at });
      nonce++;
      const r = raffles[action.id.toString()];
      if ((options.wait ?? "succeeded") === "succeeded") {
        if (action.kind === "close") r.phase = 2;
        if (action.kind === "snapshot") { r.cursor += 100n; if (r.cursor >= r.lots) r.snapshotted = true; }
        if (action.kind === "requestRandomness") r.phase = 3;
        if (action.kind === "settle") r.phase = 5;
      }
      return { kind: "sent", hash: pad(toHex(sent.length), { size: 32 }) };
    },
    async wait() {
      const wait = options.wait ?? "succeeded";
      if (wait === "hang") return new Promise<never>(() => {});
      if (wait instanceof Error) throw wait;
      return wait;
    }
  };
  return { chain, sent, attempts, scanned };
}
function open(lots = 2n): FakeRaffle { return { phase: 1, lots, cursor: 0n, snapshotted: false, revealed: false }; }
function closed(lots = 2n): FakeRaffle { return { phase: 2, lots, cursor: 0n, snapshotted: false, revealed: false }; }
function drawn(): FakeRaffle { return { phase: 4, lots: 2n, cursor: 2n, snapshotted: true, revealed: true }; }
function request() { return new Request("https://labx.example/api/cron/draw", { headers: { Authorization: `Bearer ${secret}` } }); }
// 200 s into a five-minute bucket, so a 56 s run ends inside it.
const START = 1_700_000_000_000;
async function call(chain: DrawChain, store: Store = new MemoryStore(), now: () => number = () => START) {
  const factory = vi.fn(async () => chain);
  const response = await createDrawCronHandler({ store: () => store, chain: factory, now })(request());
  return { response, body: await response.json(), factory };
}
const revert = () => new EstimateGasExecutionError(new ExecutionRevertedError({ message: "execution reverted: BadPhase()" }), {});
const outcomes = (body: { items: RunItem[] }) => body.items.map(item => `${item.id}:${item.action}:${item.outcome}:${item.error}`);

describe("draw runner cron handler", () => {
  let logged: MockInstance<typeof console.info>;
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", runnerKey);
    logged = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); logged.mockRestore(); vi.useRealTimers(); });

  it("requires the cron secret before reading the key or the chain", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const { chain } = fakeChain({ 1: open() });
    const missing = await call(chain);
    expect(missing.response.status).toBe(503); expect(missing.factory).not.toHaveBeenCalled();
    vi.stubEnv("CRON_SECRET", secret);
    const factory = vi.fn(async () => chain);
    for (const header of [undefined, `Bearer ${secret}x`, `Basic ${secret}`, secret, `Bearer ${secret.slice(0, -1)}`, "Bearer "]) {
      const response = await createDrawCronHandler({ store: () => new MemoryStore(), chain: factory })(new Request("https://labx.example/api/cron/draw", { headers: header ? { Authorization: header } : {} }));
      expect(response.status).toBe(401);
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("treats a cron secret shorter than 16 characters as not configured", async () => {
    const short = "0123456789abcde";
    vi.stubEnv("CRON_SECRET", short);
    const { chain, sent } = fakeChain({ 1: open() });
    const factory = vi.fn(async () => chain);
    const response = await createDrawCronHandler({ store: () => new MemoryStore(), chain: factory })(new Request("https://labx.example/api/cron/draw", { headers: { Authorization: `Bearer ${short}` } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "Draw runner cron is not configured." });
    expect(factory).not.toHaveBeenCalled(); expect(sent).toEqual([]);
    vi.stubEnv("CRON_SECRET", `${short}f`);
    const accepted = await createDrawCronHandler({ store: () => new MemoryStore(), chain: factory, now: () => START })(new Request("https://labx.example/api/cron/draw", { headers: { Authorization: `Bearer ${short}f` } }));
    expect(accepted.status).toBe(200);
  });

  it.each([["missing", ""], ["malformed", "0x1234"], ["zero", `0x${"00".repeat(32)}`]])("refuses with 503 and sends nothing when the key is %s", async (_, key) => {
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", key);
    const { chain, sent } = fakeChain({ 1: open() });
    const { response, body, factory } = await call(chain);
    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, error: "The draw runner key is missing or invalid." });
    expect(factory).not.toHaveBeenCalled(); expect(sent).toEqual([]);
  });

  it.each([["the contract owner", [runner]], ["the treasury", [owner, runner.toLowerCase() as Address]], ["a Safe signer", [owner, owner, "0x6666666666666666666666666666666666666666" as Address, runner]]])("refuses with 503 when the key belongs to %s", async (_, privileged) => {
    const store = new MemoryStore();
    const { chain, sent } = fakeChain({ 1: open() }, { privileged });
    const { response, body } = await call(chain, store);
    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, error: "The draw runner key must not belong to the LABx owner, a Safe signer or the treasury." });
    expect(sent).toEqual([]);
    expect(await store.get("draw-runner:cursor")).toBeNull();
  });

  it("refuses with 503 when the Safe signers cannot be read", async () => {
    const { chain, sent } = fakeChain({ 1: open() }, { privileged: new Error("getOwners reverted") });
    const { response, body } = await call(chain);
    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, error: "The draw runner could not check the deployment." });
    expect(sent).toEqual([]);
  });

  it("closes, counts in batches and starts the draw in one run, then finishes a confirmed draw", async () => {
    const raffles = { 1: open(250n), 2: drawn(), 3: { ...open(), phase: 6 } };
    const { chain, sent } = fakeChain(raffles);
    const { response, body } = await call(chain);
    expect(response.status).toBe(200);
    expect(sent.map(item => `${item.id}:${item.action}:${item.nonce}`)).toEqual(["1:close:0", "1:snapshot:1", "1:snapshot:2", "1:snapshot:3", "1:requestRandomness:4", "2:settle:5"]);
    expect(body).toMatchObject({ ok: true, status: "complete", runner, sends: 6, nextCursor: "1" });
    expect(body.items).toEqual(sent.map((item, index) => ({ id: item.id, action: item.action, hash: pad(toHex(index + 1), { size: 32 }), outcome: "succeeded", error: null })));
    expect(logged).toHaveBeenCalledWith("draw-runner", expect.objectContaining({ status: "complete", sends: 6, items: body.items }));
  });

  it("stops at six sends and resumes from the raffle it did not reach", async () => {
    const raffles = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index + 1), drawn()]));
    const store = new MemoryStore();
    const { chain, sent } = fakeChain(raffles);
    const first = await call(chain, store, () => START);
    expect(sent).toHaveLength(6);
    expect(first.body).toMatchObject({ ok: true, status: "send-cap", sends: 6, nextCursor: "7" });
    expect(await store.get("draw-runner:cursor")).toBe("7");
    const later = await call(chain, store, () => START + 300_000);
    expect(later.body).toMatchObject({ status: "complete", sends: 2 });
    expect(sent.map(item => item.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("lets only one of two overlapping runs send", async () => {
    const store = new MemoryStore();
    const raffles = { 1: open(), 2: open() };
    const { chain, sent } = fakeChain(raffles);
    const [left, right] = await Promise.all([call(chain, store), call(chain, store)]);
    expect([left.body.status, right.body.status].sort()).toEqual(["busy", "complete"]);
    expect(sent.filter(item => item.action === "close").map(item => item.id)).toEqual(["1", "2"]);
    const sameBucket = await call(fakeChain({ 1: open() }).chain, store, () => START + 90_000);
    expect(sameBucket.body).toMatchObject({ ok: true, status: "busy", sends: 0, items: [] });
    const nextSchedule = fakeChain({ 1: open() });
    expect((await call(nextSchedule.chain, store, () => START + 100_000)).body.status).toBe("complete");
    expect(nextSchedule.sent.map(item => item.action)).toEqual(["close", "snapshot", "requestRandomness"]);
  });

  it("stops sending with less than 25 seconds left in the run", async () => {
    let clock = START;
    const { chain, sent } = fakeChain({ 1: open(), 2: open() }, { onSend: () => { clock += 31_001; } });
    const { body } = await call(chain, new MemoryStore(), () => clock);
    expect(sent.map(item => `${item.id}:${item.action}`)).toEqual(["1:close"]);
    expect(body).toMatchObject({ ok: true, status: "deadline", sends: 1, nextCursor: "1" });
  });

  it("starts a send with exactly 25 seconds left and not with less", async () => {
    let clock = START;
    const enough = fakeChain({ 1: open() }, { onNonces: () => { clock = START + 31_000; } });
    expect((await call(enough.chain, new MemoryStore(), () => clock)).body).toMatchObject({ status: "complete", sends: 3 });
    clock = START;
    const short = fakeChain({ 1: open() }, { onNonces: () => { clock = START + 31_001; } });
    const { body } = await call(short.chain, new MemoryStore(), () => clock);
    expect(short.attempts).toEqual([]);
    expect(body).toMatchObject({ ok: true, status: "deadline", sends: 0, items: [], nextCursor: "1" });
  });

  it("reports, saves the cursor and logs before 56 seconds when a receipt never arrives", async () => {
    vi.useFakeTimers({ now: START });
    const store = new MemoryStore();
    const { chain } = fakeChain({ 1: open(), 2: open() }, { wait: "hang" });
    let finished = 0;
    const pending = call(chain, store, () => Date.now()).then(result => { finished = Date.now(); return result; });
    await vi.advanceTimersByTimeAsync(56_000);
    const { response, body } = await pending;
    expect(finished - START).toBeLessThan(56_000);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: "pending-transaction", sends: 1, nextCursor: "1" });
    expect(outcomes(body)).toEqual(["1:close:unknown:Timeout"]);
    expect(body.items[0].hash).toBe(pad(toHex(1), { size: 32 }));
    expect(await store.get("draw-runner:cursor")).toBe("1");
    expect(logged).toHaveBeenCalledWith("draw-runner", expect.objectContaining({ status: "pending-transaction" }));
  });

  it("reports before 56 seconds when a read never returns, and resumes after that raffle", async () => {
    vi.useFakeTimers({ now: START });
    const store = new MemoryStore();
    const { chain, sent } = fakeChain({ 1: open(), 2: open() }, { read: id => id === 1n ? new Promise<never>(() => {}) : undefined });
    let finished = 0;
    const pending = call(chain, store, () => Date.now()).then(result => { finished = Date.now(); return result; });
    await vi.advanceTimersByTimeAsync(56_000);
    const { body } = await pending;
    expect(finished - START).toBeLessThan(56_000);
    expect(body).toMatchObject({ ok: false, status: "interrupted", sends: 0, nextCursor: "2" });
    expect(sent).toEqual([]);
    expect(await store.get("draw-runner:cursor")).toBe("2");
  });

  it("refuses within the run when the privileged check never returns", async () => {
    vi.useFakeTimers({ now: START });
    const { chain, sent } = fakeChain({ 1: open() });
    chain.privilegedAddresses = () => new Promise<never>(() => {});
    let finished = 0;
    const pending = call(chain, new MemoryStore(), () => Date.now()).then(result => { finished = Date.now(); return result; });
    await vi.advanceTimersByTimeAsync(56_000);
    const { response, body } = await pending;
    expect(finished - START).toBeLessThan(56_000);
    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, error: "The draw runner could not check the deployment." });
    expect(sent).toEqual([]);
  });

  it("acts on the raffles read before a failed scan read, reports interrupted and resumes after that raffle", async () => {
    const store = new MemoryStore();
    const { chain, sent } = fakeChain({ 1: drawn(), 2: drawn(), 3: drawn(), 4: drawn() }, { scanRead: id => id === 3n ? Promise.reject(new Error("rpc failed")) : undefined });
    const { response, body } = await call(chain, store);
    expect(response.status).toBe(200);
    expect(outcomes(body)).toEqual(["1:settle:succeeded:null", "2:settle:succeeded:null"]);
    expect(body).toMatchObject({ ok: false, status: "interrupted", sends: 2, nextCursor: "4" });
    expect(sent.map(item => item.id)).toEqual(["1", "2"]);
    expect(await store.get("draw-runner:cursor")).toBe("4");
  });

  it("stops reading raffles after the scan time, acts on what it read and resumes at the first unread raffle", async () => {
    vi.useFakeTimers({ now: START });
    const store = new MemoryStore();
    const { chain, sent } = fakeChain({ 1: drawn(), 2: drawn(), 3: drawn(), 4: drawn() }, { scanRead: id => id === 3n ? new Promise<never>(() => {}) : undefined });
    let finished = 0;
    const pending = call(chain, store, () => Date.now()).then(result => { finished = Date.now(); return result; });
    await vi.advanceTimersByTimeAsync(56_000);
    const { body } = await pending;
    expect(finished - START).toBe(SCAN_MS);
    expect(outcomes(body)).toEqual(["1:settle:succeeded:null", "2:settle:succeeded:null"]);
    expect(body).toMatchObject({ ok: true, status: "deadline", sends: 2, nextCursor: "3" });
    expect(sent.map(item => item.id)).toEqual(["1", "2"]);
    expect(await store.get("draw-runner:cursor")).toBe("3");
  });

  it("ends the scan in time to send after a slow start", async () => {
    vi.useFakeTimers({ now: START });
    const memory = new MemoryStore();
    const store: Store = {
      get: key => memory.get(key), set: (key, value) => memory.set(key, value),
      setIfAbsent: entries => new Promise(done => setTimeout(() => done(memory.setIfAbsent(entries)), 12_000))
    };
    const raffles = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [String(index + 1), drawn()]));
    const { chain, sent } = fakeChain(raffles, { scanRead: (_, raffle) => new Promise(done => setTimeout(() => done(raffle), 2_000)) });
    const pending = call(chain, store, () => Date.now());
    await vi.advanceTimersByTimeAsync(56_000);
    const { body } = await pending;
    expect(sent.map(item => item.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(body).toMatchObject({ ok: true, status: "send-cap", sends: 6, nextCursor: "7" });
  });

  it("reports not ok when the scan runs out of time before the run reaches any raffle", async () => {
    vi.useFakeTimers({ now: START });
    const store = new MemoryStore();
    const { chain, sent } = fakeChain({ 1: drawn(), 2: drawn() }, { scanRead: (_, raffle) => new Promise(done => setTimeout(() => done(raffle), 30_000)) });
    const pending = call(chain, store, () => Date.now());
    await vi.advanceTimersByTimeAsync(56_000);
    const { response, body } = await pending;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: "deadline", sends: 0, items: [], nextCursor: "1" });
    expect(sent).toEqual([]);
    expect(await store.get("draw-runner:cursor")).toBe("1");
  });

  it("gives the scan a short floor after a very slow start, then reports not ok", async () => {
    vi.useFakeTimers({ now: START });
    const memory = new MemoryStore();
    const store: Store = {
      get: key => memory.get(key), set: (key, value) => memory.set(key, value),
      setIfAbsent: entries => new Promise(done => setTimeout(() => done(memory.setIfAbsent(entries)), 40_000))
    };
    const { chain, sent, scanned } = fakeChain({ 1: drawn(), 2: drawn() }, { scanRead: (_, raffle) => new Promise(done => setTimeout(() => done(raffle), 30_000)) });
    let finished = 0;
    const pending = call(chain, store, () => Date.now()).then(result => { finished = Date.now(); return result; });
    await vi.advanceTimersByTimeAsync(56_000);
    const { body } = await pending;
    expect(scanned).toEqual([1n, 2n]);
    expect(finished - START).toBe(40_000 + SCAN_FLOOR_MS);
    expect(body).toMatchObject({ ok: false, status: "deadline", sends: 0, items: [], nextCursor: "1" });
    expect(sent).toEqual([]);
  });

  it("reports low funds and sends nothing", async () => {
    const { chain, sent } = fakeChain({ 1: open() }, { balance: MIN_BALANCE - 1n });
    const scan = vi.spyOn(chain, "scan");
    const { response, body } = await call(chain);
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: false, status: "low-funds", runner, sends: 0, items: [], nextCursor: null });
    expect(sent).toEqual([]); expect(scan).not.toHaveBeenCalled();
  });

  it("leaves an unaffordable step, does cheaper work, and never lets that raffle block the queue", async () => {
    // Raffle 1 needs a snapshot the balance cannot cover. Raffles 2 to 9 need cheap settles.
    const raffles: Record<string, FakeRaffle> = { 1: closed(), ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index + 2), drawn()])) };
    const expensive: Quote = { gasLimit: 5_900_000n, maxFeePerGas: parseGwei("10"), maxPriorityFeePerGas: parseGwei("1") };
    const quote = (action: RunnerAction) => action.kind === "snapshot" ? expensive : undefined;
    const balance = parseEther("0.05");
    expect(requiredBalance(expensive)).toBeGreaterThan(balance);
    expect(requiredBalance(cheap)).toBeLessThan(balance);
    const store = new MemoryStore();
    const { chain, sent, attempts } = fakeChain(raffles, { quote, balance });
    const first = await call(chain, store, () => START);
    expect(outcomes(first.body)).toEqual(["1:snapshot:low-funds:null", ...["2", "3", "4", "5", "6", "7"].map(id => `${id}:settle:succeeded:null`)]);
    expect(first.body).toMatchObject({ ok: false, status: "send-cap", sends: 6, nextCursor: "8" });
    const second = await call(chain, store, () => START + 600_000);
    expect(outcomes(second.body)).toEqual(["8:settle:succeeded:null", "9:settle:succeeded:null", "1:snapshot:low-funds:null"]);
    expect(second.body).toMatchObject({ ok: false, status: "complete", sends: 2 });
    expect(attempts.filter(item => item.endsWith("snapshot"))).toEqual([]);
    expect(sent.map(item => item.id)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("requires the gas limit at the maximum fee plus a tenth", () => {
    expect(requiredBalance({ gasLimit: 100_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })).toBe(1_100_000n);
  });

  it.each([["close", open(), 400_000n], ["snapshot", closed(), 7_000_000n], ["settle", drawn(), 400_000n]] as const)("refuses a %s gas limit above its cap and sends the next raffle's step", async (kind, state, cap) => {
    expect(GAS_CAP[kind]).toBe(cap);
    const over = fakeChain({ 1: { ...state }, 2: drawn() }, { quote: action => action.id === 1n ? { ...cheap, gasLimit: cap + 1n } : undefined });
    const { body } = await call(over.chain);
    expect(outcomes(body)).toEqual([`1:${kind}:gas-cap:null`, "2:settle:succeeded:null"]);
    expect(body).toMatchObject({ ok: false, status: "complete", sends: 1 });
    expect(over.attempts).toEqual(["2:settle"]);
    const at = fakeChain({ 1: { ...state } }, { quote: () => ({ ...cheap, gasLimit: cap }) });
    expect((await call(at.chain)).body.items[0]).toMatchObject({ action: kind, outcome: "succeeded" });
  });
  it("caps requestRandomness at 400k gas", () => {
    expect(GAS_CAP.requestRandomness).toBe(400_000n);
  });

  it("stops without counting a send when gas is above the fee cap", async () => {
    const { chain, attempts } = fakeChain({ 1: open() }, { quote: () => ({ ...cheap, maxFeePerGas: MAX_FEE_PER_GAS + 1n }) });
    const { body } = await call(chain);
    expect(body).toMatchObject({ ok: false, status: "fee-cap", sends: 0, items: [], nextCursor: "1" });
    expect(attempts).toEqual([]);
  });

  it("waits for an earlier runner transaction instead of sending behind it", async () => {
    const { chain, sent } = fakeChain({ 1: open() }, { pending: 1 });
    const { body } = await call(chain);
    expect(body).toMatchObject({ ok: false, status: "pending-transaction", sends: 0, nextCursor: "1" });
    expect(sent).toEqual([]);
  });

  it("skips a step another caller already took and moves on", async () => {
    const { chain, sent } = fakeChain({ 1: open(), 2: open() }, { prepareFails: new Set(["1"]) });
    const { body } = await call(chain);
    expect(body.items[0]).toEqual({ id: "1", action: "close", hash: null, outcome: "skipped", error: null });
    expect(sent.map(item => item.id)).toEqual(["2", "2", "2"]);
    expect(body).toMatchObject({ ok: true, status: "complete", sends: 3 });
  });

  it.each([
    ["to another contract", { to: seller }],
    ["with a nonzero value", { value: 1n }],
    ["to another function", { data: encodeFunctionData({ abi: raffleAbi, functionName: "cancel", args: [1n] }) }],
    ["with data that is not a raffle call", { data: "0xdeadbeef" as Hex }]
  ])("reports a prepared call %s as failed and refused, sends nothing for it and goes on", async (_, prepareWrong) => {
    const { chain, attempts } = fakeChain({ 1: open(), 2: drawn() }, { prepareWrong });
    const { body } = await call(chain);
    expect(outcomes(body)).toEqual(["1:close:failed:Refused", "2:settle:succeeded:null"]);
    expect(body).toMatchObject({ ok: false, status: "complete", sends: 1 });
    expect(attempts).toEqual(["2:settle"]);
  });

  it("runs with a key pasted without the 0x prefix", async () => {
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", runnerKey.slice(2));
    const { chain, sent } = fakeChain({ 1: drawn() });
    const { response, body, factory } = await call(chain);
    expect(response.status).toBe(200);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ address: runner }));
    expect(body).toMatchObject({ ok: true, status: "complete", runner, sends: 1 });
    expect(sent.map(item => item.action)).toEqual(["settle"]);
  });

  it("skips without counting a step another caller took after the pinned simulation, and goes on to the next raffle", async () => {
    const { chain, sent, attempts } = fakeChain({ 1: open(), 2: drawn() }, { quote: action => action.id === 1n ? revert() : undefined });
    const { body } = await call(chain);
    expect(outcomes(body)).toEqual(["1:close:skipped:EstimateGasRevert", "2:settle:succeeded:null"]);
    expect(body).toMatchObject({ ok: true, status: "complete", sends: 1, nextCursor: "1" });
    expect(attempts).toEqual(["2:settle"]); expect(sent).toHaveLength(1);
  });

  it("reports an estimate that the node refuses for funds as low funds and goes on", async () => {
    const { chain, attempts } = fakeChain({ 1: closed(), 2: drawn() }, { quote: action => action.id === 1n ? new EstimateGasExecutionError(new InsufficientFundsError(), {}) : undefined });
    const { body } = await call(chain);
    expect(outcomes(body)).toEqual(["1:snapshot:low-funds:InsufficientFunds", "2:settle:succeeded:null"]);
    expect(attempts).toEqual(["2:settle"]);
  });

  it("stops after an estimate that fails for another reason and resumes after that raffle", async () => {
    const { chain, attempts } = fakeChain({ 1: open(), 2: open(), 3: open() }, { quote: action => action.id === 2n ? new HttpRequestError({ url: "https://rpc.example" }) : undefined });
    const { body } = await call(chain);
    expect(outcomes(body)).toEqual(["1:close:succeeded:null", "1:snapshot:succeeded:null", "1:requestRandomness:succeeded:null", "2:close:failed:Rpc"]);
    expect(body).toMatchObject({ ok: false, status: "interrupted", sends: 3, nextCursor: "3" });
    expect(attempts).not.toContain("2:close");
  });

  it("reports a reverted send and does not retry it in the same run", async () => {
    const { chain, sent } = fakeChain({ 1: open(), 2: open() }, { wait: "reverted" });
    const { body } = await call(chain);
    expect(sent.map(item => `${item.id}:${item.action}`)).toEqual(["1:close", "2:close"]);
    expect(body).toMatchObject({ ok: false, status: "complete", sends: 2 });
    expect(outcomes(body)).toEqual(["1:close:reverted:null", "2:close:reverted:null"]);
  });

  it("does not count a send the node refused, and resumes after that raffle", async () => {
    const { chain } = fakeChain({ 1: open(), 2: open(), 3: open() }, { send: action => action.id === 2n ? { kind: "refused", error: "Rpc" } : undefined });
    const { body } = await call(chain);
    expect(outcomes(body).slice(3)).toEqual(["2:close:failed:Rpc"]);
    expect(body.items[3].hash).toBeNull();
    expect(body).toMatchObject({ ok: false, status: "send-failed", sends: 3, nextCursor: "3" });
  });

  it("treats a send the node refused for funds as low funds and goes on to the next raffle", async () => {
    const { chain, sent } = fakeChain({ 1: open(), 2: drawn() }, { send: action => action.id === 1n ? { kind: "refused", error: "InsufficientFunds" } : undefined });
    const { body } = await call(chain);
    expect(outcomes(body)).toEqual(["1:close:low-funds:InsufficientFunds", "2:settle:succeeded:null"]);
    expect(body).toMatchObject({ ok: false, status: "complete", sends: 1 });
    expect(sent.map(item => item.id)).toEqual(["2"]);
  });

  it.each([["NonceTooLow"], ["Timeout"], ["Rpc"]] as const)("reports %s after signing as unknown with its hash and stops behind it", async error => {
    const hash = pad("0xabc", { size: 32 });
    const { chain } = fakeChain({ 1: open(), 2: open() }, { send: () => ({ kind: "unknown", hash, error }) });
    const { body } = await call(chain);
    expect(body).toMatchObject({ ok: false, status: "pending-transaction", sends: 1, nextCursor: "1" });
    expect(body.items).toEqual([{ id: "1", action: "close", hash, outcome: "unknown", error }]);
  });

  it("reports a receipt wait that fails as unknown", async () => {
    const { chain } = fakeChain({ 1: open() }, { wait: new WaitForTransactionReceiptTimeoutError({ hash: zeroHash }) });
    const { body } = await call(chain);
    expect(outcomes(body)).toEqual(["1:close:unknown:Timeout"]);
    expect(body).toMatchObject({ ok: false, status: "pending-transaction", sends: 1 });
  });

  it("never puts the key or the cron secret in a response, a log or the store", async () => {
    const written: string[] = [];
    const memory = new MemoryStore();
    const store: Store = {
      get: key => memory.get(key),
      async set(key, value) { written.push(key, value); return memory.set(key, value); },
      async setIfAbsent(entries) { written.push(...Object.entries(entries).flat()); return memory.setIfAbsent(entries); }
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const outputs: string[] = [];
    const scenarios: FakeOptions[] = [{}, { send: () => ({ kind: "refused", error: "Rpc" }) }, { wait: new Error(runnerKey) }, { quote: () => new Error(runnerKey) }, { privileged: [runner] }, { privileged: new Error(runnerKey) }];
    for (const options of scenarios) {
      const { chain } = fakeChain({ 1: open(), 2: drawn() }, options);
      const { body } = await call(chain, store, () => START + outputs.length * 600_000);
      outputs.push(JSON.stringify(body));
    }
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", runnerKey.slice(0, 40));
    outputs.push(JSON.stringify((await call(fakeChain({ 1: open() }).chain, store)).body));
    expect(outputs.some(output => output.includes('"status":"send-failed"'))).toBe(true);
    expect(outputs.some(output => output.includes('"status":"pending-transaction"'))).toBe(true);
    const everything = [...outputs, ...written, ...logged.mock.calls.map(args => JSON.stringify(args)), ...errors.mock.calls.map(args => String(args))].join("\n").toLowerCase();
    expect(everything).not.toContain(runnerKey.slice(2).toLowerCase());
    expect(everything).not.toContain(runnerKey.slice(2, 34).toLowerCase());
    expect(everything).not.toContain(secret.toLowerCase());
    errors.mockRestore();
  });
});

describe("draw runner scan cadence", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", runnerKey);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("reads every one of 1,000 raffles and acts on a given non-terminal raffle within two runs", async () => {
    // Drafts, draws waiting for randomness, settled and cancelled raffles need nothing. One drawn raffle needs a settle.
    const idle = [0, 3, 5, 6];
    for (const target of [1, 2, 499, 500, 501, 999, 1000]) {
      for (const start of ["1", "2", "500", "501", "1000"]) {
        const raffles: Record<string, FakeRaffle> = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [String(index + 1), index + 1 === target ? drawn() : { ...drawn(), phase: idle[index % 4] }]));
        const store = new MemoryStore();
        await store.set("draw-runner:cursor", start);
        const { chain, sent, scanned } = fakeChain(raffles);
        for (const at of [START, START + LEASE_BUCKET_MS]) {
          const before = scanned.length;
          const { body } = await call(chain, store, () => at);
          expect(body).toMatchObject({ ok: true, status: "complete" });
          expect(scanned.length - before).toBeLessThanOrEqual(SCAN_LIMIT);
        }
        expect(sent.map(item => `${item.id}:${item.action}`)).toEqual([`${target}:settle`]);
        expect(new Set(scanned).size).toBe(1000);
      }
    }
  });
});

describe("draw runner low-water mark across runs", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", runnerKey);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const at = (phase: number): FakeRaffle => ({ ...drawn(), phase });
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => BigInt(from + index));
  const mark = (id: number) => `${contract.toLowerCase()}:${id}`;

  it("does not read settled or cancelled raffles below the low-water mark again", async () => {
    // Raffle 6 needs a settle and raffle 9 is a draft. The rest are settled or cancelled.
    const raffles = { 1: at(5), 2: at(6), 3: at(5), 4: at(6), 5: at(5), 6: drawn(), 7: at(6), 8: at(5), 9: at(0), 10: at(5) };
    const store = new MemoryStore();
    const { chain, sent, scanned } = fakeChain(raffles);
    expect((await call(chain, store, () => START)).body).toMatchObject({ ok: true, status: "complete", sends: 1 });
    expect(scanned).toEqual(range(1, 10));
    expect(sent.map(item => `${item.id}:${item.action}`)).toEqual(["6:settle"]);
    expect(await store.get("draw-runner:low-water")).toBe(mark(6));

    scanned.length = 0;
    expect((await call(chain, store, () => START + 600_000)).body).toMatchObject({ ok: true, status: "complete", sends: 0 });
    expect(scanned).toEqual(range(6, 10));
    expect(await store.get("draw-runner:low-water")).toBe(mark(9));

    scanned.length = 0;
    expect((await call(chain, store, () => START + 1_200_000)).body).toMatchObject({ ok: true, status: "complete", sends: 0 });
    expect(scanned).toEqual(range(9, 10));
    expect(await store.get("draw-runner:low-water")).toBe(mark(9));
  });

  it("ignores a low-water mark saved for another contract or in another form", async () => {
    for (const saved of ["0x9999999999999999999999999999999999999999:6", "6", `${contract.toLowerCase()}:0`, `${contract.toLowerCase()}:x`]) {
      const store = new MemoryStore();
      await store.set("draw-runner:low-water", saved);
      const { chain, scanned } = fakeChain({ 1: at(5), 2: at(5), 3: at(5), 4: at(5), 5: at(5), 6: at(0) });
      await call(chain, store, () => START);
      expect(scanned).toEqual(range(1, 6));
      expect(await store.get("draw-runner:low-water")).toBe(mark(6));
    }
  });
});

describe("draw runner lease", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", runnerKey);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const BUCKET = LEASE_BUCKET_MS, edge = Math.ceil(START / BUCKET) * BUCKET;
  const intersect = (left: string[], right: string[]) => left.some(key => right.includes(key));

  it("writes one row for a run that starts on schedule", () => {
    for (const delay of [0, 1_000, 30_000, BUCKET - RUN_MS - 1]) expect(leaseKeys(edge + delay, edge + delay + RUN_MS)).toEqual([`draw-runner:lease:5m:${edge / BUCKET}`]);
  });

  it("holds the next bucket too when the run may cross into it", () => {
    expect(leaseKeys(edge - RUN_MS, edge)).toEqual([`draw-runner:lease:5m:${edge / BUCKET - 1}`, `draw-runner:lease:5m:${edge / BUCKET}`]);
    expect(leaseKeys(edge - 1, edge - 1 + RUN_MS)).toHaveLength(2);
  });

  it("gives every pair of overlapping runs around a bucket boundary a shared key", () => {
    const starts = Array.from({ length: 2 * (RUN_MS + 2_000) / 250 + 1 }, (_, index) => edge - RUN_MS - 2_000 + index * 250);
    let overlapping = 0;
    for (const left of starts) {
      for (const right of starts) {
        if (right < left || right > left + RUN_MS) continue;
        overlapping++;
        expect(intersect(leaseKeys(left, left + RUN_MS), leaseKeys(right, right + RUN_MS))).toBe(true);
      }
    }
    expect(overlapping).toBeGreaterThan(10_000);
  });

  it("lets only one of two runs straddling a boundary send", async () => {
    for (const [left, right] of [[edge - 1, edge], [edge - 30_000, edge + 25_000], [edge - RUN_MS, edge]]) {
      const store = new MemoryStore();
      expect((await call(fakeChain({ 1: drawn() }).chain, store, () => left)).body.status).toBe("complete");
      const second = fakeChain({ 1: drawn() });
      expect((await call(second.chain, store, () => right)).body.status).toBe("busy");
      expect(second.attempts).toEqual([]);
    }
  });

  it("writes one lease row per scheduled run across a day", async () => {
    const keys = new Set<string>();
    const memory = new MemoryStore();
    const store: Store = { get: key => memory.get(key), set: (key, value) => memory.set(key, value), async setIfAbsent(entries) { Object.keys(entries).forEach(key => keys.add(key)); return memory.setIfAbsent(entries); } };
    const runs = 288;
    for (let index = 0; index < runs; index++) {
      const { body } = await call(fakeChain({ 1: drawn() }).chain, store, () => edge + index * BUCKET + (index % 7) * 1_000);
      expect(body.status).toBe("complete");
    }
    expect(keys.size).toBe(runs);
  });
});

describe("draw runner chain errors", () => {
  const manifest = {
    chainId: 31337 as const, version: 3 as const, address: contract, usdc: seller, runtimeCodeHash: zeroHash, deploymentBlock: 0n,
    expectedOwner: owner, expectedPolicy: snapshot().policy
  };
  type Answer = { result: unknown } | { error: { code: number; message: string } } | "hang" | "network";
  function rpcChain(answer: (method: string) => Answer) {
    const fetchFn = vi.fn(async (_: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      const reply = answer(body.method);
      if (reply === "hang") return new Promise<Response>(() => {});
      if (reply === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...reply }), { headers: { "Content-Type": "application/json" } });
    });
    const client = createPublicClient({ transport: http("http://127.0.0.1:1/rpc", { fetchFn: fetchFn as typeof fetch, retryCount: 0, timeout: 60_000 }), pollingInterval: 10 });
    const account = runnerAccount(runnerKey)!;
    return createDrawChain({ client, manifest, account });
  }
  const call = prepared({ kind: "close", id: 7n });
  const sendWith = (answer: Answer, timeoutMs = 1_000) => rpcChain(method => method === "eth_sendRawTransaction" ? answer : { result: "0x1" }).send(call, 0, cheap, timeoutMs);

  it("returns the hash when the node accepts the transaction", async () => {
    const result = await sendWith({ result: zeroHash });
    expect(result).toMatchObject({ kind: "sent" });
  });
  it.each([
    ["nonce too low", { error: { code: -32000, message: "nonce too low" } }, "NonceTooLow"],
    ["already known", { error: { code: -32000, message: "already known" } }, "NonceTooLow"],
    ["a dropped connection", "network", "Rpc"],
    ["an internal node error", { error: { code: -32603, message: "internal error" } }, "Rpc"],
    ["a replacement the node does not explain", { error: { code: -32000, message: "replacement transaction underpriced" } }, "Rpc"],
    ["no answer in time", "hang", "Timeout"]
  ] as const)("reports %s as unknown with the signed hash", async (_, answer, error) => {
    const result = await sendWith(answer, 50);
    expect(result).toEqual({ kind: "unknown", hash: expect.stringMatching(/^0x[0-9a-f]{64}$/), error });
  });
  it.each([
    ["insufficient funds", { error: { code: -32000, message: "insufficient funds for gas * price + value" } }, "InsufficientFunds"],
    ["a fee below the base fee", { error: { code: -32000, message: "max fee per gas less than block base fee" } }, "Rpc"],
    ["intrinsic gas too low", { error: { code: -32000, message: "intrinsic gas too low" } }, "Rpc"]
  ] as const)("reports %s as refused with no hash", async (_, answer, error) => {
    expect(await sendWith(answer)).toEqual({ kind: "refused", error });
  });
  it("labels an estimate that reverts, and one that cannot reach the node", async () => {
    const reverting = rpcChain(method => method === "eth_estimateGas" ? { error: { code: 3, message: "execution reverted: BadPhase()" } } : { result: "0x1" });
    expect(errorCategory(await reverting.quote(call).catch(error => error))).toBe("EstimateGasRevert");
    const unreachable = rpcChain(() => "network");
    expect(errorCategory(await unreachable.quote(call).catch(error => error))).toBe("Rpc");
  });
  it("throws a timeout when no receipt arrives", async () => {
    const waiting = rpcChain(method => method === "eth_blockNumber" ? { result: "0x1" } : { result: null });
    expect(errorCategory(await waiting.wait(zeroHash, 50).catch(error => error))).toBe("Timeout");
  });
  it.each([
    ["the runner's own timeout", new RunnerTimeoutError(), "Timeout"],
    ["a transport timeout", new TimeoutError({ body: {}, url: "https://rpc.example" }), "Timeout"],
    ["a receipt timeout", new WaitForTransactionReceiptTimeoutError({ hash: zeroHash }), "Timeout"],
    ["an estimate revert", revert(), "EstimateGasRevert"],
    ["a simulation revert", new ExecutionRevertedError(), "Other"],
    ["a plain error", new Error("execution reverted"), "Other"],
    ["a thrown string", "boom", "Other"]
  ] as const)("labels %s", (_, error, category) => {
    expect(errorCategory(error)).toBe(category);
  });
  it("keeps the label free of messages and request bodies", async () => {
    const result = await sendWith({ error: { code: -32000, message: `insufficient funds ${runnerKey}` } });
    expect(JSON.stringify(result)).toBe('{"kind":"refused","error":"InsufficientFunds"}');
  });
});

describe("draw runner chain scan", () => {
  afterEach(() => { vi.useRealTimers(); });
  const code: Hex = "0x6080";
  const manifest = {
    chainId: 31337 as const, version: 3 as const, address: contract, usdc: seller, runtimeCodeHash: keccak256(code), deploymentBlock: 0n,
    expectedOwner: owner, expectedPolicy: snapshot().policy
  };
  const block = { number: "0x10", hash: pad("0x10", { size: 32 }), parentHash: zeroHash, timestamp: toHex(SALES_END + 1n), transactions: [] };
  /** A fake node behind a real viem client that answers the deployment check, the raffle count and one getRaffle per id. */
  function scanChain(phases: readonly number[], delays: { firstBlockMs: number; readMs: number }) {
    let blocks = 0;
    const fetchFn = async (_: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: readonly unknown[] };
      let result: unknown;
      let wait = 0;
      if (body.method === "eth_chainId") result = "0x7a69";
      else if (body.method === "eth_getBlockByNumber") { result = block; if (blocks++ === 0) wait = delays.firstBlockMs; }
      else if (body.method === "eth_getCode") result = code;
      else if (body.method === "eth_call") {
        const call = decodeFunctionData({ abi: raffleAbi, data: (body.params[0] as { data: Hex }).data });
        const value = call.functionName === "contractVersion" ? 3n
          : call.functionName === "usdc" ? seller
          : call.functionName === "nextId" ? BigInt(phases.length + 1)
          : call.functionName === "getRaffle" ? { ...snapshot().raffle, phase: phases[Number(call.args[0]) - 1] }
          : GRACE;
        if (call.functionName === "getRaffle") wait = delays.readMs;
        result = encodeFunctionResult({ abi: raffleAbi, functionName: call.functionName, result: value } as never);
      } else throw new Error(`Unexpected ${body.method}.`);
      if (wait) await new Promise(done => setTimeout(done, wait));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    };
    const client = createPublicClient({ transport: http("http://127.0.0.1:1/rpc", { fetchFn: fetchFn as typeof fetch, retryCount: 0, timeout: 60_000 }), cacheTime: 0 });
    return createDrawChain({ client, manifest, account: runnerAccount(runnerKey)! });
  }

  it("counts the block and count reads before the raffle reads toward the scan time", async () => {
    vi.useFakeTimers({ now: START });
    const chain = scanChain(Array.from({ length: 200 }, () => 4), { firstBlockMs: 6_000, readMs: 1_000 });
    let result: ScanResult | undefined;
    void chain.scan(1n, 1n, SCAN_LIMIT, 10_500).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(10_500);
    // Six seconds of block reads leave four and a half seconds: four rounds of raffle reads.
    expect(result).toEqual({ candidates: Array.from({ length: 4 * SCAN_CONCURRENCY }, (_, index) => BigInt(index + 1)), nextCursor: BigInt(4 * SCAN_CONCURRENCY + 1), lowWater: 1n, stop: "deadline" });
  });

  it("moves the low-water mark over raffles settled or cancelled at the pinned block", async () => {
    const chain = scanChain([5, 6, 5, 4, 5], { firstBlockMs: 0, readMs: 0 });
    expect(await chain.scan(2n, 1n, SCAN_LIMIT, 10_000)).toEqual({ candidates: [4n], nextCursor: 2n, lowWater: 4n, stop: null });
  });
});

describe("bounded waits", () => {
  it("rejects with the runner timeout and settles with the work otherwise", async () => {
    await expect(within(new Promise(() => {}), 10)).rejects.toBeInstanceOf(RunnerTimeoutError);
    await expect(within(Promise.resolve(3), 10)).resolves.toBe(3);
    await expect(within(Promise.resolve(3), 0)).rejects.toBeInstanceOf(RunnerTimeoutError);
    await expect(within(Promise.reject(new Error("late")), -1)).rejects.toBeInstanceOf(RunnerTimeoutError);
  });
});
