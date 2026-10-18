import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { BuyerActions, pollStart, SellerProgress } from "../components/workflow/RaffleWorkspace";
import { raffleAbi } from "../lib/chain/abi";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import { transactionOutcomes, type OutcomeStorage } from "../lib/chain/transaction-outcomes";
import type { AccountRaffleState, Confirmation, DeploymentManifest, OutcomeInspection, RaffleSnapshot, WalletSnapshot } from "../lib/chain/types";
import { availableActions } from "../lib/chain/workflow";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { fixtureTrust } from "./fixtures/deployment";

// Vitest compiles the page's TSX with the classic JSX runtime, which looks React up globally.
Object.assign(globalThis, { React });

const BUYER: Address ="0x1111111111111111111111111111111111111111";
const SELLER: Address = "0x4444444444444444444444444444444444444444";
const CONTRACT: Address = "0x5555555555555555555555555555555555555555";
const NOW = 1_800_000_000n;
const SALES_END = NOW + 3_600n;
const DAY = 86_400n;
const PURCHASE: Hex = `0x${"ab".repeat(32)}`;
const manifest: DeploymentManifest = { ...fixtureTrust, chainId: 31337, address: CONTRACT, usdc: SELLER, runtimeCodeHash: PURCHASE, deploymentBlock: 1n, version: 3 };

function snapshot(phase: number, raffle: Partial<RaffleSnapshot["raffle"]> = {}, rest: Partial<RaffleSnapshot> = {}): RaffleSnapshot {
  return {
    id: 1n,
    block: { number: 50n, hash: zeroHash, timestamp: NOW },
    raffle: {
      seller: SELLER, nft: CONTRACT, tokenId: 7n, salesEnd: SALES_END, createdAt: 1n, drawnAt: 0n, vrfRequestedAt: 0n, phase,
      escrowed: true, snapshotted: false, revealed: false, reserveNonce: zeroHash, reserveCommit: zeroHash, publicHash: zeroHash,
      lotCursor: 0n, snapshotTotal: 0n, principalEscrow: 0n, feeEscrow: 0n, vrfRequestId: 0n, randomWord: 0n, winner: zeroAddress,
      packCount: 1, title: "Night garden", ...raffle
    },
    packs: [{ name: "Entry", priceUsdc: 10_000_000n, bonusEntries: 1, maxSupply: 10, sold: 0, active: true }],
    policy: { ...fixtureTrust.expectedPolicy, termsHash: PUBLISHED_TERMS_HASH },
    admission: phase === 0
      ? { status: "pending", reviewHash: zeroHash, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: zeroAddress, approvedAtOpening: false } }
      : { status: "opened", reviewHash: null, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: zeroAddress, approvedAtOpening: true } },
    accounting: { grossPrincipal: 0n, buyerFees: 0n },
    lotCount: 0n, paused: false, owner: zeroAddress, ethEnabled: false,
    drawStartGrace: 7n * DAY, randomnessGrace: 7n * DAY, revealGrace: 7n * DAY,
    ...rest
  };
}

function accountState(value: RaffleSnapshot, principal = 10_000_000n): AccountRaffleState {
  return { account: BUYER, snapshot: value, principal, fee: 2_500_000n, usdcBalance: 0n, usdcAllowance: 0n, nftOwner: null, nftApproved: false };
}

function memoryStorage() {
  const map = new Map<string, string>();
  const storage: OutcomeStorage = { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); } };
  return { storage, map };
}

