import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, numberToHex, toBytes, type Address, type Hex } from "viem";
import type { Route } from "playwright";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { formatUsdcAmount } from "../components/workflow/format";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { connectWallet } from "./fixtures/connect-wallet";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";
import { watchWallet, type WalletRequest } from "./fixtures/wallet-watch";

const run = process.env.RUN_FRONTEND_CONSISTENCY_BROWSER === "1" ? describe : describe.skip;

const PRICE = 10_000_000n;
/** The membership price plus the 2.50 USDC minimum processing fee. */
const TOTAL = PRICE + 2_500_000n;
const APPROVE = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x0000000000000000000000000000000000000000", 0n] }).slice(0, 10);
const CLOSE = encodeFunctionData({ abi: raffleAbi, functionName: "close", args: [0n] }).slice(0, 10);
const GET_RAFFLE = encodeFunctionData({ abi: raffleAbi, functionName: "getRaffle", args: [0n] }).slice(0, 10);

type RpcRequest = { method: string; params: unknown[] };
/** The page's read transport sends one JSON-RPC request per HTTP request. */
function rpcRequest(route: Route): RpcRequest | null {
  const body: unknown = route.request().postDataJSON();
  return body && typeof body === "object" && "method" in body && typeof body.method === "string" && "params" in body && Array.isArray(body.params)
    ? { method: body.method, params: body.params } : null;
}

/**
 * The audit's sequences in docs/audits/frontend-consistency.md, in a rendered browser on a local chain: reads that arrive
 * late, out of order or from a node behind the chain, a failed read followed by a retry, account switching and disconnect.
 */
