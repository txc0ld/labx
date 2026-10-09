import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, type Address } from "viem";
import { advanceCreateGeneration, assertCreateGeneration, captureCreateGeneration, encodeDraft, finishCreate, recoverCreateTransaction, retireUnsentCreate, type CreateRecord } from "../lib/chain/create-flow";
import { transactionIntent } from "../lib/chain/pending-journal";
import { SubmissionNotDispatchedError } from "../lib/chain/submission-errors";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { CanonicalReceipt, DraftInput, PreparedAction, RaffleSnapshot, SubmittedAction } from "../lib/chain/types";
import { standardMembershipPacks } from "./fixtures/membership-tiers";

const seller = "0x1111111111111111111111111111111111111111" as Address;
const raffle = "0x2222222222222222222222222222222222222222" as Address;
const nft = "0x3333333333333333333333333333333333333333" as Address;
const hash = (label: string) => keccak256(toBytes(label));
const draft: DraftInput = {
  nft,
  tokenId: 77n,
  salesEnd: 1_900_000_000n,
  reserveNonce: hash("independent-nonce"),
  reserveCommit: hash("independent-commit"),
  title: "Independent create recovery",
  packs: standardMembershipPacks((_tier, index) => ({ priceUsdc: 25_000_000n + BigInt(index), bonusEntries: index + 1, maxSupply: 10 + index }))
};
const initialRecord: Extract<CreateRecord, { kind: "draft" }> = {
  kind: "draft",
  data: encodeDraft(draft),
  creationHash: null,
  id: null,
  pending: null
};
const receipt: CanonicalReceipt = {
  hash: hash("create-transaction"),
  account: seller,
  chainId: 31337,
  to: raffle,
  data: encodeDraft(draft),
  value: 0n,
  nonce: 0,
  blockNumber: 12n,
  status: "success"
};
const submitted: SubmittedAction = {
  hash: receipt.hash,
  account: seller,
  chainId: 31337,
  to: raffle,
  data: receipt.data,
  value: 0n
};
const checkpoint = {
  id: "independent-create-checkpoint",
  intentHash: transactionIntent({ to: raffle, data: receipt.data, value: 0n }),
  nonce: receipt.nonce,
  startedBlock: "1"
};

function snapshot(): RaffleSnapshot {
  return {
    id: 9n,
    packs: draft.packs,
    raffle: {
      seller,
      nft: draft.nft,
      tokenId: draft.tokenId,
      salesEnd: draft.salesEnd,
      reserveNonce: draft.reserveNonce,
      reserveCommit: draft.reserveCommit,
      title: draft.title,
      phase: 0,
      escrowed: true
    }
  } as unknown as RaffleSnapshot;
}

function wallet(): WalletSessionPort {
  const connected = { kind: "connected" as const, account: seller, chainId: 31337, revision: 1 };
  return {
    getSnapshot: () => connected,
    subscribe: () => () => undefined,
    connect: async () => connected,
    refresh: async () => connected,
    disconnect: () => undefined,
    assertCurrent: async expected => { expect(expected).toEqual(connected); },
    requestTransaction: async () => { throw new Error("Unexpected direct wallet request in coordinator test."); },
    signMessage: async () => hash("unused-signature")
  };
}

function memoryStorage() {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: index => [...map.keys()][index] ?? null,
    removeItem: key => { map.delete(key); },
    setItem: (key, value) => { map.set(key, value); }
  };
  return { map, storage };
}

function service(overrides: Partial<RaffleService> = {}): RaffleService {
  const canonical = snapshot();
  const prepared = { action: { kind: "createDraft", draft } } as PreparedAction;
  return {
    manifest: { chainId: 31337, address: raffle },
    pending: async () => null,
    prepare: async () => prepared,
    submit: async (input: Parameters<RaffleService["submit"]>[0]) => { input.beforeRequest?.(checkpoint); return submitted; },
    confirm: async ({ beforeJournalClear }: Parameters<RaffleService["confirm"]>[0]) => {
      beforeJournalClear?.({ receipt, pending: null });
      return { kind: "confirmed", hash: receipt.hash, blockNumber: receipt.blockNumber, replacedHash: null, receipt };
    },
    inspectOutcome: async () => ({ kind: "confirmed", hash: receipt.hash, blockNumber: receipt.blockNumber, replacedHash: null, receipt }),
    acknowledgeOutcome: async (input: Parameters<RaffleService["acknowledgeOutcome"]>[0]) => input.acknowledge(),
    resolveCreatedDraft: async () => canonical,
    readRaffle: async () => canonical,
    readAccount: async () => ({ account: seller, snapshot: canonical, principal: 0n, fee: 0n, usdcBalance: 0n, usdcAllowance: 0n, nftOwner: raffle, nftApproved: true }),
    resume: async () => null,
    ...overrides
  } as unknown as RaffleService;
}

