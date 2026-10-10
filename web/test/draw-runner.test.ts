import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { encodeFunctionData, pad, parseEther, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { raffleAbi } from "../lib/chain/abi";
import type { PreparedAction, Raffle, RaffleSnapshot } from "../lib/chain/types";
import { MemoryStore } from "../lib/store";
import type { Store } from "../lib/points";
import { assertRunnerCall, mayNeedRunner, nextRunnerAction, scanWindow, type RunnerAction } from "../lib/draw-runner/decide";
import { privilegedAddresses } from "../lib/draw-runner/chain";
import { createDrawCronHandler, runnerAccount } from "../lib/draw-runner/http";
import { MIN_BALANCE, type DrawChain, type SendResult } from "../lib/draw-runner/run";

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
    expect(scanWindow(1n, 1n, 50)).toEqual({ ids: [], nextCursor: 1n });
    expect(scanWindow(1n, 4n, 50)).toEqual({ ids: [1n, 2n, 3n], nextCursor: 1n });
    expect(scanWindow(2n, 4n, 50)).toEqual({ ids: [2n, 3n, 1n], nextCursor: 2n });
  });
  it("resumes from the cursor and wraps past the newest raffle", () => {
    const first = scanWindow(1n, 121n, 50);
    expect(first.ids[0]).toBe(1n); expect(first.ids.at(-1)).toBe(50n); expect(first.nextCursor).toBe(51n);
    const third = scanWindow(101n, 121n, 50);
    expect(third.ids.slice(0, 2)).toEqual([101n, 102n]); expect(third.ids.slice(19, 21)).toEqual([120n, 1n]);
    expect(third.ids).toHaveLength(50); expect(third.nextCursor).toBe(31n);
  });
  it("restarts at the first raffle when the saved cursor is out of range", () => {
    expect(scanWindow(0n, 4n, 2)).toEqual({ ids: [1n, 2n], nextCursor: 3n });
    expect(scanWindow(99n, 4n, 2)).toEqual({ ids: [1n, 2n], nextCursor: 3n });
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
    ["missing", undefined], ["empty", ""], ["without 0x", runnerKey.slice(2)], ["short", runnerKey.slice(0, 64)],
    ["with whitespace", `${runnerKey} `], ["not hex", `0x${"zz".repeat(32)}`], ["zero", `0x${"00".repeat(32)}`],
    ["above the curve order", `0x${"ff".repeat(32)}`]
  ])("rejects a %s key", (_, value) => {
    expect(runnerAccount(value)).toBeNull();
  });
  it("derives the runner address from a valid key", () => {
    expect(runnerAccount(runnerKey)?.address).toBe(runner);
  });
});

describe("privileged address discovery", () => {
  const manifest = {
    chainId: 31337 as const, version: 3 as const, address: contract, usdc: seller, runtimeCodeHash: zeroHash, deploymentBlock: 0n,
    expectedOwner: owner, expectedPolicy: snapshot().policy
  };
  const treasury: Address = "0x4444444444444444444444444444444444444444";
  const signer: Address = "0x6666666666666666666666666666666666666666";
  function client(code: Hex | undefined, getOwners: () => Promise<readonly Address[]>) {
    return {
      getCode: vi.fn(async () => code),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => functionName === "owner" ? owner : functionName === "treasury" ? treasury : getOwners())
    } as unknown as Parameters<typeof privilegedAddresses>[0];
  }
  it("lists the owner and treasuries without a Safe call when the owner is a wallet", async () => {
    const getOwners = vi.fn(async () => [signer]);
    await expect(privilegedAddresses(client(undefined, getOwners), manifest, 1n)).resolves.toEqual([owner, owner, treasury, owner]);
    expect(getOwners).not.toHaveBeenCalled();
  });
  it("adds every Safe signer when the owner is a contract", async () => {
    await expect(privilegedAddresses(client("0x6080", async () => [signer, runner]), manifest, 1n)).resolves.toEqual([owner, owner, treasury, owner, signer, runner]);
  });
  it("fails when the Safe signer list cannot be read", async () => {
    await expect(privilegedAddresses(client("0x6080", async () => { throw new Error("execution reverted"); }), manifest, 1n)).rejects.toThrow();
  });
});

