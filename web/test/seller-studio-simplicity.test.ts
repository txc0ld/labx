import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc721Abi, keccak256, toBytes, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { encodeDraft, finishCreate, type CreateRecord } from "../lib/chain/create-flow";
import { transactionIntent } from "../lib/chain/pending-journal";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { AccountRaffleState, CanonicalReceipt, DraftInput, HistoryItem, RaffleSnapshot, WorkflowAction } from "../lib/chain/types";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { buyerRaffleRow } from "../components/workflow/buyer-raffles";
import { cardNextStep } from "../components/workflow/seller-card";
import { createStepMessage, CREATE_STEPS } from "../components/workflow/create-progress";
import { localDeadlineInput, localDeadlineSeconds } from "../components/workflow/deadline";
import { formatDate } from "../components/workflow/format";
import { formatUsdcAmount } from "../components/workflow/usdc-amount";
import { standardMembershipPacks } from "./fixtures/membership-tiers";

const originalZone = process.env.TZ;
afterEach(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

function inZone<T>(zone: string, read: () => T): T {
  process.env.TZ = zone;
  return read();
}

describe("seller deadline in local time", () => {
  it("saves the exact instant a Perth seller chooses and shows it in UTC", () => {
    const seconds = inZone("Australia/Perth", () => localDeadlineSeconds("2026-10-10T17:08"));
    expect(seconds).toBe(Date.UTC(2026, 9, 10, 9, 8) / 1000);
    expect(formatDate(BigInt(seconds ?? 0))).toBe("10 Oct 2026, 9:08 am");
    expect(inZone("Australia/Perth", () => localDeadlineInput(seconds ?? 0))).toBe("2026-10-10T17:08");
  });

  it("matches UTC exactly for a seller in UTC", () => {
    const seconds = inZone("UTC", () => localDeadlineSeconds("2026-10-10T09:08"));
    expect(seconds).toBe(Date.UTC(2026, 9, 10, 9, 8) / 1000);
    expect(inZone("UTC", () => localDeadlineInput(BigInt(seconds ?? 0)))).toBe("2026-10-10T09:08");
  });

  it("follows daylight saving in New York and refuses a time the clock change skips", () => {
    expect(inZone("America/New_York", () => localDeadlineSeconds("2026-07-01T12:00"))).toBe(Date.UTC(2026, 6, 1, 16, 0) / 1000);
    expect(inZone("America/New_York", () => localDeadlineSeconds("2026-12-01T12:00"))).toBe(Date.UTC(2026, 11, 1, 17, 0) / 1000);
    expect(inZone("America/New_York", () => localDeadlineSeconds("2026-03-08T02:30"))).toBeNull();
    const repeated = inZone("America/New_York", () => localDeadlineSeconds("2026-11-01T01:30"));
    expect(repeated).toBe(Date.UTC(2026, 10, 1, 5, 30) / 1000);
    expect(formatDate(BigInt(repeated ?? 0))).toBe("1 Nov 2026, 5:30 am");
  });

  it("truncates an existing deadline to the minute in the seller's zone", () => {
    const salesEnd = BigInt(Date.UTC(2026, 9, 10, 9, 8, 45) / 1000);
    expect(inZone("Australia/Perth", () => localDeadlineInput(salesEnd))).toBe("2026-10-10T17:08");
    expect(inZone("Asia/Kolkata", () => localDeadlineInput(salesEnd))).toBe("2026-10-10T14:38");
  });

  it("rejects malformed and impossible dates", () => {
    for (const value of ["", "2026-10-10", "2026-10-10T9:08", "2026-02-30T10:00", "2026-10-10T24:00", "2026-10-10T17:08Z"]) {
      expect(inZone("UTC", () => localDeadlineSeconds(value))).toBeNull();
    }
  });
});

describe("USDC amounts shown to people", () => {
  it("shows at least two decimals and keeps finer precision", () => {
    expect(formatUsdcAmount(12_500_000n)).toBe("12.50");
    expect(formatUsdcAmount(78_400_000n)).toBe("78.40");
    expect(formatUsdcAmount(0n)).toBe("0.00");
    expect(formatUsdcAmount(1_000_000_000_000n)).toBe("1,000,000.00");
    expect(formatUsdcAmount(1n)).toBe("0.000001");
  });
});

describe("Create progress", () => {
  const seller = "0x1111111111111111111111111111111111111111" as Address;
  const raffle = "0x2222222222222222222222222222222222222222" as Address;
  const nft = "0x3333333333333333333333333333333333333333" as Address;
  const hash = (label: string) => keccak256(toBytes(label));
  const draft: DraftInput = {
    nft,
    tokenId: 501n,
    salesEnd: 1_900_000_000n,
    reserveNonce: hash("progress-nonce"),
    reserveCommit: hash("progress-commit"),
    title: "Progress raffle",
    packs: standardMembershipPacks((_tier, index) => ({ priceUsdc: 1_000_000n * BigInt(index + 1), bonusEntries: index + 1, maxSupply: 10 }))
  };

  function harness() {
    const state = { escrowed: false, approved: false, nonce: 0 };
    const snapshot = () => ({
      id: 9n,
      packs: draft.packs,
      raffle: { seller, nft, tokenId: draft.tokenId, salesEnd: draft.salesEnd, reserveNonce: draft.reserveNonce, reserveCommit: draft.reserveCommit, title: draft.title, phase: 0, escrowed: state.escrowed }
    }) as unknown as RaffleSnapshot;
    const expected = (action: WorkflowAction) => action.kind === "createDraft"
      ? { to: raffle, data: encodeDraft(draft) }
      : action.kind === "approvePrize"
        ? { to: nft, data: encodeFunctionData({ abi: erc721Abi, functionName: "approve", args: [raffle, draft.tokenId] }) }
        : { to: raffle, data: encodeFunctionData({ abi: raffleAbi, functionName: "escrow", args: [9n] }) };
    let receipt: CanonicalReceipt | null = null;
    const service = {
      manifest: { chainId: 31337, address: raffle },
      pending: async () => null,
      prepare: async ({ action }: { action: WorkflowAction }) => ({ action }),
      submit: async ({ prepared, beforeRequest }: { prepared: { action: WorkflowAction }; beforeRequest?: (checkpoint: unknown) => void }) => {
        const call = expected(prepared.action);
        const nonce = state.nonce++;
        beforeRequest?.({ id: `progress-${nonce}`, intentHash: transactionIntent({ ...call, value: 0n }), nonce, startedBlock: "1" });
        receipt = { hash: hash(`progress-${nonce}`) as Hex, account: seller, chainId: 31337, to: call.to, data: call.data, value: 0n, nonce, blockNumber: 10n + BigInt(nonce), status: "success" };
        if (prepared.action.kind === "approvePrize") state.approved = true;
        if (prepared.action.kind === "escrow") state.escrowed = true;
        return { hash: receipt.hash, account: seller, chainId: 31337, to: call.to, data: call.data, value: 0n };
      },
      confirm: async ({ beforeJournalClear }: { beforeJournalClear?: (input: { receipt: CanonicalReceipt; pending: null }) => void }) => {
        if (!receipt) throw new Error("No submitted transaction.");
        beforeJournalClear?.({ receipt, pending: null });
        return { kind: "confirmed", hash: receipt.hash, blockNumber: receipt.blockNumber, replacedHash: null, receipt };
      },
      resolveCreatedDraft: async () => snapshot(),
      readAccount: async () => ({ account: seller, snapshot: snapshot(), principal: 0n, fee: 0n, usdcBalance: 0n, usdcAllowance: 0n, nftOwner: state.escrowed ? raffle : seller, nftApproved: state.approved })
    } as unknown as RaffleService;
    const connected = { kind: "connected" as const, account: seller, chainId: 31337, revision: 1 };
    const wallet = {
      getSnapshot: () => connected,
      assertCurrent: async () => undefined
    } as unknown as WalletSessionPort;
    return { service, wallet };
  }

  it("numbers every wallet prompt that Create reports, with the NFT's token ID", async () => {
    const { service, wallet } = harness();
    let record: Extract<CreateRecord, { kind: "draft" }> = { kind: "draft", data: encodeDraft(draft), creationHash: null, id: null, pending: null };
    const shown: string[] = [CREATE_STEPS.saveSetup];
    await finishCreate({ service, wallet, draft, record, save: next => { record = next; }, assertIntent: () => undefined, onStep: step => shown.push(createStepMessage(step, draft.tokenId)) });
    expect(shown).toEqual([
      "Step 1 of 4: sign in your wallet to save your raffle setup.",
      "Step 2 of 4: confirm in your wallet to create the raffle.",
      "Step 3 of 4: approve NFT #501 in your wallet.",
      "Step 4 of 4: confirm in your wallet to lock the NFT."
    ]);
  });

  it("passes unknown steps through unchanged", () => {
    expect(createStepMessage("Checking the saved creation transaction…", 1n)).toBe("Checking the saved creation transaction…");
  });
});

const SELLER = "0x1111111111111111111111111111111111111111" as Address;
const BUYER = "0x4444444444444444444444444444444444444444" as Address;
const NOW = 1_800_000_000n;
const TIER_PACKS = [
  { name: "Entry", priceUsdc: 12_500_000n, bonusEntries: 1, maxSupply: 100, sold: 0, active: true },
  { name: "Gold", priceUsdc: 100_000_000n, bonusEntries: 10, maxSupply: 10, sold: 0, active: true }
];

function raffleSnapshot(input: { phase: number; escrowed?: boolean; salesEnd?: bigint; admission?: "pending" | "approved" | "opened"; lotCount?: bigint; principalEscrow?: bigint; winner?: Address; revealed?: boolean; snapshotted?: boolean; snapshotTotal?: bigint; packs?: typeof TIER_PACKS }): RaffleSnapshot {
  return {
    id: 7n,
    block: { number: 50n, hash: zeroHash, timestamp: NOW },
    raffle: {
      seller: SELLER, nft: zeroAddress, tokenId: 7n, salesEnd: input.salesEnd ?? NOW + 3_600n, createdAt: 1n, drawnAt: 0n, vrfRequestedAt: 0n,
      phase: input.phase, escrowed: input.escrowed ?? true, snapshotted: input.snapshotted ?? false, revealed: input.revealed ?? false,
      reserveNonce: zeroHash, reserveCommit: zeroHash, publicHash: zeroHash, lotCursor: 0n, snapshotTotal: input.snapshotTotal ?? 0n,
      principalEscrow: input.principalEscrow ?? 0n, feeEscrow: 0n, vrfRequestId: 0n, randomWord: 0n, winner: input.winner ?? zeroAddress, packCount: 2, title: "Copper Moon"
    },
    admission: { status: input.admission ?? "opened", reviewHash: zeroHash, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: zeroAddress, approvedAtOpening: true } },
    packs: input.packs ?? TIER_PACKS,
    policy: { treasury: zeroAddress, termsHash: PUBLISHED_TERMS_HASH, coordinator: zeroAddress, keyHash: zeroHash, subscriptionId: 1n, callbackGasLimit: 500_000, requestConfirmations: 3, nativePayment: true, buyerFeeBps: 200, sellerFeeBps: 200, minBuyerFeeUsdc: 2_500_000n },
    accounting: { grossPrincipal: 0n, buyerFees: 0n },
    lotCount: input.lotCount ?? 0n,
    paused: false,
    owner: zeroAddress,
    ethEnabled: false,
    drawStartGrace: 604_800n,
    randomnessGrace: 604_800n,
    revealGrace: 604_800n
  } as unknown as RaffleSnapshot;
}