/** A buyer's browser. With saved, its outcome owner has re-checked a purchase checkpoint from an earlier visit, as a fresh page load does. */
async function buyerBrowser(saved?: "confirmed" | "unknown") {
  const wallet: WalletSessionPort = {
    getSnapshot: (): WalletSnapshot => ({ kind: "connected", account: BUYER, chainId: 31337, revision: 1 }),
    subscribe: () => () => {}, connect: async () => wallet.getSnapshot(), refresh: async () => wallet.getSnapshot(),
    disconnect: () => {}, assertCurrent: async () => {}, requestTransaction: async () => PURCHASE, signMessage: async () => PURCHASE
  };
  const data = encodeFunctionData({ abi: raffleAbi, functionName: "buyPack", args: [1n, 0, 1, PUBLISHED_TERMS_HASH] });
  const receipt = { hash: PURCHASE, account: BUYER, chainId: 31337, to: CONTRACT, data, value: 0n, nonce: 3, blockNumber: 40n, status: "success" as const };
  const confirmed: Confirmation = { kind: "confirmed", hash: PURCHASE, blockNumber: 40n, replacedHash: null, receipt };
  const service = {
    manifest,
    captureOutcomeLineage: () => null,
    inspectOutcome: async (): Promise<OutcomeInspection> => saved === "confirmed" ? confirmed : { kind: "unknown", hash: PURCHASE, reason: "The RPC did not answer." },
    retainOutcome: async (input: Parameters<RaffleService["retainOutcome"]>[0]) => { input.retain({ priorHash: null }); },
    acknowledgeOutcome: async (input: Parameters<RaffleService["acknowledgeOutcome"]>[0]) => { input.acknowledge(); },
    pending: async () => null
  } as unknown as RaffleService;
  const { storage, map } = memoryStorage();
  const owner = transactionOutcomes(service);
  if (saved) {
    map.set(`labx:outcome:v1:31337:${CONTRACT.toLowerCase()}:${PURCHASE}:${BUYER.toLowerCase()}:${PURCHASE}`, PURCHASE);
    vi.stubGlobal("window", { localStorage: storage });
    await owner.recover(BUYER);
    vi.unstubAllGlobals();
  }
  return { browser: { kind: "configured" as const, service, wallet }, owner, storage, map };
}

