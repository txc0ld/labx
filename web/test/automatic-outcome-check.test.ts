import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { SAVED_HASH_ATTENTION_MS, startSavedHashCheck, type PageVisibility } from "../components/workflow/useTransactionOutcomes";
import { transactionIntent } from "../lib/chain/pending-journal";
import type { TransactionOutcome } from "../lib/chain/transaction-outcomes";
import type { CanonicalReceipt, OutcomeInspection, OutcomeJournal, SubmittedAction, WalletSnapshot } from "../lib/chain/types";
import type { WalletSessionPort } from "../lib/chain/ports";

const account: Address = "0x1111111111111111111111111111111111111111";
const spender: Address = "0x3333333333333333333333333333333333333333";
const usdc: Address = "0x4444444444444444444444444444444444444444";
const hash: Hex = `0x${"ab".repeat(32)}`;
const otherHash: Hex = `0x${"cd".repeat(32)}`;
const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 12_500_000n] });
const submitted: SubmittedAction = { hash, account, chainId: 31337, to: usdc, data, value: 0n };
const receipt: CanonicalReceipt = { ...submitted, nonce: 4, blockNumber: 20n, status: "success" };
const confirmed: OutcomeInspection = { kind: "confirmed", hash, blockNumber: 20n, replacedHash: null, receipt };
const intent = transactionIntent({ to: usdc, data, value: 0n });

function harness({ inspection = confirmed, journalIntent = intent, outcomes = [] as TransactionOutcome[], saved = { id: "saved", hash, nonce: 4 } as OutcomeJournal | null }: { inspection?: OutcomeInspection; journalIntent?: Hex; outcomes?: TransactionOutcome[]; saved?: OutcomeJournal | null } = {}) {
  let journal = saved;
  let clock = 0, visible = true, onVisible: () => void = () => {};
  const snapshot: WalletSnapshot = { kind: "connected", account, chainId: 31337, revision: 1 };
  const forbidden = () => { throw new Error("The automatic check must not open the wallet."); };
  const wallet = {
    getSnapshot: () => snapshot, subscribe: () => () => {}, refresh: async () => snapshot, disconnect: vi.fn(), assertCurrent: async () => {},
    connect: vi.fn(forbidden), requestTransaction: vi.fn(forbidden), requestExternalExecution: vi.fn(forbidden), signMessage: vi.fn(forbidden)
  } satisfies WalletSessionPort;
  const service = {
    pending: vi.fn(async ({ expectedIntent }: { wallet: WalletSessionPort; expectedIntent?: Hex }) => {
      if (journal && expectedIntent && expectedIntent !== journalIntent) throw new Error("Recover the unrelated wallet transaction before continuing this creation.");
      return journal;
    }),
    inspectOutcome: vi.fn(async (_input: { hash: Hex; account: Address; timeoutMs?: number }) => inspection),
    prepare: vi.fn(forbidden), submit: vi.fn(forbidden), confirm: vi.fn(forbidden), resume: vi.fn(forbidden)
  };
  const terminal: TransactionOutcome = { id: hash, account, kind: "terminal", submitted: receipt, confirmation: { kind: "confirmed", hash, blockNumber: 20n, replacedHash: null, receipt } };
  const owner = {
    getSnapshot: vi.fn(() => outcomes),
    resume: vi.fn(async (_hash: Hex, _wallet: WalletSessionPort): Promise<TransactionOutcome> => { journal = null; return terminal; })
  };
  const visibility: PageVisibility = { visible: () => visible, onVisible(listener) { onVisible = listener; return () => { onVisible = () => {}; }; } };
  const onAttention = vi.fn(), onSettled = vi.fn();
  const stop = startSavedHashCheck({ owner, service, wallet, account, hash, onAttention, onSettled, visibility, now: () => clock });
  return {
    owner, service, wallet, onAttention, onSettled, stop,
    advanceClock(ms: number) { clock += ms; },
    hide() { visible = false; },
    show() { visible = true; onVisible(); },
    get journal() { return journal; }
  };
}

function expectReadsOnly(h: ReturnType<typeof harness>) {
  expect(h.wallet.connect).not.toHaveBeenCalled();
  expect(h.wallet.requestTransaction).not.toHaveBeenCalled();
  expect(h.wallet.requestExternalExecution).not.toHaveBeenCalled();
  expect(h.wallet.signMessage).not.toHaveBeenCalled();
  expect(h.service.prepare).not.toHaveBeenCalled();
  expect(h.service.submit).not.toHaveBeenCalled();
  expect(h.service.confirm).not.toHaveBeenCalled();
  expect(h.service.resume).not.toHaveBeenCalled();
}