describe("Studio card next step", () => {
  it("names the step the raffle page will offer", () => {
    expect(cardNextStep(raffleSnapshot({ phase: 0, escrowed: false }), SELLER)).toEqual({ label: "Finish creating", status: "Prize not locked yet" });
    expect(cardNextStep(raffleSnapshot({ phase: 0, admission: "pending" }), SELLER)).toMatchObject({ label: "View" });
    expect(cardNextStep(raffleSnapshot({ phase: 0, admission: "approved" }), SELLER)).toEqual({ label: "List", status: "Approved by LABx" });
    expect(cardNextStep(raffleSnapshot({ phase: 1 }), SELLER)).toMatchObject({ label: "View" });
    expect(cardNextStep(raffleSnapshot({ phase: 1, salesEnd: NOW, lotCount: 3n }), SELLER)).toEqual({ label: "Close sales", status: "Sales ended" });
    expect(cardNextStep(raffleSnapshot({ phase: 2, salesEnd: NOW, lotCount: 3n }), SELLER)).toEqual({ label: "Count entries", status: "Sales closed" });
    expect(cardNextStep(raffleSnapshot({ phase: 2, salesEnd: NOW, lotCount: 3n, snapshotted: true, snapshotTotal: 3n }), SELLER)).toEqual({ label: "Start draw", status: "Entries counted" });
    expect(cardNextStep(raffleSnapshot({ phase: 5, principalEscrow: 78_400_000n }), SELLER)).toEqual({ label: "Claim 78.40 USDC", status: "Raffle finished" });
    expect(cardNextStep(raffleSnapshot({ phase: 5 }), SELLER)).toMatchObject({ label: "View" });
  });

  it("offers Cancel and get NFT back for an unsold raffle and Enable refunds once memberships sold", () => {
    const expired = NOW - 604_800n;
    expect(cardNextStep(raffleSnapshot({ phase: 1, salesEnd: expired }), SELLER)).toEqual({ label: "Cancel and get NFT back", status: "No memberships were sold." });
    expect(cardNextStep(raffleSnapshot({ phase: 1, salesEnd: expired, lotCount: 2n }), SELLER)).toMatchObject({ label: "Enable refunds" });
    expect(cardNextStep(raffleSnapshot({ phase: 6 }), SELLER)).toEqual({ label: "Reclaim NFT", status: "Raffle cancelled" });
  });

  it("does not offer Finish creating for an expired draft", () => {
    expect(cardNextStep(raffleSnapshot({ phase: 0, escrowed: false, salesEnd: NOW }), SELLER)).toMatchObject({ label: "View" });
  });

  it("leaves closing, counting, starting and finishing to LABx when the draw runner is on", () => {
    const draw = "LABx closes sales and starts the draw automatically. This usually takes a few minutes.";
    const closing = raffleSnapshot({ phase: 1, salesEnd: NOW, lotCount: 3n });
    const counting = raffleSnapshot({ phase: 2, salesEnd: NOW, lotCount: 3n });
    const starting = raffleSnapshot({ phase: 2, salesEnd: NOW, lotCount: 3n, snapshotted: true, snapshotTotal: 3n });
    const finishing = raffleSnapshot({ phase: 4, salesEnd: NOW - 60n, lotCount: 3n, revealed: true });
    for (const value of [closing, counting, starting]) expect(cardNextStep(value, SELLER, true)).toEqual({ label: "View", status: draw });
    expect(cardNextStep(finishing, SELLER, true)).toEqual({ label: "View", status: "LABx finishes the raffle automatically after you confirm the draw." });
    expect(cardNextStep(finishing, SELLER, false)).toEqual({ label: "Finish raffle", status: "Draw confirmed" });
    const unconfirmed = raffleSnapshot({ phase: 4, salesEnd: NOW - 60n, lotCount: 3n });
    expect(cardNextStep({ ...unconfirmed, raffle: { ...unconfirmed.raffle, drawnAt: NOW } }, SELLER, true)).toEqual({ label: "Confirm the draw", status: "Winner drawn" });
    expect(cardNextStep(raffleSnapshot({ phase: 5, principalEscrow: 78_400_000n }), SELLER, true)).toEqual({ label: "Claim 78.40 USDC", status: "Raffle finished" });
    expect(cardNextStep(raffleSnapshot({ phase: 6 }), SELLER, true)).toEqual({ label: "Reclaim NFT", status: "Raffle cancelled" });
    expect(cardNextStep(raffleSnapshot({ phase: 1, salesEnd: NOW - 604_800n }), SELLER, true)).toMatchObject({ label: "Cancel and get NFT back" });
  });

  it("reads the draw runner flag and keeps manual steps when it is off", () => {
    const closing = raffleSnapshot({ phase: 1, salesEnd: NOW, lotCount: 3n });
    try {
      vi.stubEnv("NEXT_PUBLIC_LABX_DRAW_RUNNER", undefined);
      expect(cardNextStep(closing, SELLER)).toEqual({ label: "Close sales", status: "Sales ended" });
      vi.stubEnv("NEXT_PUBLIC_LABX_DRAW_RUNNER", "1");
      expect(cardNextStep(closing, SELLER)).toMatchObject({ label: "View" });
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("Profile raffle rows", () => {
  const purchase = (quantity: number, principal: bigint, bonusEntries: number, blockNumber = 10n): HistoryItem => ({
    raffleId: 7n, event: "PackPurchased", transactionHash: zeroHash, logIndex: 0, blockNumber, account: BUYER, principal, fee: 2_500_000n, quantity, bonusEntries
  });
  const account = (snapshot: RaffleSnapshot, principal = 0n): AccountRaffleState => ({ account: BUYER, snapshot, principal, fee: 0n, usdcBalance: 0n, usdcAllowance: 0n, nftOwner: null, nftApproved: false });

  it("names tiers from the published packs and offers the winner's claim", () => {
    const row = buyerRaffleRow([purchase(1, 100_000_000n, 10), purchase(4, 50_000_000n, 4, 11n)], account(raffleSnapshot({ phase: 5, winner: BUYER })));
    expect(row).toEqual({ id: 7n, title: "Copper Moon", status: "You won", memberships: "Gold × 1 · Entry × 4", entries: 14, action: "Claim your NFT" });
  });

  it("offers the refund amount for a cancelled raffle and no action once refunded", () => {
    const cancelled = raffleSnapshot({ phase: 6, escrowed: false });
    expect(buyerRaffleRow([purchase(2, 25_000_000n, 2)], account(cancelled, 25_000_000n))).toMatchObject({ status: "Cancelled", memberships: "Entry × 2", action: "Claim 25.00 USDC refund" });
    expect(buyerRaffleRow([purchase(2, 25_000_000n, 2)], account(cancelled, 0n))).toMatchObject({ action: null });
  });

  it("does not guess a tier when two packs share a price and bonus entries", () => {
    const twins = [TIER_PACKS[0], { ...TIER_PACKS[0], name: "Bronze" }];
    expect(buyerRaffleRow([purchase(1, 12_500_000n, 1)], account(raffleSnapshot({ phase: 1, packs: twins }))).memberships).toBe("Membership × 1");
  });
});