run("frontend consistency sequences", () => {
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

  async function createDraft(tokenId: bigint, title: string, salesSeconds: bigint) {
    const latest = await chain.client.getBlock();
    const reserve = keccak256(toBytes(`frontend-consistency-${tokenId.toString()}`));
    const draft: DraftInput = { nft: chain.nft.address, tokenId, salesEnd: latest.timestamp + salesSeconds, reserveNonce: reserve, reserveCommit: reserve, title,
      packs: standardMembershipPacks(() => ({ priceUsdc: PRICE, bonusEntries: 1, maxSupply: 20 })) };
    await act({ kind: "createDraft", draft }, seller);
    return await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
  }

  async function createOpenRaffle(tokenId: bigint, title: string, salesSeconds: bigint) {
    const id = await createDraft(tokenId, title, salesSeconds);
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    await chain.admit(id);
    const policy = await service.openingPolicy();
    await act({ kind: "open", id, expectedPolicyHash: policy.hash }, seller);
    return id;
  }

  const identity = (account: Address) => fixture.page.locator(".wallet-identity", { hasText: `${account.slice(0, 6)}…${account.slice(-4)}` });
  async function openPiece(id: bigint, account: Address) {
    await fixture.switchAccount(account);
    const response = await fixture.page.goto(`${fixture.baseUrl}/piece/${id.toString()}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, identity(account).or(fixture.page.getByText("Membership price paid", { exact: true })).first());
  }
  /**
   * While `behind` is set, the page's RPC answers "latest" with that block, as a load-balanced node behind the chain does.
   * `only` limits that to the reads it returns true for.
   */
  async function lagLatest(only: () => Promise<boolean> = async () => true) {
    const lag = { behind: null as Hex | null, staleReads: 0 };
    await fixture.page.route(`${chain.url}/`, async route => {
      const request = rpcRequest(route);
      if (lag.behind && request?.method === "eth_getBlockByNumber" && request.params[0] === "latest" && await only()) {
        lag.staleReads++;
        await route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), params: [lag.behind, request.params[1]] }) });
        return;
      }
      await route.continue();
    });
    return lag;
  }
  /** The block of the raffle the page shows, from "State block" under Contract and review details. */
  const stateBlock = () => fixture.page.evaluate(() => {
    const term = [...document.querySelectorAll("dt")].find(item => item.textContent === "State block");
    return BigInt(term?.nextElementSibling?.textContent ?? "0").toString();
  }).then(BigInt);
  const agreement = () => fixture.page.getByRole("checkbox", { name: /I’m 18 or older and agree to the membership terms and draw rules/ });
  const buy = () => fixture.page.getByRole("button", { name: `Buy for ${formatUsdcAmount(TOTAL)} USDC`, exact: true });
  const opening = () => fixture.page.getByRole("button", { name: "Approved. Opening your purchase…", exact: true });
  const youreIn = () => fixture.page.locator(".purchase-receipt", { hasText: "You’re in" });
  /** Sends the approval and returns its block. It stays one block deep until the test mines its second confirmation. */
  async function approvalBlock(wallet: Awaited<ReturnType<typeof watchWallet>>) {
    await buy().click();
    await expect.poll(async () => (await wallet.requests())[0]?.hash, { timeout: 20_000 }).toBeTruthy();
    return (await chain.client.getTransactionReceipt({ hash: (await wallet.requests())[0].hash as Hex })).blockNumber;
  }
  function call(request: WalletRequest) {
    if (request.data?.startsWith(APPROVE)) return { name: "approve", args: decodeFunctionData({ abi: erc20Abi, data: request.data as Hex }).args };
    return { name: "buyPack", args: decodeFunctionData({ abi: raffleAbi, data: request.data as Hex }).args };
  }

  beforeAll(async () => {
    chain = await localChain();
    service = chain.service;
    seller = chain.wallet(chain.seller).session;
    await seller.connect();
    for (let tokenId = 1n; tokenId <= 13n; tokenId++) await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 2_000_000_000n]);
    await chain.write(chain.usdc, "mint", [chain.stranger, 2_000_000_000n]);
    await chain.write(chain.usdc, "mint", [chain.treasury, 2_000_000_000n]);
    await chain.write(chain.usdc, "mint", [chain.operator, 2_000_000_000n]);
    expect(await createOpenRaffle(1n, "Lagging read raffle", 7_200n)).toBe(1n);
    expect(await createOpenRaffle(2n, "Late poll raffle", 3_600n)).toBe(2n);
    // Thirteen raffles: one more than the catalog's first page.
    for (let tokenId = 3n; tokenId <= 13n; tokenId++) expect(await createDraft(tokenId, `Catalog raffle ${tokenId.toString()}`, 7_200n)).toBe(tokenId);
    // The stranger holds one membership of raffle 2; the treasury account has no activity.
    await chain.write(chain.usdc, "approve", [chain.raffle.address, TOTAL], chain.stranger);
    await chain.write(chain.raffle, "buyPack", [2n, 0, 1, PUBLISHED_TERMS_HASH], chain.stranger);
    fixture = await browserChain(chain, chain.buyer);
    await fixture.context.addInitScript(() => window.sessionStorage.setItem("labx:brand-intro:shown", "1"));
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  it("opens the purchase after its approval when the first re-read comes from a node behind the approval", async () => {
    await openPiece(1n, chain.buyer);
    const wallet = await watchWallet(fixture.page);
    await agreement().check();
    const lag = await lagLatest();
    fixture.setMineConfirmation(false);
    try {
      lag.behind = numberToHex(await approvalBlock(wallet) - 1n);
      await chain.mine();
      await opening().waitFor({ state: "visible", timeout: 30_000 });
      await expect.poll(() => lag.staleReads, { timeout: 15_000 }).toBeGreaterThan(0);
      await fixture.page.waitForTimeout(2_500);
    } finally {
      // The node catches up.
      lag.behind = null;
      fixture.setMineConfirmation(true);
    }
    try {
      // No click and no second approval: the page reads again and the purchase opens in the wallet.
      await youreIn().waitFor({ state: "visible", timeout: 30_000 });
      expect((await wallet.requests()).map(call)).toEqual([
        { name: "approve", args: [chain.raffle.address, TOTAL] },
        { name: "buyPack", args: [1n, 0, 1, PUBLISHED_TERMS_HASH] }
      ]);
    } finally {
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 120_000);

  it("clears the load-more error once more raffles load", async () => {
    await fixture.page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    const more = fixture.page.getByRole("button", { name: "Load more raffles", exact: true });
    await more.waitFor({ state: "visible", timeout: 20_000 });
    await fixture.page.waitForLoadState("networkidle");
    const failed = fixture.page.getByText("More raffles could not be loaded. Refresh and retry.", { exact: true });
    await fixture.page.route(`${chain.url}/`, route => route.abort());
    try {
      await more.click();
      await failed.waitFor({ state: "visible", timeout: 20_000 });
    } finally {
      await fixture.page.unroute(`${chain.url}/`);
    }
    await more.click();
    // The thirteenth raffle is the whole second page, so the button goes away with it.
    await fixture.page.getByRole("heading", { name: "Catalog raffle 13", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    expect(await more.count()).toBe(0);
    expect(await failed.count()).toBe(0);
  }, 90_000);

  it("drops an account history read that returns after the wallet switched accounts", async () => {
    // History reads every contract event and keeps the account's own, so the first log read is the stranger's.
    const held: Route[] = [];
    let armed = true;
    await fixture.page.route(`${chain.url}/`, async route => {
      if (armed && rpcRequest(route)?.method === "eth_getLogs") { armed = false; held.push(route); return; }
      await route.continue();
    });
    try {
      await fixture.switchAccount(chain.stranger);
      await fixture.page.goto(`${fixture.baseUrl}/profile/history`, { waitUntil: "domcontentloaded" });
      await connectWallet(fixture.page, identity(chain.stranger));
      await expect.poll(() => held.length, { timeout: 20_000 }).toBe(1);
      await fixture.switchAccount(chain.treasury);
      await identity(chain.treasury).waitFor({ state: "visible", timeout: 15_000 });
      await fixture.page.getByRole("heading", { name: "No activity yet", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      // The stranger's purchase arrives while the other account's empty history is shown.
      await held[0].continue();
      expect((await held[0].request().response())?.ok()).toBe(true);
      await fixture.page.waitForTimeout(3_000);
      expect(await fixture.page.getByText("Membership purchased", { exact: true }).count()).toBe(0);
      expect(await fixture.page.getByRole("heading", { name: "No activity yet", exact: true }).count()).toBe(1);
      await fixture.switchAccount(chain.stranger);
      await fixture.page.getByText("Membership purchased", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    } finally {
      armed = false;
      for (const route of held) await route.continue().catch(() => {});
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 90_000);

  it("clears the account's data on disconnect and stays disconnected after a reload", async () => {
    await fixture.switchAccount(chain.stranger);
    await fixture.page.goto(`${fixture.baseUrl}/profile`, { waitUntil: "domcontentloaded" });
    const disconnect = fixture.page.getByRole("button", { name: "Disconnect wallet", exact: true });
    await connectWallet(fixture.page, disconnect);
    const raffles = fixture.page.getByRole("region", { name: "Your raffles" });
    await raffles.getByRole("link", { name: "Late poll raffle", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await fixture.page.getByText(/^Points \d+$/).waitFor({ state: "visible", timeout: 10_000 });

    // Records any render that shows the disconnected message together with the previous account's raffles.
    await fixture.page.evaluate(() => {
      const scope = window as unknown as { __labxStaleRaffles?: boolean };
      scope.__labxStaleRaffles = false;
      new MutationObserver(() => {
        const region = document.querySelector("section[aria-labelledby=buyer-raffles-title]");
        if (region?.textContent?.includes("Connect your wallet to see your raffles.") && region.querySelector("a[href^='/piece/']")) scope.__labxStaleRaffles = true;
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await disconnect.click();
    await fixture.page.getByText("Wallet not connected", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await raffles.getByText("Connect your wallet to see your raffles.", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => raffles.getByRole("link", { name: "Late poll raffle", exact: true }).count(), { timeout: 10_000 }).toBe(0);
    expect(await fixture.page.evaluate(() => (window as unknown as { __labxStaleRaffles?: boolean }).__labxStaleRaffles)).toBe(false);
    expect(await fixture.page.getByText(/^Points/).count()).toBe(0);

    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("button", { name: "Connect wallet", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.waitForTimeout(3_000);
    expect(await fixture.page.getByText("Wallet not connected", { exact: true }).count()).toBe(1);
    expect(await raffles.getByRole("link", { name: "Late poll raffle", exact: true }).count()).toBe(0);
  }, 90_000);

  it("opens the purchase after its approval when only the price quote comes from a node behind the approval", async () => {
    await openPiece(1n, chain.treasury);
    const wallet = await watchWallet(fixture.page);
    await agreement().check();
    // Only reads made once the page shows the raffle at or after the approval lag: the raffle read is current, the quote is not.
    let approved = 0n;
    const lag = await lagLatest(async () => approved > 0n && await stateBlock() >= approved);
    fixture.setMineConfirmation(false);
    try {
      approved = await approvalBlock(wallet);
      lag.behind = numberToHex(approved - 1n);
      await chain.mine();
      await expect.poll(async () => lag.staleReads > 0 && await stateBlock() >= approved, { timeout: 30_000 }).toBe(true);
      await fixture.page.waitForTimeout(3_000);
      expect(await opening().count()).toBe(1);
    } finally {
      lag.behind = null;
      fixture.setMineConfirmation(true);
    }
    try {
      await youreIn().waitFor({ state: "visible", timeout: 30_000 });
      expect((await wallet.requests()).map(call)).toEqual([
        { name: "approve", args: [chain.raffle.address, TOTAL] },
        { name: "buyPack", args: [1n, 0, 1, PUBLISHED_TERMS_HASH] }
      ]);
    } finally {
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 120_000);

  it("needs no second approval when the pack changes while the approval confirms and the re-read comes from a node behind it", async () => {
    await openPiece(1n, chain.operator);
    const wallet = await watchWallet(fixture.page);
    await agreement().check();
    const lag = await lagLatest();
    const asksTwice = fixture.page.getByText(/Your wallet asks twice/);
    fixture.setMineConfirmation(false);
    try {
      const approved = await approvalBlock(wallet);
      await fixture.page.getByText(/^Confirming on the network/).waitFor({ state: "visible", timeout: 20_000 });
      // Every membership costs the same here, so the approval for the first also covers the second.
      await fixture.page.locator("label.squishy-pack-card").filter({ hasText: "Bronze" }).click();
      await expect.poll(() => fixture.page.getByRole("radio", { name: /Bronze/ }).isChecked(), { timeout: 10_000 }).toBe(true);
      lag.behind = numberToHex(approved - 1n);
      await chain.mine();
      await expect.poll(() => lag.staleReads, { timeout: 30_000 }).toBeGreaterThan(0);
      await fixture.page.waitForTimeout(3_000);
    } finally {
      lag.behind = null;
      fixture.setMineConfirmation(true);
    }
    try {
      // The page reads the allowance at or after the approval, so the button is the purchase.
      await expect.poll(() => asksTwice.count(), { timeout: 20_000 }).toBe(0);
      await expect.poll(() => buy().isEnabled(), { timeout: 20_000 }).toBe(true);
      await buy().click();
      await youreIn().waitFor({ state: "visible", timeout: 30_000 });
      expect((await wallet.requests()).map(call)).toEqual([
        { name: "approve", args: [chain.raffle.address, TOTAL] },
        { name: "buyPack", args: [1n, 1, 1, PUBLISHED_TERMS_HASH] }
      ]);
    } finally {
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 120_000);

  // Last: it moves the chain past raffle 2's sales deadline.
  it("keeps the newer raffle state when an older background read finishes after it", async () => {
    const { raffle } = await service.readRaffle({ id: 2n });
    await chain.warp(raffle.salesEnd + 1n);
    await openPiece(2n, chain.stranger);
    await fixture.page.getByText("Membership price paid", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await fixture.page.waitForLoadState("networkidle");
    const wallet = await watchWallet(fixture.page);
    // Holds the next background read after it pinned its block: its raffle call, and the retry of that call after 15 seconds.
    const held: Route[] = [];
    let armed = true, pinned: unknown = null;
    await fixture.page.route(`${chain.url}/`, async route => {
      const request = rpcRequest(route);
      const target: unknown = request?.method === "eth_call" ? request.params[0] : null;
      const raffleCall = !!target && typeof target === "object" && "data" in target && typeof target.data === "string" && target.data.startsWith(GET_RAFFLE);
      if (raffleCall && (armed || pinned !== null && request?.params[1] === pinned)) {
        if (armed) { armed = false; pinned = request?.params[1]; }
        held.push(route);
        return;
      }
      await route.continue();
    });
    try {
      await expect.poll(() => held.length, { timeout: 30_000 }).toBe(1);
      // Every later read pins a newer block, so only the held read waits.
      await chain.mine();
      // A wallet request that is rejected pauses and restarts the page's background re-read while the held read is in flight.
      await wallet.reject(CLOSE);
      await fixture.page.locator("summary", { hasText: "Other actions" }).click();
      await fixture.page.getByRole("button", { name: "Close sales", exact: true }).click();
      await fixture.page.getByRole("button", { name: "Confirm close sales", exact: true }).click();
      await fixture.page.getByText("Cancelled in your wallet. Nothing was sent.", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      // Someone else closes sales, and the restarted re-read shows it.
      await chain.write(chain.raffle, "close", [2n]);
      const closed = fixture.page.getByRole("heading", { name: "Sales closed", exact: true });
      await closed.waitFor({ state: "visible", timeout: 40_000 });

      // The held read returns the raffle as it was before sales closed.
      pinned = null;
      for (const route of held) await route.continue().catch(() => {});
      const response = await held.at(-1)?.request().response();
      expect(response?.ok()).toBe(true);
      await fixture.page.waitForTimeout(4_000);
      expect(await closed.count()).toBe(1);
      expect(await fixture.page.getByRole("button", { name: "Close sales", exact: true }).count()).toBe(0);
    } finally {
      pinned = null;
      for (const route of held) await route.continue().catch(() => {});
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 150_000);
});
