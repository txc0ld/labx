import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, zeroAddress, zeroHash, type Address } from "viem";
import { assertCreateGeneration, captureCreateGeneration, encodeDraft, readCreateRecord, retireStaleCreate, writeCreateRecord, type CreateRecord } from "../lib/chain/create-flow";
import { cancelReclaimsPrize, purchasesToCount, sellerNextStep, sellerPortalActions, sellerSecondaryActions } from "../lib/chain/seller-actions";
import { availableActions } from "../lib/chain/workflow";
import { cardNextStep } from "../components/workflow/seller-card";
import { localDeadlineInput, localDeadlineSeconds } from "../components/workflow/deadline";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { AccountRaffleState, DraftInput, RaffleSnapshot } from "../lib/chain/types";
import { standardMembershipPacks } from "./fixtures/membership-tiers";

const SELLER = "0x1111111111111111111111111111111111111111" as Address;
const RAFFLE = "0x2222222222222222222222222222222222222222" as Address;
const NFT = "0x3333333333333333333333333333333333333333" as Address;
const NOW = 1_800_000_000n;
const hash = (label: string) => keccak256(toBytes(label));

const draft: DraftInput = {
  nft: NFT,
  tokenId: 42n,
  salesEnd: NOW + 86_400n,
  reserveNonce: hash("repair-nonce"),
  reserveCommit: hash("repair-commit"),
  title: "Studio repair raffle",
  packs: standardMembershipPacks((_tier, index) => ({ priceUsdc: 5_000_000n * BigInt(index + 1), bonusEntries: index + 1, maxSupply: 20 }))
};

function raffleSnapshot(input: { phase?: number; escrowed?: boolean; salesEnd?: bigint; title?: string; admission?: "pending" | "changed" | "approved"; lotCount?: bigint; lotCursor?: bigint } = {}): RaffleSnapshot {
  return {
    id: 9n,
    block: { number: 50n, hash: zeroHash, timestamp: NOW },
    raffle: {
      seller: SELLER, nft: draft.nft, tokenId: draft.tokenId, salesEnd: input.salesEnd ?? draft.salesEnd, createdAt: 1n, drawnAt: 0n, vrfRequestedAt: 0n,
      phase: input.phase ?? 0, escrowed: input.escrowed ?? false, snapshotted: false, revealed: false,
      reserveNonce: draft.reserveNonce, reserveCommit: draft.reserveCommit, publicHash: zeroHash, lotCursor: input.lotCursor ?? 0n, snapshotTotal: 0n,
      principalEscrow: 0n, feeEscrow: 0n, vrfRequestId: 0n, randomWord: 0n, winner: zeroAddress, packCount: draft.packs.length, title: input.title ?? draft.title
    },
    admission: { status: input.admission ?? "pending", reviewHash: zeroHash, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: zeroAddress, approvedAtOpening: false } },
    packs: draft.packs.map(pack => ({ ...pack, sold: 0, active: true })),
    policy: { treasury: zeroAddress, termsHash: zeroHash, coordinator: zeroAddress, keyHash: zeroHash, subscriptionId: 1n, callbackGasLimit: 500_000, requestConfirmations: 3, nativePayment: true, buyerFeeBps: 200, sellerFeeBps: 200, minBuyerFeeUsdc: 2_500_000n },
    accounting: { grossPrincipal: 0n, buyerFees: 0n },
    lotCount: input.lotCount ?? 0n,
    paused: false,
    owner: RAFFLE,
    ethEnabled: false,
    drawStartGrace: 604_800n,
    randomnessGrace: 604_800n,
    revealGrace: 604_800n
  } as unknown as RaffleSnapshot;
}

function sellerAccount(snapshot: RaffleSnapshot, nft: Partial<Pick<AccountRaffleState, "nftOwner" | "nftApproved">> = {}): AccountRaffleState {
  return { account: SELLER, snapshot, principal: 0n, fee: 0n, usdcBalance: 0n, usdcAllowance: 0n, nftOwner: nft.nftOwner ?? null, nftApproved: nft.nftApproved ?? false };
}

