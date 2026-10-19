import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeEventLog, erc20Abi, keccak256, toBytes, type Address } from "viem";
import type { Route } from "playwright";
import { raffleAbi } from "../lib/chain/abi";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";
import { connectWallet } from "./fixtures/connect-wallet";

const run = process.env.RUN_INDEPENDENT_BUYER_STATE_BROWSER === "1" ? describe : describe.skip;

run("independent buyer state journeys", () => {
  let chain: LocalChain;
  let service: RaffleService;
  let seller: WalletSessionPort;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  async function act(action: WorkflowAction, wallet: WalletSessionPort) {
    const prepared = await service.prepare({ action, wallet });
    const submitted = await service.submit({ prepared, wallet });
    await chain.mine();
    await chain.mine();
    expect(await service.confirm({ transaction: submitted, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
  }

  async function createOpenRaffle(tokenId: bigint, title: string, packs: DraftInput["packs"]) {
    const latest = await chain.client.getBlock();
    const reserve = keccak256(toBytes(`independent-buyer-state-${tokenId.toString()}`));
    const draft: DraftInput = {
      nft: chain.nft.address,
      tokenId,
      salesEnd: latest.timestamp + 3_600n,
      reserveNonce: reserve,
      reserveCommit: reserve,
      title,
      packs
    };
    await act({ kind: "createDraft", draft }, seller);
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    await chain.admit(id);
    const policy = await service.openingPolicy();
    await act({ kind: "open", id, expectedPolicyHash: policy.hash }, seller);
    return id;
  }

  async function openPiece(id: bigint, account: Address) {
    await fixture.switchAccount(account);
    const response = await fixture.page.goto(`${fixture.baseUrl}/piece/${id.toString()}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.locator(".wallet-identity", { hasText: `${account.slice(0, 6)}…${account.slice(-4)}` }));
  }

  beforeAll(async () => {
    chain = await localChain();
    service = chain.service;
    seller = chain.wallet(chain.seller).session;
    await seller.connect();
    await chain.write(chain.nft, "mint", [chain.seller, 951n]);
    await chain.write(chain.nft, "mint", [chain.seller, 952n]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 2_000_000_000n]);
    await chain.write(chain.usdc, "mint", [chain.stranger, 2_000_000_000n]);
    await chain.write(chain.usdc, "mint", [chain.treasury, 2_000_000_000n]);
    expect(await createOpenRaffle(951n, "Independent selection raffle", standardMembershipPacks((tier, index) => ({
      priceUsdc: [11_000_000n, 27_000_000n, 43_000_000n, 55_000_000n, 70_000_000n][index] ?? 11_000_000n,
      bonusEntries: [1, 4, 9, 12, 15][index] ?? 1,
      maxSupply: 20
    })))).toBe(1n);
    expect(await createOpenRaffle(952n, "Independent delayed confirmation", standardMembershipPacks(() => ({ priceUsdc: 12_000_000n, bonusEntries: 1, maxSupply: 20 })))).toBe(2n);
    fixture = await browserChain(chain, chain.buyer);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  it("purchases the third pack at quantity two after approval and keeps success through refresh", async () => {
    await openPiece(1n, chain.buyer);
    const silver = fixture.page.getByRole("radio", { name: /Silver/ });
    await fixture.page.locator("label.squishy-pack-card").filter({ hasText: "Silver" }).click();
    const quantity = fixture.page.getByRole("spinbutton", { name: "Quantity", exact: true });
    await quantity.fill("2");

    await fixture.page.locator(".agreements input[type=checkbox]").check();
    const buy = fixture.page.getByRole("button", { name: "Buy for 88.50 USDC", exact: true });
    await expect.poll(() => buy.isEnabled(), { timeout: 10_000 }).toBe(true);
    expect(await silver.isChecked()).toBe(true);
    expect(await quantity.inputValue()).toBe("2");
    // One click: the exact approval, then the purchase opens in the wallet once the approval confirms.
    await buy.click();

    const confirmed = fixture.page.locator(".buyer-flow .transaction-state", { hasText: "You’re in" });
    await confirmed.waitFor({ state: "visible", timeout: 15_000 });
    await confirmed.locator("summary", { hasText: "Transaction details" }).click();
    const buyAgain = confirmed.getByRole("button", { name: "Buy again", exact: true });
    await expect.poll(() => buyAgain.isEnabled(), { timeout: 15_000 }).toBe(true);
    const confirmationText = await confirmed.innerText();
    expect(confirmationText).toMatch(/Confirmed in block \d+/);
    expect(confirmationText).toMatch(/0x[0-9a-f]{64}/i);
    const refresh = fixture.page.getByRole("button", { name: "Refresh", exact: true });
    await refresh.waitFor({ state: "visible", timeout: 15_000 });
    await refresh.click();
    await fixture.page.getByRole("button", { name: "Refresh", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await expect.poll(() => buyAgain.isEnabled(), { timeout: 15_000 }).toBe(true);
    expect(await confirmed.innerText()).toBe(confirmationText);
    expect(await fixture.page.getByRole("button", { name: /^Buy for / }).count()).toBe(0);

    const snapshot = await service.readRaffle({ id: 1n });
    expect(snapshot.packs.map(pack => pack.sold)).toEqual([0, 0, 2, 0, 0]);
    expect(await service.readAccount({ id: 1n, account: chain.buyer })).toMatchObject({ principal: 86_000_000n, fee: 2_500_000n });
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "allowance", args: [chain.buyer, chain.raffle.address] })).toBe(0n);

    const purchaseEvents = (await chain.client.getLogs({ address: chain.raffle.address, fromBlock: chain.manifest.deploymentBlock }))
      .flatMap(log => {
        try {
          const event = decodeEventLog({ abi: raffleAbi, data: log.data, topics: log.topics, strict: true });
          return event.eventName === "PackPurchased" ? [event.args] : [];
        } catch { return []; }
      });
    expect(purchaseEvents).toContainEqual(expect.objectContaining({ id: 1n, buyer: chain.buyer, packId: 2, qty: 2, principal: 86_000_000n, fee: 2_500_000n }));
  }, 90_000);

  it("does not show a delayed approval confirmation under a replacement wallet", async () => {
    await openPiece(2n, chain.stranger);
    await fixture.page.locator(".agreements input[type=checkbox]").check();
    const approve = fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ });
    await expect.poll(() => approve.isEnabled(), { timeout: 10_000 }).toBe(true);
    const treasuryNonce = await chain.client.getTransactionCount({ address: chain.treasury });

    const held: Route[] = [];
    let holding = true;
    await fixture.page.route(`${chain.url}/`, async route => {
      const body: unknown = route.request().postDataJSON();
      const requests = Array.isArray(body) ? body : [body];
      const holdsReceipt = requests.some(value => typeof value === "object" && value !== null && "method" in value && value.method === "eth_getTransactionReceipt");
      if (holding && holdsReceipt) {
        held.push(route);
        return;
      }
      await route.continue();
    });
    await approve.click();
    await expect.poll(() => held.length, { timeout: 10_000 }).toBeGreaterThan(0);

    await fixture.switchAccount(chain.treasury);
    holding = false;
    await Promise.all(held.splice(0).map(route => route.continue()));
    await fixture.page.unroute(`${chain.url}/`);
    await expect.poll(() => fixture.page.locator(".wallet-identity").innerText(), { timeout: 10_000 })
      .toContain(`${chain.treasury.slice(0, 6)}…${chain.treasury.slice(-4)}`);
    await fixture.page.waitForTimeout(250);

    expect(await fixture.page.locator(".buyer-flow .transaction-state", { hasText: /Done\.|Confirmed|Opening your purchase/ }).count()).toBe(0);
    expect(await fixture.page.locator(".buyer-flow [role=alert]").allInnerTexts()).toEqual([]);
    await fixture.page.getByText("You switched wallets, so tick the box again.", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ }).waitFor({ state: "visible", timeout: 10_000 });
    // The stranger's approval never opens a purchase for the replacement wallet.
    await fixture.page.waitForTimeout(1_000);
    expect(await chain.client.getTransactionCount({ address: chain.treasury })).toBe(treasuryNonce);
    expect(await service.readAccount({ id: 2n, account: chain.stranger })).toMatchObject({ principal: 0n });
  }, 45_000);
});
