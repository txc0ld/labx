import { afterEach, describe, expect, it, vi } from "vitest";
import { TransactionNotFoundError, type PublicClient } from "viem";
import { createRaffleService, UNSENT_CLEAR_BLOCKS } from "../lib/chain/service";
import { memoryPendingJournal, REQUEST_OPEN_ELSEWHERE, type PendingIntent, type PendingJournal } from "../lib/chain/pending-journal";
import { checkNetworkFee, aboutEth, PRIORITY_FEE_FLOOR, suggestFees } from "../lib/chain/network-fee";
import { notSentReason, preBroadcastEvidence } from "../lib/chain/wallet-errors";
import { isNotSent, NotSentError, SubmissionNotDispatchedError } from "../lib/chain/submission-errors";
import { WalletSession } from "../lib/chain/wallet-session";
import { startPendingSendCheck, type PageVisibility, type PendingSendStatus } from "../components/workflow/useTransactionOutcomes";
import { createTransactionOutcomes, type OutcomeStorage, type TransactionOutcome } from "../lib/chain/transaction-outcomes";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DeploymentManifest, PendingSettlement, WalletProvider, WalletSnapshot } from "../lib/chain/types";
import { fixtureTrust } from "./fixtures/deployment";

const ACCOUNT = "0x0dae6E01A88826b4E77d717d9639B64F749C0152";
const CONTRACT = "0x8b0332D0ca48908e174F42eA1b3123e63f3F4327";
const DIGEST = `0x${"ab".repeat(32)}` as const;
const manifest: DeploymentManifest = { ...fixtureTrust, chainId: 11155111, version: 3, address: CONTRACT, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", runtimeCodeHash: DIGEST, deploymentBlock: 1n };
const STARTED = 9_000_000n;

/** The owner's stuck purchase: nonce 18, no hash, started at block STARTED. */
function entry(overrides: Partial<PendingIntent> = {}): PendingIntent {
  return { id: "stuck-purchase", intentHash: DIGEST, nonce: 18, startedBlock: STARTED.toString(), hash: null, ...overrides };
}

/**
 * A chain that answers only the reads the pending check makes: latest and pending nonces, the nonce at the block below the
 * head (`deep`, the latest nonce unless set), the block number and, for a saved hash, whether it is known.
 */
function chainReads(initial: { latest: number; pending: number; block: bigint; known?: boolean; deep?: number }) {
  const state = { known: false, ...initial, reads: 0, deepReads: [] as bigint[], onRead: undefined as (() => void) | undefined };
  const client = {
    async getTransactionCount({ blockTag, blockNumber }: { blockTag?: "latest" | "pending"; blockNumber?: bigint }) {
      state.reads += 1; state.onRead?.();
      if (blockNumber !== undefined) { state.deepReads.push(blockNumber); return state.deep ?? state.latest; }
      return blockTag === "latest" ? state.latest : state.pending;
    },
    async getBlockNumber() { return state.block; },
    async getTransaction({ hash }: { hash: `0x${string}` }) {
      if (!state.known) throw new TransactionNotFoundError({ hash });
      return { hash };
    }
  } as unknown as PublicClient;
  return { client, state };
}

/** A journal that counts its locked runs and any two that overlap, which the lock must never allow. */
function watchedJournal() {
  const inner = memoryPendingJournal();
  const stats = { runs: 0, overlaps: 0 };
  let active = 0;
  const journal: PendingJournal = {
    ...inner,
    exclusive: (account, run) => inner.exclusive(account, async () => {
      stats.runs += 1;
      if (++active > 1) stats.overlaps += 1;
      try { return await run(); } finally { active -= 1; }
    })
  };
  return { journal, stats };
}
const macrotasks = async (count: number) => { for (let index = 0; index < count; index++) await new Promise(resolve => setTimeout(resolve, 0)); };

function connectedWallet(account: `0x${string}` = ACCOUNT): WalletSessionPort {
  const snapshot: WalletSnapshot = { kind: "connected", account, chainId: manifest.chainId, revision: 1 };
  return {
    getSnapshot: () => snapshot, subscribe: () => () => {}, connect: async () => snapshot, refresh: async () => snapshot, disconnect: () => {},
    assertCurrent: async () => {}, signMessage: async () => { throw new Error("No signatures in this test."); },
    requestTransaction: async () => { throw new Error("No transactions in this test."); }
  };
}

function setup(chain: { latest: number; pending: number; block: bigint; deep?: number }, journal: PendingJournal = memoryPendingJournal()) {
  const reads = chainReads(chain);
  const service = createRaffleService(reads.client, manifest, journal);
  journal.write(ACCOUNT, entry());
  return { ...reads, journal, service, wallet: connectedWallet(), expected: { id: "stuck-purchase", hash: null, nonce: 18 } };
}

describe("a pending send without a hash settles from the account's nonces", () => {
  it("clears the record once nonce 18 is spent with two confirmations and nothing is pending (L > N, P == L)", async () => {
    const { service, wallet, expected, journal, state } = setup({ latest: 19, pending: 19, block: STARTED + 1n });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "spent" });
    expect(journal.read(ACCOUNT)).toBeNull();
    // The nonce is read at the block below the head: a send mined there has its own block and one more.
    expect(state.deepReads).toEqual([STARTED]);
  });

  it("waits while nonce 18 has only one confirmation, then clears it as spent at two", async () => {
    const { service, wallet, expected, journal, state } = setup({ latest: 19, pending: 19, deep: 18, block: STARTED + 1n });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "waiting" });
    expect(await service.settlePending({ wallet, expected, continueUnsent: true })).toEqual({ kind: "waiting" });
    expect(journal.read(ACCOUNT)?.id).toBe("stuck-purchase");
    state.block = STARTED + 2n; state.deep = 19;
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "spent" });
    expect(journal.read(ACCOUNT)).toBeNull();
  });

  it("waits while a later mined nonce has only one confirmation, since a wallet may have sent this one at another nonce", async () => {
    const { service, wallet, expected, journal } = setup({ latest: 20, pending: 20, deep: 19, block: STARTED + 100n });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "waiting" });
    expect(journal.read(ACCOUNT)?.id).toBe("stuck-purchase");
  });

  it.each([
    ["an earlier nonce dropped, so the send may sit in the node's queue (L < N, P < N)", { latest: 17, pending: 17 }],
    ["an earlier nonce is still pending (L < N, P == N)", { latest: 17, pending: 18 }]
  ])("keeps the record and waits when %s, even on Continue and after 25 blocks", async (_name, nonces) => {
    const { service, wallet, expected, journal } = setup({ ...nonces, block: STARTED + UNSENT_CLEAR_BLOCKS + 5n });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "waiting" });
    expect(await service.settlePending({ wallet, expected, continueUnsent: true })).toEqual({ kind: "waiting" });
    expect(journal.read(ACCOUNT)?.id).toBe("stuck-purchase");
  });

  it("waits while something is pending at nonce 18 (P > N >= L)", async () => {
    const { service, wallet, expected, journal } = setup({ latest: 18, pending: 19, block: STARTED + 100n });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "waiting" });
    expect(await service.settlePending({ wallet, expected, continueUnsent: true })).toEqual({ kind: "waiting" });
    expect(journal.read(ACCOUNT)?.id).toBe("stuck-purchase");
  });

  it("waits while nonce 18 is spent but a later send is still pending, which may be this one (L > N, P > L)", async () => {
    const { service, wallet, expected, journal } = setup({ latest: 19, pending: 20, block: STARTED + 100n });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "waiting" });
    expect(journal.read(ACCOUNT)?.id).toBe("stuck-purchase");
  });

  it("reports an unsent record (P <= N) and clears it only on Continue before 25 blocks pass", async () => {
    const { service, wallet, expected, journal } = setup({ latest: 18, pending: 18, block: STARTED + UNSENT_CLEAR_BLOCKS - 1n });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "unsent" });
    expect(journal.read(ACCOUNT)?.id).toBe("stuck-purchase");
    expect(await service.settlePending({ wallet, expected, continueUnsent: true })).toEqual({ kind: "dropped" });
    expect(journal.read(ACCOUNT)).toBeNull();
  });

  it("clears an unsent record by itself once the block is at least its starting block plus 25", async () => {
    const { service, wallet, expected, journal } = setup({ latest: 18, pending: 18, block: STARTED + UNSENT_CLEAR_BLOCKS });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "dropped" });
    expect(journal.read(ACCOUNT)).toBeNull();
  });

  it("keeps the record when the RPC returns a pending nonce below the latest one", async () => {
    const { service, wallet, expected, journal } = setup({ latest: 19, pending: 18, block: STARTED + 100n });
    await expect(service.settlePending({ wallet, expected })).rejects.toThrow(/inconsistent nonces/);
    expect(journal.read(ACCOUNT)?.id).toBe("stuck-purchase");
  });

  it("never touches a record other than the one it was asked about", async () => {
    const { service, wallet, journal, state } = setup({ latest: 19, pending: 19, block: STARTED + 100n });
    expect(await service.settlePending({ wallet, expected: { id: "another-record", hash: null, nonce: 18 } })).toEqual({ kind: "changed" });
    expect(await service.settlePending({ wallet, expected: { id: "stuck-purchase", hash: null, nonce: 17 } })).toEqual({ kind: "changed" });
    journal.write(ACCOUNT, entry({ hash: `0x${"cd".repeat(32)}` }));
    expect(await service.settlePending({ wallet, expected: { id: "stuck-purchase", hash: null, nonce: 18 } })).toEqual({ kind: "changed" });
    expect(journal.read(ACCOUNT)?.hash).toBe(`0x${"cd".repeat(32)}`);
    expect(state.reads).toBe(0);
  });

  it("re-reads the record after the chain read and leaves a replacement written meanwhile", async () => {
    const { service, wallet, expected, journal, state } = setup({ latest: 19, pending: 19, block: STARTED + 100n });
    state.onRead = () => { journal.write(ACCOUNT, entry({ id: "newer-send", nonce: 19 })); };
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "changed" });
    expect(journal.read(ACCOUNT)?.id).toBe("newer-send");
  });

  it("lets only one of two tabs clear the record, each inside the journal lock, never overlapping", async () => {
    const { journal, stats } = watchedJournal();
    const first = setup({ latest: 18, pending: 18, block: STARTED + 1n }, journal);
    const second = createRaffleService(first.client, manifest, journal);
    const results = await Promise.all([
      first.service.settlePending({ wallet: first.wallet, expected: first.expected, continueUnsent: true }),
      second.settlePending({ wallet: first.wallet, expected: first.expected, continueUnsent: true })
    ]);
    expect(results.map(result => result.kind).sort()).toEqual(["changed", "dropped"]);
    expect(journal.read(ACCOUNT)).toBeNull();
    expect(stats).toEqual({ runs: 2, overlaps: 0 });
  });

  it("reads nothing from the chain while another tab holds the journal lock, then leaves that tab's new send alone", async () => {
    // A tab holding the journal lock retires the record and starts a new send. This tab read the old record before the
    // lock and must neither read the chain nor clear anything until it gets the lock, and then must not clear the new one.
    const { service, wallet, expected, journal, state } = setup({ latest: 18, pending: 18, block: STARTED + 1n });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const otherTab = journal.exclusive(ACCOUNT, async () => {
      await held;
      journal.remove(ACCOUNT);
      journal.write(ACCOUNT, entry({ id: "other-tab-send", nonce: 18 }));
    });
    let settled = false;
    const waiting = service.settlePending({ wallet, expected, continueUnsent: true }).finally(() => { settled = true; });
    await macrotasks(5);
    expect(settled).toBe(false);
    expect(state.reads).toBe(0);
    expect(journal.read(ACCOUNT)?.id).toBe("stuck-purchase");
    release();
    await otherTab;
    expect(await waiting).toEqual({ kind: "changed" });
    expect(journal.read(ACCOUNT)?.id).toBe("other-tab-send");
  });

  it("waits while another tab has a wallet request open, even with nothing at its nonce after 25 blocks", async () => {
    const { service, wallet, expected, journal, state } = setup({ latest: 18, pending: 18, block: STARTED + UNSENT_CLEAR_BLOCKS + 5n });
    let answer!: () => void;
    const answered = new Promise<void>(resolve => { answer = resolve; });
    const otherTab = journal.holdRequest(ACCOUNT, () => answered);
    await expect(journal.holdRequest(ACCOUNT, async () => "second request")).rejects.toThrow(REQUEST_OPEN_ELSEWHERE);
    expect(await service.settlePending({ wallet, expected, continueUnsent: true })).toEqual({ kind: "waiting" });
    expect(journal.read(ACCOUNT)?.id).toBe("stuck-purchase");
    expect(state.reads).toBe(0);
    answer();
    await otherTab;
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "dropped" });
    expect(journal.read(ACCOUNT)).toBeNull();
  });
});