describe("a Studio Create the seller changed on the raffle page", () => {
  const key = "studio-create";
  const created: Extract<CreateRecord, { kind: "draft" }> = { kind: "draft", data: encodeDraft(draft), creationHash: hash("create-tx"), id: "9", pending: null };
  const wallet = { getSnapshot: () => ({ kind: "connected" as const, account: SELLER, chainId: 31337, revision: 1 }) } as unknown as WalletSessionPort;

  function storage() {
    const map = new Map<string, string>();
    const value: Storage = {
      get length() { return map.size; },
      clear: () => map.clear(),
      getItem: item => map.get(item) ?? null,
      key: index => [...map.keys()][index] ?? null,
      removeItem: item => { map.delete(item); },
      setItem: (item, raw) => { map.set(item, raw); }
    };
    return { map, value };
  }

  function setup(record: CreateRecord, current: RaffleSnapshot, journal: Awaited<ReturnType<RaffleService["pending"]>> = null) {
    const { map, value } = storage();
    writeCreateRecord(value, key, record);
    const clicked = captureCreateGeneration(value, key);
    const readRaffle = vi.fn(async () => current);
    const pending = vi.fn(async () => journal);
    const submit = vi.fn();
    const service = { manifest: { chainId: 31337, address: RAFFLE }, readRaffle, pending, submit, prepare: submit } as unknown as RaffleService;
    const retire = () => retireStaleCreate({ service, wallet, storage: value, key, expected: record, assertIntent: () => undefined });
    return { map, storage: value, clicked, readRaffle, pending, submit, retire };
  }

  it.each([
    { name: "edited", current: raffleSnapshot({ title: "Edited on the raffle page" }) },
    { name: "cancelled", current: raffleSnapshot({ phase: 6 }) },
    { name: "listed", current: raffleSnapshot({ phase: 1, escrowed: true }) },
    { name: "past its deadline before the NFT was locked", current: raffleSnapshot({ salesEnd: NOW }) }
  ])("lets Studio start a new raffle once the created draft was $name", async ({ current }) => {
    const fixture = setup(created, current);

    await expect(fixture.retire()).resolves.toBe(true);

    expect(fixture.storage.getItem(key)).toBeNull();
    expect([...fixture.map.entries()].filter(([item]) => item.startsWith(`${key}:retired:`)).map(([, raw]) => JSON.parse(raw))).toEqual([JSON.parse(JSON.stringify(created))]);
    expect(() => assertCreateGeneration(fixture.storage, key, fixture.clicked)).toThrow(/another tab/);
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a locked draft", current: raffleSnapshot({ escrowed: true }) },
    { name: "an unlocked draft before its deadline", current: raffleSnapshot() }
  ])("keeps the record when Create can still finish $name", async ({ current }) => {
    const fixture = setup(created, current);

    await expect(fixture.retire()).resolves.toBe(false);

    expect(readCreateRecord(fixture.storage, key)).toEqual(created);
    expect(() => assertCreateGeneration(fixture.storage, key, fixture.clicked)).not.toThrow();
  });

  it.each([
    { step: "approvePrize" as const, hash: null },
    { step: "escrow" as const, hash: hash("escrow-tx") }
  ])("never retires a saved $step send, even after the draft changed", async pending => {
    const record = { ...created, pending: { ...pending, checkpoint: { id: "send", intentHash: hash("intent"), nonce: 3, startedBlock: "40" } } };
    const fixture = setup(record, raffleSnapshot({ phase: 6 }));

    await expect(fixture.retire()).resolves.toBe(false);

    expect(readCreateRecord(fixture.storage, key)).toEqual(record);
    expect(() => assertCreateGeneration(fixture.storage, key, fixture.clicked)).not.toThrow();
  });

  it("keeps a changed draft's record while any wallet transaction is unresolved", async () => {
    const fixture = setup(created, raffleSnapshot({ phase: 6 }), { id: "unknown-send", hash: null, nonce: 3 });

    await expect(fixture.retire()).rejects.toThrow("Finish your pending wallet transaction first.");

    expect(readCreateRecord(fixture.storage, key)).toEqual(created);
    expect(() => assertCreateGeneration(fixture.storage, key, fixture.clicked)).not.toThrow();
  });

  it("keeps the record when it changed after the seller pressed Create", async () => {
    const fixture = setup(created, raffleSnapshot({ phase: 6 }));
    const newer = { ...created, lastFailure: { step: "escrow" as const, hash: hash("reverted"), nonce: 4, blockNumber: "51" } };
    writeCreateRecord(fixture.storage, key, newer);

    await expect(fixture.retire()).rejects.toThrow(/changed/);

    expect(readCreateRecord(fixture.storage, key)).toEqual(newer);
  });

  it("leaves unsent and preparing records to their existing recovery", async () => {
    for (const record of [{ ...created, id: null, creationHash: null }, { kind: "preparing" as const, data: created.data, requestIdentity: null }]) {
      const fixture = setup(record, raffleSnapshot({ phase: 6 }));
      await expect(fixture.retire()).resolves.toBe(false);
      expect(readCreateRecord(fixture.storage, key)).toEqual(record);
      expect(fixture.readRaffle).not.toHaveBeenCalled();
    }
  });
});