describe("automatic check of a saved transaction hash", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("clears the journal only through the canonical owner check after a confirmed read of the exact hash and intent", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.inspectOutcome).toHaveBeenCalledWith({ hash, account, timeoutMs: 0 });
    expect(h.service.pending).toHaveBeenCalledWith(expect.objectContaining({ expectedIntent: intent }));
    expect(h.owner.resume).toHaveBeenCalledTimes(1);
    expect(h.owner.resume).toHaveBeenCalledWith(hash, h.wallet);
    expect(h.journal).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onSettled).toHaveBeenCalled();
    expect(h.onAttention).not.toHaveBeenCalled();
    expectReadsOnly(h);
    h.stop();
  });

  it("keeps waiting quietly while the receipt lacks confirmations, then asks for a person after three minutes", async () => {
    const h = harness({ inspection: { kind: "pending", hash, reason: "confirmations", transaction: { ...submitted, nonce: 4 } } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.service.inspectOutcome.mock.calls.length).toBeGreaterThan(3);
    expect(h.owner.resume).not.toHaveBeenCalled();
    expect(h.onAttention).not.toHaveBeenCalled();
    expect(h.journal).not.toBeNull();
    h.advanceClock(SAVED_HASH_ATTENTION_MS);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.onAttention).toHaveBeenCalled();
    expect(h.owner.resume).not.toHaveBeenCalled();
    expect(h.journal).not.toBeNull();
    expectReadsOnly(h);
    h.stop();
  });

  it.each([
    ["a reverted receipt", { kind: "reverted", hash, reason: "The transaction reverted.", receipt: { ...receipt, status: "reverted" } } satisfies OutcomeInspection],
    ["a replaced receipt", { kind: "replaced", hash: otherHash, reason: "Replaced.", receipt: { ...receipt, hash: otherHash } } satisfies OutcomeInspection]
  ])("leaves %s to the manual form without clearing anything", async (_name, inspection) => {
    const h = harness({ inspection });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onAttention).toHaveBeenCalled();
    expect(h.owner.resume).not.toHaveBeenCalled();
    expect(h.journal).not.toBeNull();
    expectReadsOnly(h);
    h.stop();
  });

  it("leaves a confirmed receipt with a different intent from the journal to the manual form", async () => {
    const h = harness({ journalIntent: transactionIntent({ to: usdc, data: "0x", value: 0n }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onAttention).toHaveBeenCalled();
    expect(h.owner.resume).not.toHaveBeenCalled();
    expect(h.journal).not.toBeNull();
    h.stop();
  });

  it("retries one unknown result silently and asks for a person after the second", async () => {
    const h = harness({ inspection: { kind: "unknown", hash, reason: "Transaction not found." } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onAttention).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.service.inspectOutcome).toHaveBeenCalledTimes(2);
    expect(h.onAttention).toHaveBeenCalledTimes(1);
    expect(h.owner.resume).not.toHaveBeenCalled();
    expect(h.journal).not.toBeNull();
    h.stop();
  });

  it("does not inspect or clear when the journal holds a different hash, and reports it settled", async () => {
    const h = harness({ saved: { id: "newer", hash: otherHash, nonce: 5 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onSettled).toHaveBeenCalled();
    expect(h.service.inspectOutcome).not.toHaveBeenCalled();
    expect(h.owner.resume).not.toHaveBeenCalled();
    expect(h.journal).toEqual({ id: "newer", hash: otherHash, nonce: 5 });
    h.stop();
  });

  it("hands this tab's failed confirmation to the manual form and reads nothing", async () => {
    const h = harness({ outcomes: [{ id: hash, account, kind: "error", submitted, message: "Confirmation could not be checked." }] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.onAttention).toHaveBeenCalled();
    expect(h.service.pending).not.toHaveBeenCalled();
    expect(h.service.inspectOutcome).not.toHaveBeenCalled();
    expect(h.owner.resume).not.toHaveBeenCalled();
    h.stop();
  });

  it("waits while this tab is already confirming the same hash", async () => {
    const h = harness({ outcomes: [{ id: hash, account, kind: "checking", submitted }] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.service.pending).not.toHaveBeenCalled();
    expect(h.owner.resume).not.toHaveBeenCalled();
    expect(h.onAttention).not.toHaveBeenCalled();
    h.stop();
  });

  it("reads nothing while the page is hidden and checks at once when it becomes visible", async () => {
    const h = harness({ inspection: { kind: "pending", hash, reason: "unmined", transaction: { ...submitted, nonce: 4 } } });
    await vi.advanceTimersByTimeAsync(0);
    const calls = h.service.inspectOutcome.mock.calls.length;
    h.hide();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.service.inspectOutcome).toHaveBeenCalledTimes(calls);
    h.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.inspectOutcome).toHaveBeenCalledTimes(calls + 1);
    h.stop();
  });

  it("stops reading once stopped", async () => {
    const h = harness({ inspection: { kind: "pending", hash, reason: "unmined", transaction: { ...submitted, nonce: 4 } } });
    await vi.advanceTimersByTimeAsync(0);
    h.stop();
    const calls = h.service.pending.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.service.pending).toHaveBeenCalledTimes(calls);
  });
});