describe("a pending send whose saved hash the chain no longer knows", () => {
  const SAVED = `0x${"cd".repeat(32)}` as const;
  function saved(chain: { latest: number; pending: number; block: bigint; known?: boolean; deep?: number }) {
    const setupResult = setup(chain);
    setupResult.journal.write(ACCOUNT, entry({ hash: SAVED }));
    return { ...setupResult, expected: { id: "stuck-purchase", hash: SAVED, nonce: 18 } };
  }

  it("leaves a hash the chain still knows to its receipt check", async () => {
    const { service, wallet, expected, journal, state } = saved({ latest: 19, pending: 19, block: STARTED + 100n, known: true });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "waiting" });
    expect(journal.read(ACCOUNT)?.hash).toBe(SAVED);
    expect(state.reads).toBe(0);
  });

  it("clears it once its nonce is spent by a replacement and nothing is pending (L > N, P == L)", async () => {
    const { service, wallet, expected, journal } = saved({ latest: 19, pending: 19, block: STARTED + 1n });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "spent" });
    expect(journal.read(ACCOUNT)).toBeNull();
  });

  it("waits while something is pending at its nonce", async () => {
    const { service, wallet, expected, journal } = saved({ latest: 18, pending: 19, block: STARTED + 100n });
    expect(await service.settlePending({ wallet, expected })).toEqual({ kind: "waiting" });
    expect(journal.read(ACCOUNT)?.hash).toBe(SAVED);
  });

  it("waits while its spent nonce has one confirmation, or while a gap below its nonce can hold it queued", async () => {
    const shallow = saved({ latest: 19, pending: 19, deep: 18, block: STARTED + 100n });
    expect(await shallow.service.settlePending({ wallet: shallow.wallet, expected: shallow.expected })).toEqual({ kind: "waiting" });
    expect(shallow.journal.read(ACCOUNT)?.hash).toBe(SAVED);
    const gap = saved({ latest: 17, pending: 17, block: STARTED + UNSENT_CLEAR_BLOCKS + 5n });
    expect(await gap.service.settlePending({ wallet: gap.wallet, expected: gap.expected })).toEqual({ kind: "waiting" });
    expect(gap.journal.read(ACCOUNT)?.hash).toBe(SAVED);
  });

  it("clears a dropped send only after 25 blocks with nothing at its nonce, never on Continue", async () => {
    const early = saved({ latest: 18, pending: 18, block: STARTED + UNSENT_CLEAR_BLOCKS - 1n });
    expect(await early.service.settlePending({ wallet: early.wallet, expected: early.expected, continueUnsent: true })).toEqual({ kind: "unsent" });
    expect(early.journal.read(ACCOUNT)?.hash).toBe(SAVED);
    const late = saved({ latest: 18, pending: 18, block: STARTED + UNSENT_CLEAR_BLOCKS });
    expect(await late.service.settlePending({ wallet: late.wallet, expected: late.expected })).toEqual({ kind: "dropped" });
    expect(late.journal.read(ACCOUNT)).toBeNull();
  });

  it("never clears a record whose saved hash differs from the one inspected", async () => {
    const { service, wallet, journal } = saved({ latest: 19, pending: 19, block: STARTED + 100n });
    expect(await service.settlePending({ wallet, expected: { id: "stuck-purchase", hash: `0x${"ef".repeat(32)}`, nonce: 18 } })).toEqual({ kind: "changed" });
    expect(await service.settlePending({ wallet, expected: { id: "stuck-purchase", hash: null, nonce: 18 } })).toEqual({ kind: "changed" });
    expect(journal.read(ACCOUNT)?.hash).toBe(SAVED);
  });
});