type FakeRaffle = { phase: number; lots: bigint; cursor: bigint; snapshotted: boolean; revealed: boolean };
function fakeChain(raffles: Record<string, FakeRaffle>, options: { privileged?: readonly Address[] | Error; balance?: bigint; pending?: number; prepareFails?: Set<string>; send?: (call: { action: RunnerAction }) => SendResult | undefined; outcome?: "succeeded" | "reverted" | "pending"; onSend?: () => void } = {}) {
  const sent: { id: string; action: RunnerAction["kind"]; nonce: number }[] = [];
  let nonce = 0;
  const chain: DrawChain = {
    runner, contract,
    async privilegedAddresses() { if (options.privileged instanceof Error) throw options.privileged; return options.privileged ?? [owner]; },
    async scan(cursor, limit) {
      const ids = Object.keys(raffles).map(BigInt);
      const window = scanWindow(cursor, BigInt(ids.length + 1), limit);
      return { candidates: window.ids.filter(id => [1, 2, 4].includes(raffles[id.toString()].phase)), nextCursor: window.nextCursor };
    },
    async read(id) {
      const r = raffles[id.toString()];
      return { ...snapshot({ phase: r.phase, snapshotted: r.snapshotted, snapshotTotal: r.snapshotted ? r.lots : 0n, lotCursor: r.cursor, revealed: r.revealed, drawnAt: SALES_END }, { now: SALES_END + 1n, lotCount: r.lots }), id };
    },
    async prepare(action) {
      if (options.prepareFails?.has(action.id.toString())) throw new Error("execution reverted: BadPhase()");
      return prepared(action);
    },
    async balance() { return options.balance ?? parseEther("1"); },
    async nonces() { return { latest: nonce, pending: nonce + (options.pending ?? 0) }; },
    async send(call, at) {
      const action = call.action as RunnerAction;
      const override = options.send?.({ action });
      if (override) return override;
      options.onSend?.();
      sent.push({ id: action.id.toString(), action: action.kind, nonce: at });
      nonce++;
      const r = raffles[action.id.toString()];
      if ((options.outcome ?? "succeeded") === "succeeded") {
        if (action.kind === "close") r.phase = 2;
        if (action.kind === "snapshot") { r.cursor += 100n; if (r.cursor >= r.lots) r.snapshotted = true; }
        if (action.kind === "requestRandomness") r.phase = 3;
        if (action.kind === "settle") r.phase = 5;
      }
      return { kind: "sent", hash: pad(toHex(sent.length), { size: 32 }) };
    },
    async wait() { return options.outcome ?? "succeeded"; }
  };
  return { chain, sent };
}
function open(lots = 2n): FakeRaffle { return { phase: 1, lots, cursor: 0n, snapshotted: false, revealed: false }; }
function request() { return new Request("https://labx.example/api/cron/draw", { headers: { Authorization: `Bearer ${secret}` } }); }
async function call(chain: DrawChain, store: Store = new MemoryStore(), now: () => number = () => 1_700_000_000_000) {
  const factory = vi.fn(async () => chain);
  const response = await createDrawCronHandler({ store: () => store, chain: factory, now })(request());
  return { response, body: await response.json(), factory };
}