function renderBuyer(browser: Awaited<ReturnType<typeof buyerBrowser>>["browser"], value: RaffleSnapshot, account: AccountRaffleState | null) {
  return renderToStaticMarkup(createElement(BuyerActions, {
    browser, snapshot: value, account, availability: availableActions(value, account), termsHash: PUBLISHED_TERMS_HASH,
    onConfirmed: async () => {}, writesEnabled: true, updating: false
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("purchase receipt on the raffle page", () => {
  it.each([[2, "closed"], [4, "drawn"], [5, "settled"], [6, "cancelled"]] as const)("can be dismissed once the raffle is %s (%s)", async (phase, _name) => {
    const { browser, owner, storage, map } = await buyerBrowser("confirmed");
    const value = snapshot(phase, { salesEnd: NOW - DAY }, { lotCount: 1n });
    const markup = renderBuyer(browser, value, accountState(value));
    expect(markup).toContain("Purchase confirmed");
    expect(markup).toContain("1 × Entry, 1 bonus entry.");
    expect(markup).toMatch(/<button class="text-link" type="button">Dismiss<\/button>/);

    // Dismiss acknowledges the receipt, which removes the saved checkpoint, so the next load has nothing to re-check.
    const [receipt] = owner.getSnapshot(BUYER);
    vi.stubGlobal("window", { localStorage: storage });
    await owner.acknowledge(receipt, browser.wallet);
    expect(map.size).toBe(0);
    expect(renderBuyer(browser, value, accountState(value))).not.toContain("Dismiss");
  });

  it("keeps an unverified purchase out of reach of Dismiss", async () => {
    const { browser, owner, map } = await buyerBrowser("unknown");
    const value = snapshot(4, { salesEnd: NOW - DAY }, { lotCount: 1n });
    expect(owner.getSnapshot(BUYER)).toMatchObject([{ kind: "unverified", hash: PURCHASE }]);
    expect(renderBuyer(browser, value, accountState(value))).not.toContain("Dismiss");
    expect(map.size).toBe(1);
  });
});

describe("raffle page polling", () => {
  const poll = (value: RaffleSnapshot, mode: "public" | "seller" = "public", account: AccountRaffleState | null = null) =>
    pollStart(value, mode, availableActions(value, account), account, undefined);

  it("keeps re-reading after the deadline while the draw runner or the seller can still unlock a claim or refund", () => {
    const ended = { salesEnd: NOW - 60n };
    expect(poll(snapshot(1, ended, { lotCount: 2n }))).toBe(NOW);
    expect(poll(snapshot(2, ended, { lotCount: 2n }))).toBe(NOW);
    expect(poll(snapshot(3, { ...ended, vrfRequestedAt: NOW - 60n }, { lotCount: 2n }))).toBe(NOW);
    expect(poll(snapshot(4, { ...ended, drawnAt: NOW - 60n }, { lotCount: 2n }))).toBe(NOW);
    const buyer = snapshot(4, { ...ended, drawnAt: NOW - 60n }, { lotCount: 2n });
    expect(poll(buyer, "public", accountState(buyer))).toBe(NOW);
  });

  it("stops once nothing outside the page can unlock a buyer action", () => {
    const ended = { salesEnd: NOW - 60n };
    expect(poll(snapshot(5, ended, { lotCount: 2n }))).toBeNull();
    expect(poll(snapshot(6, ended, { lotCount: 2n }))).toBeNull();
    expect(poll(snapshot(1, ended))).toBeNull();
    expect(poll(snapshot(2, { salesEnd: NOW - 8n * DAY }, { lotCount: 2n }))).toBeNull();
    expect(poll(snapshot(3, { ...ended, vrfRequestedAt: NOW - 8n * DAY }, { lotCount: 2n }))).toBeNull();
  });

  it("re-reads an open checkout from the sales deadline, so it closes without a manual refresh", () => {
    expect(poll(snapshot(1))).toBe(SALES_END);
    expect(poll(snapshot(1, {}, { paused: true }))).toBe(SALES_END - 15n * 60n);
  });

  it("re-reads a draft waiting for LABx review, so List appears once it is approved", () => {
    vi.stubEnv("NEXT_PUBLIC_LABX_DRAW_RUNNER", "0");
    const waiting = snapshot(0);
    expect(poll(waiting, "seller", { ...accountState(waiting), account: SELLER })).toBe(NOW);
    const approved = snapshot(0, {}, { admission: { status: "approved", reviewHash: zeroHash, record: waiting.admission.record } });
    expect(poll(approved, "seller", { ...accountState(approved), account: SELLER })).toBeNull();
    const unlocked = snapshot(0, { escrowed: false });
    expect(poll(unlocked, "seller", { ...accountState(unlocked), account: SELLER })).toBeNull();
  });
});

describe("seller progress", () => {
  const steps = (markup: string) => [...markup.matchAll(/data-state="(\w+)"[^>]*><span class="raffle-timeline-dot"[^>]*>[^<]*<\/span><span>(.*?)<\/span>/g)]
    .map(([, state, label]) => `${label.replace(/<[^>]+>/g, "")}: ${state}`);

  it("shows a draft cancelled before listing as cancelled only", () => {
    const cancelledDraft = snapshot(6, {}, { admission: { status: "not-opened", reviewHash: null, record: { reviewRevision: 1n, approvedReviewHash: zeroHash, approvedBy: zeroAddress, approvedAtOpening: false } } });
    expect(steps(renderToStaticMarkup(createElement(SellerProgress, { snapshot: cancelledDraft })))).toEqual(["Cancelled: done"]);
  });

  it("keeps the listing history of a raffle cancelled after it was listed", () => {
    const markup = renderToStaticMarkup(createElement(SellerProgress, { snapshot: snapshot(6, { salesEnd: NOW - DAY }) }));
    expect(steps(markup)).toEqual(["Listed: done", expect.stringMatching(/^Sales closed .+: done$/), "Cancelled: done"]);
  });
});

describe("sold-out raffle page", () => {
  it("says the raffle is sold out instead of showing the checkout", async () => {
    const { browser } = await buyerBrowser();
    const value = snapshot(1, {}, { lotCount: 10n, packs: [{ name: "Entry", priceUsdc: 10_000_000n, bonusEntries: 1, maxSupply: 10, sold: 10, active: true }] });
    const markup = renderBuyer(browser, value, accountState(value, 0n));
    expect(markup).toContain("Sold out");
    expect(markup).not.toContain("Choose membership");
    expect(markup).not.toContain("Before you buy");
    expect(markup).not.toContain("Sales are paused");
  });
});
