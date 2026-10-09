import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, type Address } from "viem";
import { encodeDraft, finishCreate, type CreateRecord } from "../lib/chain/create-flow";
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

function service(overrides: Partial<RaffleService> = {}): RaffleService {
  const canonical = snapshot();
  const prepared = { action: { kind: "createDraft", draft } } as PreparedAction;
  return {
    manifest: { chainId: 31337, address: raffle },
    pending: async () => null,
    prepare: async () => prepared,
    submit: async () => submitted,
    confirm: async ({ beforeJournalClear }: Parameters<RaffleService["confirm"]>[0]) => {
      beforeJournalClear?.({ receipt, pending: null });
      return { kind: "confirmed", hash: receipt.hash, blockNumber: receipt.blockNumber, replacedHash: null, receipt };
    },
    inspectOutcome: async () => ({ kind: "confirmed", hash: receipt.hash, blockNumber: receipt.blockNumber, replacedHash: null, receipt }),
    resolveCreatedDraft: async () => canonical,
    readRaffle: async () => canonical,
    readAccount: async () => ({ account: seller, snapshot: canonical, principal: 0n, fee: 0n, usdcBalance: 0n, usdcAllowance: 0n, nftOwner: raffle, nftApproved: true }),
    resume: async () => null,
    ...overrides
  } as unknown as RaffleService;
}

describe("independent create coordinator recovery boundaries", () => {
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

  it("retains an ambiguous post-provider failure and blocks a blind retry", async () => {
    let current = initialRecord;
    let providerCalls = 0;
    const submit = vi.fn(async () => {
      providerCalls += 1;
      throw new Error("The wallet response is uncertain. Check its activity.");
    });
    const fixture = service({
      pending: async () => providerCalls === 0 ? null : { id: "uncertain", hash: null, nonce: 4 },
      submit
    });
    const save = (next: typeof current) => { current = next; };

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: current, save, assertIntent: () => undefined, onStep: () => undefined }))
      .rejects.toThrow(/wallet response is uncertain/i);
    expect(current.pending).toEqual({ step: "createDraft", hash: null });

    await expect(finishCreate({ service: fixture, wallet: wallet(), draft, record: current, save, assertIntent: () => undefined, onStep: () => undefined }))
      .rejects.toThrow(/uncertain|recover/i);
    expect(providerCalls).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when durable coordinator storage fails before submission", async () => {
    let submitCalls = 0;
    const fixture = service({ submit: async () => { submitCalls += 1; return submitted; } });
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