describe("draw runner cron handler", () => {
  let logged: MockInstance<typeof console.info>;
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", runnerKey);
    logged = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); logged.mockRestore(); });

  it("requires the cron secret before reading the key or the chain", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const { chain } = fakeChain({ 1: open() });
    const missing = await call(chain);
    expect(missing.response.status).toBe(503); expect(missing.factory).not.toHaveBeenCalled();
    vi.stubEnv("CRON_SECRET", secret);
    const factory = vi.fn(async () => chain);
    for (const header of [undefined, `Bearer ${secret}x`, `Basic ${secret}`, secret]) {
      const response = await createDrawCronHandler({ store: () => new MemoryStore(), chain: factory })(new Request("https://labx.example/api/cron/draw", { headers: header ? { Authorization: header } : {} }));
      expect(response.status).toBe(401);
    }
    expect(factory).not.toHaveBeenCalled();
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
    const raffles = { 1: open(250n), 2: { phase: 4, lots: 2n, cursor: 2n, snapshotted: true, revealed: true }, 3: { ...open(), phase: 6 } };
    const { chain, sent } = fakeChain(raffles);
    const { response, body } = await call(chain);
    expect(response.status).toBe(200);
    expect(sent.map(item => `${item.id}:${item.action}:${item.nonce}`)).toEqual(["1:close:0", "1:snapshot:1", "1:snapshot:2", "1:snapshot:3", "1:requestRandomness:4", "2:settle:5"]);
    expect(body).toMatchObject({ ok: true, status: "complete", runner, sends: 6, nextCursor: "1" });
    expect(body.items).toEqual(sent.map((item, index) => ({ id: item.id, action: item.action, hash: pad(toHex(index + 1), { size: 32 }), outcome: "succeeded" })));
    expect(logged).toHaveBeenCalledWith("draw-runner", expect.objectContaining({ status: "complete", sends: 6, items: body.items }));
  });

  it("stops at six sends and resumes from the raffle it did not reach", async () => {
    const raffles = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index + 1), { ...open(), phase: 4, revealed: true, snapshotted: true }]));
    const store = new MemoryStore();
    const { chain, sent } = fakeChain(raffles);
    const first = await call(chain, store, () => 1_700_000_000_000);
    expect(sent).toHaveLength(6);
    expect(first.body).toMatchObject({ ok: true, status: "send-cap", sends: 6, nextCursor: "7" });
    expect(await store.get("draw-runner:cursor")).toBe("7");
    const later = await call(chain, store, () => 1_700_000_300_000);
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
    const nextMinute = await call(fakeChain({ 1: open() }).chain, store, () => 1_700_000_000_000 + 60_000);
    expect(nextMinute.body).toMatchObject({ ok: true, status: "busy", sends: 0, items: [] });
    const twoMinutesLater = fakeChain({ 1: open() });
    expect((await call(twoMinutesLater.chain, store, () => 1_700_000_000_000 + 120_000)).body.status).toBe("complete");
    expect(twoMinutesLater.sent.map(item => item.action)).toEqual(["close", "snapshot", "requestRandomness"]);
  });

  it("stops sending at the internal deadline", async () => {
    let clock = 1_700_000_000_000;
    const { chain, sent } = fakeChain({ 1: open(), 2: open() }, { onSend: () => { clock += 57_000; } });
    const { body } = await call(chain, new MemoryStore(), () => clock);
    expect(sent.map(item => `${item.id}:${item.action}`)).toEqual(["1:close"]);
    expect(body).toMatchObject({ ok: true, status: "deadline", sends: 1, nextCursor: "1" });
  });

  it("reports low funds and sends nothing", async () => {
    const { chain, sent } = fakeChain({ 1: open() }, { balance: MIN_BALANCE - 1n });
    const scan = vi.spyOn(chain, "scan");
    const { response, body } = await call(chain);
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: false, status: "low-funds", runner, sends: 0, items: [], nextCursor: null });
    expect(sent).toEqual([]); expect(scan).not.toHaveBeenCalled();
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
    expect(body.items[0]).toEqual({ id: "1", action: "close", hash: null, outcome: "skipped" });
    expect(sent.map(item => item.id)).toEqual(["2", "2", "2"]);
    expect(body).toMatchObject({ ok: true, status: "complete", sends: 3 });
  });

  it("reports a reverted send and does not retry it in the same run", async () => {
    const { chain, sent } = fakeChain({ 1: open(), 2: open() }, { outcome: "reverted" });
    const { body } = await call(chain);
    expect(sent.map(item => `${item.id}:${item.action}`)).toEqual(["1:close", "2:close"]);
    expect(body).toMatchObject({ ok: false, status: "complete", sends: 2 });
    expect(body.items.map((item: { outcome: string }) => item.outcome)).toEqual(["reverted", "reverted"]);
  });

  it("stops without counting a send when gas is above the fee cap", async () => {
    const { chain } = fakeChain({ 1: open() }, { send: () => ({ kind: "fee-cap" }) });
    const { body } = await call(chain);
    expect(body).toMatchObject({ ok: false, status: "fee-cap", sends: 0, items: [], nextCursor: "1" });
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
    for (const options of [{}, { send: () => ({ kind: "failed", hash: null }) as SendResult }, { outcome: "pending" as const }, { privileged: [runner] }, { privileged: new Error(runnerKey) }]) {
      const { chain } = fakeChain({ 1: open(), 2: { ...open(), phase: 4, revealed: true, snapshotted: true } }, options);
      const { body } = await call(chain, store, () => 1_700_000_000_000 + outputs.length * 120_000);
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