describe("a draft whose deadline passed before listing", () => {
  it("offers one Cancel and get NFT back click for a locked NFT", () => {
    const value = raffleSnapshot({ escrowed: true, salesEnd: NOW, admission: "approved" });
    const actions = sellerPortalActions(availableActions(value, sellerAccount(value, { nftOwner: RAFFLE })));
    const cancel = actions.find(item => item.kind === "cancel");
    const next = sellerNextStep(value, actions);

    expect(next).toEqual({ kind: "action", action: { ...cancel, label: "Cancel and get NFT back" }, message: "The sales deadline passed before listing. Cancel the draft and get your NFT back. Your wallet asks you to confirm twice. To keep the raffle, set a new deadline in Edit draft instead." });
    expect(cancelReclaimsPrize(value)).toBe(true);
    expect(sellerSecondaryActions(value, actions, next)).toEqual([]);
    expect(cardNextStep(value, SELLER)).toEqual({ label: "Cancel and get NFT back", status: "Sales deadline passed" });
  });

  it("points an unlocked draft to a new deadline, with nothing to get back", () => {
    const value = raffleSnapshot({ salesEnd: NOW });
    const actions = sellerPortalActions(availableActions(value, sellerAccount(value, { nftOwner: SELLER })));

    expect(sellerNextStep(value, actions)).toEqual({ kind: "waiting", title: "Sales deadline passed", message: "Set a new deadline in Edit draft. LABx will review the change." });
    expect(cancelReclaimsPrize(value)).toBe(false);
  });

  it("keeps cancellation secondary for a locked draft before its deadline", () => {
    const value = raffleSnapshot({ escrowed: true });
    const actions = sellerPortalActions(availableActions(value, sellerAccount(value, { nftOwner: RAFFLE })));

    expect(sellerNextStep(value, actions)).toMatchObject({ kind: "waiting", title: "Waiting for LABx review" });
    expect(cancelReclaimsPrize(value)).toBe(false);
  });
});

describe("locking an NFT into an expired draft", () => {
  it("refuses approval and Lock NFT once the deadline has passed", () => {
    const expired = raffleSnapshot({ salesEnd: NOW });
    const approved = availableActions(expired, sellerAccount(expired, { nftOwner: SELLER, nftApproved: true }));
    const unapproved = availableActions(expired, sellerAccount(expired, { nftOwner: SELLER }));
    const reason = "The sales deadline has passed. Set a new one in Edit draft before locking the NFT.";

    expect(approved.find(item => item.kind === "escrow")).toMatchObject({ enabled: false, reason });
    expect(unapproved.find(item => item.kind === "approvePrize")).toMatchObject({ enabled: false, reason });
    const actions = sellerPortalActions(approved);
    expect(sellerSecondaryActions(expired, actions, sellerNextStep(expired, actions)).map(item => item.kind)).toEqual(["cancel"]);
  });

  it("still offers both steps before the deadline", () => {
    const open = raffleSnapshot({ salesEnd: NOW + 1n });
    expect(availableActions(open, sellerAccount(open, { nftOwner: SELLER, nftApproved: true })).find(item => item.kind === "escrow")).toMatchObject({ enabled: true });
    expect(availableActions(open, sellerAccount(open, { nftOwner: SELLER })).find(item => item.kind === "approvePrize")).toMatchObject({ enabled: true });
  });
});

describe("re-saving a draft deadline", () => {
  const originalZone = process.env.TZ;
  afterEach(() => {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  });

  it("keeps the exact deadline in the repeated clock-change hour when the seller leaves it alone", () => {
    process.env.TZ = "America/New_York";
    const secondHalfPastOne = BigInt(Date.UTC(2026, 10, 1, 6, 30) / 1000);
    const shown = localDeadlineInput(secondHalfPastOne);

    expect(shown).toBe("2026-11-01T01:30");
    expect(localDeadlineSeconds(shown, secondHalfPastOne)).toBe(Number(secondHalfPastOne));
  });

  it("keeps an unchanged deadline's seconds", () => {
    process.env.TZ = "Australia/Perth";
    const withSeconds = BigInt(Date.UTC(2026, 9, 10, 9, 8, 45) / 1000);

    expect(localDeadlineSeconds(localDeadlineInput(withSeconds), withSeconds)).toBe(Number(withSeconds));
  });

  it("reads a changed deadline as the seller's local time", () => {
    process.env.TZ = "America/New_York";
    const secondHalfPastOne = BigInt(Date.UTC(2026, 10, 1, 6, 30) / 1000);

    expect(localDeadlineSeconds("2026-11-01T02:30", secondHalfPastOne)).toBe(Date.UTC(2026, 10, 1, 7, 30) / 1000);
    expect(localDeadlineSeconds("2026-03-08T02:30", secondHalfPastOne)).toBeNull();
  });
});

describe("Count entries after a partial count", () => {
  it("shows the purchases left, not the total", () => {
    expect(purchasesToCount(raffleSnapshot({ phase: 2, lotCount: 250n }))).toBe("250 purchases to count.");
    expect(purchasesToCount(raffleSnapshot({ phase: 2, lotCount: 250n, lotCursor: 100n }))).toBe("150 of 250 purchases left to count.");
    expect(purchasesToCount(raffleSnapshot({ phase: 2, lotCount: 1n }))).toBe("1 purchase to count.");
  });
});

describe("waiting for LABx review", () => {
  it("does not blame the seller for a review LABx's own changes reopened", () => {
    const value = raffleSnapshot({ escrowed: true, admission: "changed" });
    const actions = sellerPortalActions(availableActions(value, sellerAccount(value, { nftOwner: RAFFLE })));

    expect(sellerNextStep(value, actions)).toEqual({ kind: "waiting", title: "Waiting for LABx review", message: "Your NFT is locked in. LABx needs to review this raffle again before you can list it." });
  });
});
