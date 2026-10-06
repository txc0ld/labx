import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { createReserve } from "../lib/reserve";
import { MemoryStore } from "../lib/store";
import type { WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_BROWSER_ACCEPTANCE === "1" ? describe : describe.skip;

run("independent rendered catalog states on isolated Anvil", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let seller: WalletSessionPort;
  let buyer: WalletSessionPort;

  beforeAll(async () => {
    chain = await localChain();
    seller = chain.wallet(chain.seller).session;
    buyer = chain.wallet(chain.buyer).session;
    await Promise.all([seller.connect(), buyer.connect()]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
    fixture = await browserChain(chain);
    await fixture.context.addInitScript(() => window.sessionStorage.setItem("labx:brand-intro:shown", "1"));
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  async function act(action: WorkflowAction, wallet: WalletSessionPort) {
    const prepared = await chain.service.prepare({ action, wallet });
    const transaction = await chain.service.submit({ prepared, wallet });
    await chain.mine();
    expect(await chain.service.confirm({ transaction, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
  }

  async function createOpen(tokenId: bigint, title: string, salesEnd: bigint, maxSupply: number) {
    await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    const commitment = await createReserve(new MemoryStore(), {
      seller: chain.seller,
      nft: chain.nft.address,
      tokenId: tokenId.toString(),
      publicSummary: title,
      privateCommitment: `Independent ${title}`,
      chainId: 31337n,
      labx: chain.raffle.address
    });
    const draft: DraftInput = {
      nft: chain.nft.address,
      tokenId,
      salesEnd,
      reserveNonce: commitment.nonce,
      reserveCommit: commitment.commit,
      title,
      packs: [{ name: "Membership", priceUsdc: 10_000_000n, bonusEntries: 2, maxSupply }]
    };
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await act({ kind: "createDraft", draft }, seller);
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    const policy = await chain.service.openingPolicy();
    await act({ kind: "open", id, expectedPolicyHash: policy.hash }, seller);
    return id;
  }

  async function loadCatalog() {
    const response = await fixture.page.goto(`${fixture.baseUrl}/`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.locator("#bench").waitFor({ state: "visible" });
  }

  it("renders zero, one and multiple records while filtering expired and exhausted raffles from Open at one authoritative snapshot", async () => {
    await loadCatalog();
    await fixture.page.getByRole("heading", { name: "No raffles listed", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    const initial = await chain.client.getBlock();
    const expiring = await createOpen(601n, "Expiring raffle", initial.timestamp + 300n, 2);
    expect(expiring).toBe(1n);
    await loadCatalog();
    await expect.poll(async () => fixture.page.locator(".capsule-grid > li").count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(async () => fixture.page.locator("a.raffle-capsule", { hasText: "Expiring raffle" }).innerText()).toMatch(/open/i);

    const later = initial.timestamp + 1_800n;
    const exhausted = await createOpen(602n, "Exhausted raffle", later, 1);
    const available = await createOpen(603n, "Available raffle", later, 3);
    await act({ kind: "approveUsdc", id: exhausted, packId: 0, quantity: 1 }, buyer);
    await act({
      kind: "buyMembership",
      id: exhausted,
      packId: 0,
      quantity: 1,
      acceptedTerms: PUBLISHED_TERMS_HASH,
      agreements: { terms: true, rules: true, age: true },
      payment: { kind: "usdc" }
    }, buyer);
    await chain.warp(initial.timestamp + 300n);

    await loadCatalog();
    await expect.poll(async () => fixture.page.locator(".capsule-grid > li").count(), { timeout: 10_000 }).toBe(3);
    const cards = fixture.page.locator("a.raffle-capsule");
    await expect.poll(async () => cards.filter({ hasText: "Expiring raffle" }).innerText()).toMatch(/sales ended/i);
    await expect.poll(async () => cards.filter({ hasText: "Exhausted raffle" }).innerText()).toMatch(/sold out/i);
    await expect.poll(async () => cards.filter({ hasText: "Available raffle" }).innerText()).toMatch(/open/i);

    await fixture.page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.poll(async () => fixture.page.locator(".capsule-grid > li").count()).toBe(1);
    expect(await fixture.page.locator(".capsule-grid").innerText()).toContain("Available raffle");
    expect(await fixture.page.locator(".capsule-grid").innerText()).not.toMatch(/Expiring raffle|Exhausted raffle/);

    await fixture.page.getByRole("button", { name: "Ended", exact: true }).click();
    await expect.poll(async () => fixture.page.locator(".capsule-grid > li").count()).toBe(2);
    const endedText = await fixture.page.locator(".capsule-grid").innerText();
    expect(endedText).toMatch(/Expiring raffle/);
    expect(endedText).toMatch(/Exhausted raffle/);
    expect(endedText).not.toMatch(/Available raffle/);
    expect(available).toBe(3n);
  }, 60_000);
});
