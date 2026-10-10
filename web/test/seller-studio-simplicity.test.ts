import { afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData, erc721Abi, keccak256, toBytes, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { encodeDraft, finishCreate, type CreateRecord } from "../lib/chain/create-flow";
import { transactionIntent } from "../lib/chain/pending-journal";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { CanonicalReceipt, DraftInput, RaffleSnapshot, WorkflowAction } from "../lib/chain/types";
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