describe("settling a saved hash through the page's outcome owner", () => {
  const SAVED = `0x${"cd".repeat(32)}` as const;
  const OTHER = `0x${"ef".repeat(32)}` as const;
  const prefix = `labx:outcome:v1:${manifest.chainId}:${CONTRACT.toLowerCase()}:${DIGEST}:${ACCOUNT.toLowerCase()}:`;
  function outcomes(removeItem?: (key: string) => void) {
    const reads = chainReads({ latest: 19, pending: 19, deep: 18, block: STARTED + 100n });
    const journal = memoryPendingJournal();
    const service = createRaffleService(reads.client, manifest, journal);
    journal.write(ACCOUNT, entry({ hash: SAVED }));
    // A dropped saved hash and an unrelated one, each with its durable outcome checkpoint, as a reload finds them.
    const map = new Map<string, string>([[`${prefix}${SAVED}`, SAVED], [`${prefix}${OTHER}`, OTHER]]);
    const storage: OutcomeStorage = { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null,
      setItem: (key, value) => { map.set(key, value); }, removeItem: removeItem ?? (key => { map.delete(key); }) };
    return { ...reads, journal, service, map, storage, expected: { id: "stuck-purchase", hash: SAVED, nonce: 18 } };
  }
  const shown = (items: readonly TransactionOutcome[]) => items.map(item => `${item.kind}:${"hash" in item ? item.hash : ""}`);

  it("removes that hash's checkpoint and row with the record, so nothing blocks Buy after a reload, and keeps other outcomes", async () => {
    const { service, journal, map, storage, state, expected } = outcomes();
    const tab = createTransactionOutcomes(service, () => storage);
    await tab.recover(ACCOUNT);
    expect(shown(tab.getSnapshot(ACCOUNT))).toEqual([`unverified:${SAVED}`, `unverified:${OTHER}`]);
    // One confirmation: nothing is cleared yet.
    expect(await tab.settlePending({ wallet: connectedWallet(), expected })).toEqual({ kind: "waiting" });
    expect(map.size).toBe(2);
    state.deep = 19;
    expect(await tab.settlePending({ wallet: connectedWallet(), expected })).toEqual({ kind: "spent" });
    expect(journal.read(ACCOUNT)).toBeNull();
    expect([...map.keys()]).toEqual([`${prefix}${OTHER}`]);
    expect(shown(tab.getSnapshot(ACCOUNT))).toEqual([`unverified:${OTHER}`]);
    const reloaded = createTransactionOutcomes(service, () => storage);
    await reloaded.recover(ACCOUNT);
    expect(shown(reloaded.getSnapshot(ACCOUNT))).toEqual([`unverified:${OTHER}`]);
  });

  it("does not bring the row back when a recovery read that started before the settlement finishes after it", async () => {
    const { service, map, storage, state, expected } = outcomes();
    state.deep = 19;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = { ...service, async inspectOutcome(input: Parameters<RaffleService["inspectOutcome"]>[0]) { await gate; return service.inspectOutcome(input); } };
    const tab = createTransactionOutcomes(slow, () => storage);
    const recovering = tab.recover(ACCOUNT);
    expect(shown(tab.getSnapshot(ACCOUNT))).toEqual([`recovery:${SAVED}`, `recovery:${OTHER}`]);
    expect(await tab.settlePending({ wallet: connectedWallet(), expected })).toEqual({ kind: "spent" });
    expect(shown(tab.getSnapshot(ACCOUNT))).toEqual([`recovery:${OTHER}`]);
    release();
    await recovering;
    expect(shown(tab.getSnapshot(ACCOUNT))).toEqual([`unverified:${OTHER}`]);
    expect(map.size).toBe(1);
  });

  it("keeps the record when its checkpoint cannot be removed", async () => {
    const { service, journal, map, storage, state, expected } = outcomes(() => {});
    state.deep = 19;
    const tab = createTransactionOutcomes(service, () => storage);
    await expect(tab.settlePending({ wallet: connectedWallet(), expected })).rejects.toThrow("The recovery checkpoint could not be cleared.");
    expect(journal.read(ACCOUNT)?.hash).toBe(SAVED);
    expect(map.size).toBe(2);
  });
});