describe("independent create coordinator recovery boundaries", () => {
  it.each([
    { kind: "reverted" as const, receipt: { ...receipt, status: "reverted" as const }, reason: "Call reverted" },
    {
      kind: "replaced" as const,
      receipt: { ...receipt, hash: hash("cancel-transaction"), to: seller, data: "0x" as const, status: "success" as const },
      reason: "Cancelled by a different same-nonce transaction"
    }
  ])("retires a canonically terminal $kind step so only a later explicit retry sends again", async terminal => {
    let current = initialRecord;
    let attempts = 0;
    const submit = vi.fn(async (input: Parameters<RaffleService["submit"]>[0]) => {
      input.beforeRequest?.({ ...checkpoint, id: `${checkpoint.id}-${attempts + 1}` });
      attempts += 1;
      return { ...submitted, hash: hash(`submitted-${attempts}`) };
    });
    const confirm = vi.fn(async ({ transaction, beforeJournalClear }: Parameters<RaffleService["confirm"]>[0]) => {
      if (confirm.mock.calls.length === 1) {
        beforeJournalClear?.({ receipt: terminal.receipt, pending: null });
        return { kind: terminal.kind, hash: terminal.receipt.hash, receipt: terminal.receipt, reason: terminal.reason };
      }
      const successfulReceipt = { ...receipt, hash: transaction.hash };
      beforeJournalClear?.({ receipt: successfulReceipt, pending: null });
      return { kind: "confirmed" as const, hash: transaction.hash, blockNumber: successfulReceipt.blockNumber, replacedHash: null, receipt: successfulReceipt };
    });
    const fixture = service({ submit, confirm });
    const save = (next: typeof current) => { current = next; };

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: current, save, assertIntent: () => undefined, onStep: () => undefined }))
      .rejects.toThrow(/reverted or was cancelled/i);
    expect(current.pending).toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: current, save, assertIntent: () => undefined, onStep: () => undefined }))
      .resolves.toMatchObject({ id: 9n });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("retires a definite pre-provider submit failure so an explicit retry can send", async () => {
    let current = initialRecord;
    let providerCalls = 0;
    const prepare = vi.fn(async () => ({ action: { kind: "createDraft", draft } }) as PreparedAction);
    const submit = vi.fn(async () => {
      if (submit.mock.calls.length === 1) throw new SubmissionNotDispatchedError(new Error("fresh simulation failed before provider"));
      providerCalls += 1;
      return submitted;
    });
    const fixture = service({ prepare, submit });
    const save = (next: typeof current) => { current = next; };

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: current, save, assertIntent: () => undefined, onStep: () => undefined }))
      .rejects.toThrow(/fresh simulation failed before provider/i);
    expect(providerCalls).toBe(0);

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: current, save, assertIntent: () => undefined, onStep: () => undefined }))
      .resolves.toMatchObject({ id: 9n });
    expect(providerCalls).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("recovers a hashless checkpoint from an exact canonical hash without another submit", async () => {
    let current: Extract<CreateRecord, { kind: "draft" }> = { ...initialRecord, pending: { step: "createDraft", hash: null, checkpoint } };
    const submit = vi.fn();
    const resume = vi.fn();
    const pending = vi.fn(async ({ expectedIntent }: Parameters<RaffleService["pending"]>[0]) => {
      expect(expectedIntent).toBe(checkpoint.intentHash);
      return null;
    });
    const fixture = service({ submit, resume, pending });

    await recoverCreateTransaction({
      service: fixture,
      wallet: wallet(),
      record: current,
      save: next => { current = next; },
      assertIntent: () => undefined,
      hash: receipt.hash
    });

    expect(current).toMatchObject({ creationHash: receipt.hash, id: "9", pending: null });
    expect(submit).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("adopts the exact journal checkpoint after local callback state is absent and never resubmits", async () => {
    let current = initialRecord;
    const saved: Extract<CreateRecord, { kind: "draft" }>[] = [];
    const submit = vi.fn();
    const resume = vi.fn(async () => submitted);
    const fixture = service({
      submit,
      resume,
      pending: async ({ expectedIntent }) => {
        expect(expectedIntent).toBe(checkpoint.intentHash);
        return { id: checkpoint.id, hash: receipt.hash, nonce: checkpoint.nonce, checkpoint };
      }
    });

    await expect(finishCreate({
      service: fixture,
      wallet: wallet(),
      draft,
      record: current,
      save: next => { current = next; saved.push(next); },
      assertIntent: () => undefined,
      onStep: () => undefined
    })).resolves.toMatchObject({ id: 9n });

    expect(saved).toContainEqual(expect.objectContaining({ pending: { step: "createDraft", hash: receipt.hash, checkpoint } }));
    expect(submit).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("keeps a hashless checkpoint blocked when the supplied receipt has another nonce", async () => {
    const saved: Extract<CreateRecord, { kind: "draft" }> = { ...initialRecord, pending: { step: "createDraft", hash: null, checkpoint } };
    let current = saved;
    const submit = vi.fn();
    const fixture = service({
      submit,
      pending: async () => null,
      inspectOutcome: async () => ({ kind: "confirmed", hash: receipt.hash, blockNumber: receipt.blockNumber, replacedHash: null, receipt: { ...receipt, nonce: receipt.nonce + 1 } })
    });

    await expect(recoverCreateTransaction({ service: fixture, wallet: wallet(), record: current, save: next => { current = next; }, assertIntent: () => undefined, hash: receipt.hash }))
      .rejects.toThrow(/saved creation nonce/i);
    expect(current).toEqual(saved);
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps unknown hashes and receipts before the checkpoint start block pending without a send", async () => {
    const cases = [
      {
        label: "unknown",
        checkpoint,
        outcome: { kind: "unknown" as const, hash: receipt.hash, reason: "RPC has no canonical transaction" },
        message: /canonical confirmation/i
      },
      {
        label: "before-start",
        checkpoint: { ...checkpoint, startedBlock: (receipt.blockNumber + 1n).toString() },
        outcome: { kind: "confirmed" as const, hash: receipt.hash, blockNumber: receipt.blockNumber, replacedHash: null, receipt },
        message: /saved creation nonce/i
      }
    ];
    for (const value of cases) {
      const saved: Extract<CreateRecord, { kind: "draft" }> = { ...initialRecord, pending: { step: "createDraft", hash: null, checkpoint: value.checkpoint } };
      let current = saved;
      const submit = vi.fn();
      const fixture = service({ submit, pending: async () => null, inspectOutcome: async () => value.outcome });
      await expect(recoverCreateTransaction({ service: fixture, wallet: wallet(), record: current, save: next => { current = next; }, assertIntent: () => undefined, hash: receipt.hash }))
        .rejects.toThrow(value.message);
      expect(current, value.label).toEqual(saved);
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it("blocks an unrelated global journal before preparing or submitting", async () => {
    const prepare = vi.fn();
    const submit = vi.fn();
    const fixture = service({
      prepare,
      submit,
      pending: async ({ expectedIntent }) => {
        expect(expectedIntent).toBe(checkpoint.intentHash);
        throw new Error("Recover the unrelated wallet transaction before continuing this creation.");
      }
    });

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: initialRecord, save: () => undefined, assertIntent: () => undefined, onStep: () => undefined }))
      .rejects.toThrow(/unrelated wallet transaction/i);
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not accept a supplied hash for legacy hashless custody without a nonce checkpoint", async () => {
    const saved: Extract<CreateRecord, { kind: "draft" }> = { ...initialRecord, id: "9", pending: { step: "approvePrize", hash: null } };
    let current = saved;
    const inspectOutcome = vi.fn();
    const fixture = service({ pending: async () => null, inspectOutcome });

    await expect(recoverCreateTransaction({ service: fixture, wallet: wallet(), record: current, save: next => { current = next; }, assertIntent: () => undefined, hash: receipt.hash }))
      .rejects.toThrow(/older saved custody send has no nonce checkpoint/i);
    expect(current).toEqual(saved);
    expect(inspectOutcome).not.toHaveBeenCalled();
  });

  it("retires only an unsent local stage and archives its public record before a fresh explicit Create", async () => {
    const { map, storage } = memoryStorage();
    const key = "independent-create-key";
    const raw = JSON.stringify(initialRecord);
    storage.setItem(key, raw);
    const pending = vi.fn(async () => null);
    const fixture = service({ pending });

    await retireUnsentCreate({ service: fixture, wallet: wallet(), storage, key, expected: initialRecord, assertIntent: () => undefined });

    expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem(`${key}:generation`)).not.toBeNull();
    expect([...map.entries()].filter(([archive]) => archive.startsWith(`${key}:retired:`))).toEqual([[expect.any(String), raw]]);
    expect(pending).toHaveBeenCalledOnce();
  });

  it("does not reset an on-chain or globally journaled creation stage", async () => {
    const cases: { record: Extract<CreateRecord, { kind: "draft" }>; journal: Awaited<ReturnType<RaffleService["pending"]>> }[] = [
      { record: { ...initialRecord, id: "9" }, journal: null },
      { record: initialRecord, journal: { id: checkpoint.id, hash: null, nonce: checkpoint.nonce, checkpoint } }
    ];
    for (const [index, value] of cases.entries()) {
      const { storage } = memoryStorage();
      const key = `independent-protected-${index}`;
      const raw = JSON.stringify(value.record);
      storage.setItem(key, raw);
      await expect(retireUnsentCreate({ service: service({ pending: async () => value.journal }), wallet: wallet(), storage, key, expected: value.record, assertIntent: () => undefined }))
        .rejects.toThrow(/on-chain creation|unresolved wallet transaction/i);
      expect(storage.getItem(key)).toBe(raw);
      expect(storage.getItem(`${key}:generation`)).toBeNull();
    }
  });

  it("detects a null-to-null cross-tab ABA through the durable creation generation", () => {
    const { storage } = memoryStorage();
    const key = "independent-generation";
    const queued = captureCreateGeneration(storage, key);
    storage.setItem(key, JSON.stringify(initialRecord));
    advanceCreateGeneration(storage, key);
    storage.removeItem(key);

    expect(storage.getItem(key)).toBeNull();
    expect(() => assertCreateGeneration(storage, key, queued)).toThrow(/changed in another tab/i);
  });

  it("retains an ambiguous post-provider failure and blocks a blind retry", async () => {
    let current = initialRecord;
    let providerCalls = 0;
    const submit = vi.fn(async (input: Parameters<RaffleService["submit"]>[0]) => {
      input.beforeRequest?.(checkpoint);
      providerCalls += 1;
      throw new Error("The wallet response is uncertain. Check its activity.");
    });
    const fixture = service({
      pending: async () => providerCalls === 0 ? null : { id: checkpoint.id, hash: null, nonce: checkpoint.nonce, checkpoint },
      submit
    });
    const save = (next: typeof current) => { current = next; };

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: current, save, assertIntent: () => undefined, onStep: () => undefined }))
      .rejects.toThrow(/wallet response is uncertain/i);
    expect(current.pending).toEqual({ step: "createDraft", hash: null, checkpoint });

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: current, save, assertIntent: () => undefined, onStep: () => undefined }))
      .rejects.toThrow(/uncertain|recover/i);
    expect(providerCalls).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when durable coordinator storage fails before submission", async () => {
    let submitCalls = 0;
    const fixture = service({ submit: async input => { input.beforeRequest?.(checkpoint); submitCalls += 1; return submitted; } });
    const save = () => { throw new Error("independent storage failure"); };

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: initialRecord, save, assertIntent: () => undefined, onStep: () => undefined }))
      .rejects.toThrow(/independent storage failure/i);
    expect(submitCalls).toBe(0);
  });

  it("stops a queued request when its captured intent is retired", async () => {
    let active = true;
    let providerCalls = 0;
    const fixture = service({
      submit: async ({ assertIntent }) => {
        assertIntent?.();
        active = false;
        assertIntent?.();
        providerCalls += 1;
        return submitted;
      }
    });
    const save = vi.fn();

    await expect(finishCreate({
      service: fixture,
      wallet: wallet(),
      draft,
      record: initialRecord,
      save,
      assertIntent: () => { if (!active) throw new Error("intent retired"); },
      onStep: () => undefined
    })).rejects.toThrow(/intent retired/i);
    expect(providerCalls).toBe(0);
  });
});
