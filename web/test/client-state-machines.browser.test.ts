import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes, toHex, type Address, type Hex } from "viem";
import type { Page } from "playwright";
import { raffleAbi } from "../lib/chain/abi";
import { formatUsdcAmount } from "../components/workflow/format";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { connectWallet } from "./fixtures/connect-wallet";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";
import { watchWallet } from "./fixtures/wallet-watch";

const run = process.env.RUN_CLIENT_STATE_MACHINES_BROWSER === "1" ? describe : describe.skip;

const PRICE = 10_000_000n;
/** The membership price plus the 2.50 USDC minimum processing fee. */
const TOTAL = PRICE + 2_500_000n;

/**
 * The component sequences of docs/audits/state-machines.part-client.md, in a rendered browser on a local chain: a purchase
 * that outlasts its first one-minute watch and is then settled somewhere this checkout is not watching.
 */
run("client state machine sequences", () => {
  let chain: LocalChain;
  let service: RaffleService;
  let seller: WalletSessionPort;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let id: bigint;

  async function act(action: WorkflowAction, wallet: WalletSessionPort) {
    const prepared = await service.prepare({ action, wallet });
    const submitted = await service.submit({ prepared, wallet });
    await chain.mine();
    await chain.mine();
    expect(await service.confirm({ transaction: submitted, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
  }

  beforeAll(async () => {
    chain = await localChain();
    service = chain.service;
    seller = chain.wallet(chain.seller).session;
    await seller.connect();
    await chain.write(chain.nft, "mint", [chain.seller, 1n]);
    // Each buyer already holds the exact allowance, so its purchase is one wallet request.
    for (const account of [chain.buyer, chain.stranger, chain.treasury]) {
      await chain.write(chain.usdc, "mint", [account, 2_000_000_000n]);
      await chain.write(chain.usdc, "approve", [chain.raffle.address, TOTAL], account);
    }
    const latest = await chain.client.getBlock();
    const reserve = keccak256(toBytes("client-state-machines"));
    const draft: DraftInput = { nft: chain.nft.address, tokenId: 1n, salesEnd: latest.timestamp + 7_200n, reserveNonce: reserve, reserveCommit: reserve, title: "Slow purchase raffle",
      packs: standardMembershipPacks(() => ({ priceUsdc: PRICE, bonusEntries: 1, maxSupply: 20 })) };
    await act({ kind: "createDraft", draft }, seller);
    id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    await chain.admit(id);
    const policy = await service.openingPolicy();
    await act({ kind: "open", id, expectedPolicyHash: policy.hash }, seller);
    fixture = await browserChain(chain, chain.buyer);
    await fixture.context.addInitScript(() => window.sessionStorage.setItem("labx:brand-intro:shown", "1"));
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  const identity = (page: Page, account: Address) => page.locator(".wallet-identity", { hasText: `${account.slice(0, 6)}…${account.slice(-4)}` });
  const stillConfirming = (page: Page) => page.getByText(/^Still confirming on the network/);
  const buy = (page: Page) => page.getByRole("button", { name: `Buy for ${formatUsdcAmount(TOTAL)} USDC`, exact: true });
  const youreIn = (page: Page) => page.locator(".purchase-receipt", { hasText: "You’re in" });
  const pricePaid = (page: Page) => page.getByText("Membership price paid", { exact: true });

  /** Opens the raffle as `account`, sends its purchase and holds it unmined until the checkout's first watch has ended. */
  async function slowPurchase(account: Address) {
    const page = fixture.page;
    await fixture.switchAccount(account);
    expect((await page.goto(`${fixture.baseUrl}/piece/${id.toString()}`, { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
    await connectWallet(page, identity(page, account));
    const wallet = await watchWallet(page);
    await page.getByRole("checkbox", { name: /I’m 18 or older and agree to the membership terms and draw rules/ }).check();
    fixture.setMineConfirmation(false);
    await chain.rpc("evm_setAutomine", [false]);
    await buy(page).click();
    await expect.poll(async () => (await wallet.requests())[0]?.hash, { timeout: 20_000 }).toBeTruthy();
    const [request] = await wallet.requests();
    const sent = await chain.client.getTransaction({ hash: request.hash as Hex });
    return { page, wallet, hash: sent.hash, nonce: sent.nonce, data: sent.input };
  }
  async function release() {
    fixture.setMineConfirmation(true);
    await chain.rpc("evm_setAutomine", [true]);
  }

  it("stops waiting for a purchase the wallet cancelled after the first watch, and buys again on the next click", async () => {
    try {
      const { page, wallet, hash, nonce } = await slowPurchase(chain.buyer);
      await stillConfirming(page).waitFor({ state: "visible", timeout: 90_000 });
      // The buyer cancels it in the wallet: a zero-value send to themselves takes its nonce.
      await chain.rpc("anvil_dropTransaction", [hash]);
      await chain.rpc("eth_sendTransaction", [{ from: chain.buyer, to: chain.buyer, value: "0x0", nonce: toHex(nonce), gas: "0x5208" }]);
      await release();
      await chain.mine();
      await chain.mine();
      await expect.poll(() => stillConfirming(page).count(), { timeout: 60_000 }).toBe(0);
      await page.getByText("Your wallet replaced or dropped this transaction. Check the page before trying again.", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect.poll(() => buy(page).isEnabled().catch(() => false), { timeout: 20_000 }).toBe(true);
      await buy(page).click();
      await youreIn(page).waitFor({ state: "visible", timeout: 30_000 });
      expect((await wallet.requests()).map(request => request.data?.slice(0, 10))).toHaveLength(2);
    } finally {
      await release();
    }
  }, 240_000);

  it("shows the membership a faster copy of the purchase bought after the first watch", async () => {
    try {
      const { page, wallet, hash, nonce, data } = await slowPurchase(chain.treasury);
      await stillConfirming(page).waitFor({ state: "visible", timeout: 90_000 });
      // The buyer speeds it up in the wallet: the same call at the same nonce under a new hash.
      await chain.rpc("anvil_dropTransaction", [hash]);
      await chain.rpc("eth_sendTransaction", [{ from: chain.treasury, to: chain.raffle.address, data, value: "0x0", nonce: toHex(nonce), gas: "0x989681" }]);
      await release();
      await chain.mine();
      await chain.mine();
      await pricePaid(page).waitFor({ state: "visible", timeout: 60_000 });
      await expect.poll(() => stillConfirming(page).count(), { timeout: 20_000 }).toBe(0);
      expect(await wallet.requests()).toHaveLength(1);
      expect(await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "lotCount", args: [id] })).toBeGreaterThan(0n);
    } finally {
      await release();
    }
  }, 240_000);

  it("shows the receipt of a slow purchase that another tab of the same wallet confirmed first", async () => {
    let other: Page | null = null;
    try {
      const { page, wallet } = await slowPurchase(chain.stranger);
      // The buyer switches to another LABx tab, so this one stops checking while it is hidden.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await stillConfirming(page).waitFor({ state: "visible", timeout: 90_000 });
      other = await fixture.context.newPage();
      expect((await other.goto(`${fixture.baseUrl}/piece/${id.toString()}`, { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
      // The saved wallet is restored without a click: a new Connect here would disconnect the first tab.
      await identity(other, chain.stranger).waitFor({ state: "visible", timeout: 30_000 });
      await release();
      await chain.mine();
      await chain.mine();
      await youreIn(other).waitFor({ state: "visible", timeout: 60_000 });
      // Back in the first tab.
      await page.evaluate(() => {
        Reflect.deleteProperty(document, "visibilityState");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await youreIn(page).waitFor({ state: "visible", timeout: 60_000 });
      expect(await stillConfirming(page).count()).toBe(0);
      expect(await wallet.requests()).toHaveLength(1);
    } finally {
      await other?.close();
      await release();
    }
  }, 300_000);
});