describe("the page's chain check for a pending send", () => {
  function visibility(initial = true) {
    let visible = initial, listener: (() => void) | null = null;
    const page: PageVisibility = { visible: () => visible, onVisible(next) { listener = next; return () => { listener = null; }; } };
    return { page, show() { visible = true; listener?.(); }, hide() { visible = false; } };
  }
  function scripted(results: (PendingSettlement | Error)[]) {
    const calls: { continueUnsent: boolean }[] = [];
    const service: Pick<RaffleService, "settlePending"> = {
      async settlePending({ continueUnsent = false }) {
        calls.push({ continueUnsent });
        const next = results.shift() ?? { kind: "waiting" };
        if (next instanceof Error) throw next;
        return next;
      }
    };
    return { service, calls };
  }
  afterEach(() => { vi.useRealTimers(); });

  it("reads once on load even while hidden, polls only while visible, and stops after the record clears", async () => {
    vi.useFakeTimers();
    const view = visibility(false);
    const { service, calls } = scripted([{ kind: "waiting" }, { kind: "waiting" }, { kind: "spent" }]);
    const statuses: PendingSendStatus[] = [];
    const check = startPendingSendCheck({ service, wallet: connectedWallet(), expected: { id: "stuck-purchase", hash: null, nonce: 18 }, onStatus: status => statuses.push(status), visibility: view.page, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    expect(statuses).toEqual(["waiting"]);
    view.show();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statuses).toEqual(["waiting", "spent"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
    check.stop();
  });

  it("reports unsent, settles on Continue, and says unknown only after two failed reads in a row", async () => {
    vi.useFakeTimers();
    const view = visibility(true);
    const { service, calls } = scripted([new Error("RPC down"), { kind: "unsent" }, new Error("RPC down"), new Error("RPC down"), { kind: "dropped" }]);
    const statuses: PendingSendStatus[] = [];
    const check = startPendingSendCheck({ service, wallet: connectedWallet(), expected: { id: "stuck-purchase", hash: null, nonce: 18 }, onStatus: status => statuses.push(status), visibility: view.page, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statuses).toEqual(["unsent"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(statuses).toEqual(["unsent", "unknown"]);
    await check.continueUnsent();
    expect(calls.at(-1)).toEqual({ continueUnsent: true });
    expect(statuses).toEqual(["unsent", "unknown", "settled"]);
    check.stop();
  });
});

describe("wallet failures before broadcast", () => {
  it.each([
    ["insufficient funds nested in EIP-1193 data", { code: -32603, message: "Internal JSON-RPC error.", data: { code: -32000, message: "insufficient funds for gas * price + value" } }],
    ["a failed gas estimate in a viem cause chain", Object.assign(new Error("Transaction failed."), { cause: new Error("gas required exceeds allowance (968194)") })],
    ["intrinsic gas", new Error("intrinsic gas too low")],
    ["a fee below the base fee", { code: -32000, message: "max fee per gas less than block base fee" }]
  ])("treats %s as pre-broadcast by its message", (_name, error) => {
    expect(preBroadcastEvidence(error)).toBe("message");
  });

  // Some wallets use these codes after their own RPC took the send, so the caller re-reads the nonce over a few seconds.
  it.each([
    ["MetaMask's internal error", { code: -32603, message: "Internal JSON-RPC error." }],
    ["WalletConnect's generic internal error", { code: -32603, message: "Internal error" }],
    ["a server error with another message", { code: -32000, message: "header not found" }]
  ])("treats %s as pre-broadcast by its code only", (_name, error) => {
    expect(preBroadcastEvidence(error)).toBe("code");
  });

  it.each([
    ["a clean rejection", { code: 4001, message: "User rejected the request." }],
    ["a timeout after broadcast", new Error("provider timed out after broadcast")],
    ["an unauthorized method", { code: 4100, message: "The requested method is not authorized." }],
    ["a plain value", "failed"]
  ])("does not treat %s as pre-broadcast", (_name, error) => {
    expect(preBroadcastEvidence(error)).toBeNull();
  });

  it("names the plain cause", () => {
    expect(notSentReason({ code: -32603, data: { message: "insufficient funds for gas * price + value" } }, "Sepolia ETH")).toBe("Your wallet doesn't have enough Sepolia ETH for its network fee. Nothing was sent.");
    expect(notSentReason(new Error("intrinsic gas too low"), "ETH")).toBe("Your wallet couldn't work out the network fee for this transaction. Nothing was sent.");
    expect(notSentReason({ code: -32603, message: "Internal JSON-RPC error." }, "ETH")).toBe("Your wallet couldn't send this transaction. Nothing was sent.");
  });

  it("recognises a not-sent error directly and inside the not-dispatched wrapper", () => {
    const plain = new NotSentError("Your wallet needs about 0.0004 Sepolia ETH for the network fee.");
    expect(isNotSent(plain)).toBe(true);
    expect(isNotSent(new SubmissionNotDispatchedError(plain))).toBe(true);
    expect(isNotSent(new SubmissionNotDispatchedError(new Error("Amounts changed.")))).toBe(false);
  });
});

describe("network fee suggestion and pre-check", () => {
  const BUY_PACK_GAS = 968_194n;
  function feeClient(input: { baseFee: bigint | null; tip: bigint; gas?: bigint; balance: bigint; estimateError?: Error }) {
    const calls: string[] = [];
    const client = {
      async getBlock() { calls.push("getBlock"); return { baseFeePerGas: input.baseFee }; },
      async estimateMaxPriorityFeePerGas() { calls.push("estimateMaxPriorityFeePerGas"); return input.tip; },
      async estimateGas() { calls.push("estimateGas"); if (input.estimateError) throw input.estimateError; return input.gas ?? BUY_PACK_GAS; },
      async getBalance() { calls.push("getBalance"); return input.balance; }
    } as unknown as PublicClient;
    return { client, calls };
  }
  const purchase = { account: ACCOUNT, to: CONTRACT, data: "0x12345678", value: 0n, blockNumber: 9_000_000n } as const;

  it("suggests Sepolia's own fee: the RPC tip with a 0.001 gwei floor on top of twice the base fee", async () => {
    // Sepolia on 2026-10-19: base fee 15 wei, eth_maxPriorityFeePerGas 2 wei.
    expect(await suggestFees(feeClient({ baseFee: 15n, tip: 2n, balance: 0n }).client)).toEqual({ maxFeePerGas: 30n + PRIORITY_FEE_FLOOR, maxPriorityFeePerGas: PRIORITY_FEE_FLOOR });
    expect(await suggestFees(feeClient({ baseFee: 10_000_000_000n, tip: 1_500_000_000n, balance: 0n }).client)).toEqual({ maxFeePerGas: 21_500_000_000n, maxPriorityFeePerGas: 1_500_000_000n });
    await expect(suggestFees(feeClient({ baseFee: null, tip: 2n, balance: 0n }).client)).rejects.toThrow(/EIP-1559/);
  });

  it("lets the owner's wallet buy: 0.0000158 ETH covers buyPack at Sepolia's suggested fee", async () => {
    const { client } = feeClient({ baseFee: 15n, tip: 2n, balance: 15_800_000_000_000n });
    expect(await checkNetworkFee(client, 11155111, purchase)).toEqual({ maxFeePerGas: 30n + PRIORITY_FEE_FLOOR, maxPriorityFeePerGas: PRIORITY_FEE_FLOOR });
  });

  it("refuses with one plain sentence when gas × 1.5 × maxFeePerGas + value is more than the balance", async () => {
    const short = feeClient({ baseFee: 1_000_000_000n, tip: 1_500_000_000n, balance: 15_800_000_000_000n });
    const refusal = checkNetworkFee(short.client, 11155111, purchase);
    await expect(refusal).rejects.toBeInstanceOf(NotSentError);
    await expect(refusal).rejects.toThrow("Your wallet needs about 0.0051 Sepolia ETH for the network fee.");
    const payment = feeClient({ baseFee: 1_000_000_000n, tip: 1_000_000_000n, gas: 200_000n, balance: 10n ** 15n });
    await expect(checkNetworkFee(payment.client, 1, { ...purchase, value: 10n ** 15n })).rejects.toThrow("Your wallet needs about 0.0019 ETH for this payment and the network fee.");
  });

  it("covers the gas limit a wallet sets, about 1.5 times the estimate, not only the estimate itself", async () => {
    // 968,194 gas at Sepolia's suggested 1,000,030 wei is 0.00000097 ETH; the wallet's padded limit needs 0.0000015 ETH.
    const between = feeClient({ baseFee: 15n, tip: 2n, balance: 1_200_000_000_000n });
    await expect(checkNetworkFee(between.client, 11155111, purchase)).rejects.toThrow("Your wallet needs about 0.0000015 Sepolia ETH for the network fee.");
    const covered = feeClient({ baseFee: 15n, tip: 2n, balance: 1_500_000_000_000n });
    await expect(checkNetworkFee(covered.client, 11155111, purchase)).resolves.toEqual({ maxFeePerGas: 30n + PRIORITY_FEE_FLOOR, maxPriorityFeePerGas: PRIORITY_FEE_FLOOR });
  });

  it("refuses plainly when the gas estimate fails", async () => {
    const reverted = feeClient({ baseFee: 15n, tip: 2n, balance: 10n ** 18n, estimateError: new Error("execution reverted") });
    await expect(checkNetworkFee(reverted.client, 11155111, purchase)).rejects.toThrow("This transaction would fail on the network right now, so your wallet wasn't opened. Refresh and try again.");
  });

  it("rounds amounts up to two significant digits", () => {
    expect(aboutEth(3_388_679_000_000_000n)).toBe("0.0034");
    expect(aboutEth(968_194n * 1_000_030n)).toBe("0.00000097");
    expect(aboutEth(400_000_000_000_000n)).toBe("0.0004");
    expect(aboutEth(7n)).toBe("0.000000000000000007");
  });
});

describe("eth_sendTransaction fee fields", () => {
  it("sends the suggested EIP-1559 fees with the unchanged call, value, nonce and chain", async () => {
    const sent: unknown[] = [];
    const provider: WalletProvider = {
      async request({ method, params }) {
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ACCOUNT];
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_sendTransaction") { sent.push(params?.[0]); return `0x${"12".repeat(32)}`; }
        throw new Error(`Unexpected ${method}`);
      }
    };
    const wallet = new WalletSession(provider, 11155111);
    const session = await wallet.connect();
    if (session.kind !== "connected") throw new Error("Missing session");
    await wallet.requestTransaction(session, { to: CONTRACT, data: "0xabcdef", value: 0n, nonce: 18, maxFeePerGas: 30n + PRIORITY_FEE_FLOOR, maxPriorityFeePerGas: PRIORITY_FEE_FLOOR });
    await wallet.requestTransaction(session, { to: CONTRACT, data: "0xabcdef", value: 5n });
    expect(sent).toEqual([
      { from: ACCOUNT, to: CONTRACT, data: "0xabcdef", value: "0x0", chainId: "0xaa36a7", nonce: "0x12", maxFeePerGas: "0xf425e", maxPriorityFeePerGas: "0xf4240" },
      { from: ACCOUNT, to: CONTRACT, data: "0xabcdef", value: "0x5", chainId: "0xaa36a7" }
    ]);
  });
});
