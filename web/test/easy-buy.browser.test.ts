import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, toBytes, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { formatUsdcAmount } from "../components/workflow/format";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";
import { watchWallet, type WalletRequest } from "./fixtures/wallet-watch";

const run = process.env.RUN_EASY_BUY_BROWSER === "1" ? describe : describe.skip;

/** Price and bonus entries per tier: every buyer fee rule shows up, the 2.50 USDC minimum and the 2% rate. */
const PRICES = { Entry: 10_000_000n, Bronze: 20_000_000n, Silver: 30_000_000n, Gold: 50_000_000n, Platinum: 200_000_000n } as const;
const TIERS = Object.keys(PRICES) as (keyof typeof PRICES)[];
const total = (principal: bigint) => principal + (principal * 200n / 10_000n > 2_500_000n ? principal * 200n / 10_000n : 2_500_000n);
const APPROVE = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x0000000000000000000000000000000000000000", 0n] }).slice(0, 10);
const BUY_PACK = encodeFunctionData({ abi: raffleAbi, functionName: "buyPack", args: [0n, 0, 1, PUBLISHED_TERMS_HASH] }).slice(0, 10);

run("one-click membership purchase in a rendered browser", () => {
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
    await chain.write(chain.usdc, "mint", [chain.buyer, 5_000_000_000n]);
    await chain.write(chain.usdc, "mint", [chain.stranger, 5_000_000_000n]);
    const latest = await chain.client.getBlock();
    const reserve = keccak256(toBytes("easy-buy"));
    const draft: DraftInput = { nft: chain.nft.address, tokenId: 1n, salesEnd: latest.timestamp + 7_200n, reserveNonce: reserve, reserveCommit: reserve, title: "Easy buy raffle",
      packs: standardMembershipPacks(tier => ({ priceUsdc: PRICES[tier], bonusEntries: TIERS.indexOf(tier) + 1, maxSupply: 50 })) };
    await act({ kind: "createDraft", draft }, seller);
    id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
    await act({ kind: "approvePrize", id }, seller);
    await act({ kind: "escrow", id }, seller);
    await chain.admit(id);
    const policy = await service.openingPolicy();
    await act({ kind: "open", id, expectedPolicyHash: policy.hash }, seller);
    fixture = await browserChain(chain, chain.buyer);
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  async function openPiece(account: Address) {
    await fixture.switchAccount(account);
    const response = await fixture.page.goto(`${fixture.baseUrl}/piece/${id.toString()}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    const identity = fixture.page.locator(".wallet-identity", { hasText: `${account.slice(0, 6)}…${account.slice(-4)}` });
    await expect.poll(async () => await connect.isVisible().catch(() => false) || await identity.isVisible().catch(() => false), { timeout: 15_000 }).toBe(true);
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await identity.waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.locator(".agreements input[type=checkbox]").waitFor({ state: "visible", timeout: 15_000 });
  }
  const agreement = () => fixture.page.getByRole("checkbox", { name: /I’m 18 or older and agree to the membership terms and draw rules/ });
  const buy = (amount: bigint) => fixture.page.getByRole("button", { name: `Buy for ${formatUsdcAmount(amount)} USDC`, exact: true });
  const youreIn = () => fixture.page.locator(".purchase-receipt", { hasText: "You’re in" });
  async function choose(tier: keyof typeof PRICES) {
    await fixture.page.locator("label.squishy-pack-card").filter({ hasText: tier }).click();
    await expect.poll(() => fixture.page.getByRole("radio", { name: new RegExp(tier) }).isChecked(), { timeout: 10_000 }).toBe(true);
  }
  function call(request: WalletRequest) {
    if (request.data?.startsWith(APPROVE)) return { name: "approve", args: decodeFunctionData({ abi: erc20Abi, data: request.data as Hex }).args };
    return { name: "buyPack", args: decodeFunctionData({ abi: raffleAbi, data: request.data as Hex }).args };
  }
  async function buyAgain() {
    const again = fixture.page.getByRole("button", { name: "Buy again", exact: true });
    await expect.poll(() => again.isEnabled(), { timeout: 20_000 }).toBe(true);
    await again.click();
    await expect.poll(() => youreIn().count(), { timeout: 10_000 }).toBe(0);
  }
  const journalKey = (account: Address) => `labx:pending:v1:${chain.manifest.chainId}:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${account.toLowerCase()}`;
  const allowance = (account: Address) => chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "allowance", args: [account, chain.raffle.address] });

  it("buys every membership the raffle offers with one click: two wallet transactions without an allowance and no signatures", async () => {
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await openPiece(chain.buyer);
    const wallet = await watchWallet(fixture.page);
    await fixture.page.getByRole("button", { name: /^Buy for / }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("button", { name: /^Buy for / }).isDisabled()).toBe(true);
    expect(await fixture.page.getByText("Tick the box above to continue.", { exact: true }).isVisible()).toBe(true);
    await agreement().check();
    for (const [packId, tier] of TIERS.entries()) {
      expect(await allowance(chain.buyer)).toBe(0n);
      await choose(tier);
      const amount = total(PRICES[tier]);
      await buy(amount).waitFor({ state: "visible", timeout: 15_000 });
      expect(await fixture.page.getByText(`Your wallet asks twice: first to approve exactly ${formatUsdcAmount(amount)} USDC, then to buy.`, { exact: true }).isVisible()).toBe(true);
      const before = (await wallet.requests()).length;
      await buy(amount).click();
      await youreIn().waitFor({ state: "visible", timeout: 30_000 });
      expect(await youreIn().innerText()).toContain(`1 × ${tier}`);
      const requests = (await wallet.requests()).slice(before);
      expect(requests.map(request => request.method)).toEqual(["eth_sendTransaction", "eth_sendTransaction"]);
      expect(requests.map(call)).toEqual([
        { name: "approve", args: [chain.raffle.address, amount] },
        { name: "buyPack", args: [id, packId, 1, PUBLISHED_TERMS_HASH] }
      ]);
      expect(requests.every(request => request.from === chain.buyer.toLowerCase() && request.maxFeePerGas !== undefined && request.maxPriorityFeePerGas !== undefined)).toBe(true);
      expect(await wallet.reviews()).toBe(0);
      await buyAgain();
      expect(await agreement().isChecked()).toBe(true);
    }
    expect((await wallet.requests()).filter(request => request.method === "personal_sign")).toEqual([]);
    const account = await service.readAccount({ id, account: chain.buyer });
    expect(account.principal).toBe(Object.values(PRICES).reduce((sum, price) => sum + price, 0n));
    expect(await allowance(chain.buyer)).toBe(0n);
  }, 240_000);

  it("buys with one wallet transaction when the allowance already covers the total", async () => {
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 1_000_000_000n], chain.buyer);
    try {
      await openPiece(chain.buyer);
      const wallet = await watchWallet(fixture.page);
      await agreement().check();
      await choose("Silver");
      await fixture.page.getByRole("spinbutton", { name: "Quantity", exact: true }).fill("2");
      const amount = total(PRICES.Silver * 2n);
      await buy(amount).waitFor({ state: "visible", timeout: 15_000 });
      expect(await fixture.page.getByText(/Your wallet asks twice/).count()).toBe(0);
      await buy(amount).click();
      await youreIn().waitFor({ state: "visible", timeout: 30_000 });
      const requests = await wallet.requests();
      expect(requests.map(request => request.method)).toEqual(["eth_sendTransaction"]);
      expect(requests.map(call)).toEqual([{ name: "buyPack", args: [id, 2, 2, PUBLISHED_TERMS_HASH] }]);
      expect(await allowance(chain.buyer)).toBe(1_000_000_000n - amount);
      await buyAgain();
    } finally {
      await chain.write(chain.usdc, "approve", [chain.raffle.address, 0n], chain.buyer);
    }
  }, 90_000);

  it("still buys after the pack changes following its approval, with a fresh exact approval only when the new total needs one", async () => {
    await openPiece(chain.buyer);
    const wallet = await watchWallet(fixture.page);
    await agreement().check();
    await choose("Gold");
    const gold = total(PRICES.Gold);
    await wallet.reject(BUY_PACK);
    await buy(gold).click();
    await fixture.page.getByText("Cancelled in your wallet. Nothing was sent.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    expect((await wallet.requests()).map(call).map(item => item.name)).toEqual(["approve", "buyPack"]);
    expect(await allowance(chain.buyer)).toBe(gold);

    // Entry costs less than the approved Gold total, so the purchase goes straight to the wallet.
    await choose("Entry");
    const entry = total(PRICES.Entry);
    await buy(entry).click();
    await youreIn().waitFor({ state: "visible", timeout: 30_000 });
    expect((await wallet.requests()).slice(2).map(call)).toEqual([{ name: "buyPack", args: [id, 0, 1, PUBLISHED_TERMS_HASH] }]);
    await buyAgain();

    // Platinum costs more than what is left, so the wallet first approves its exact total.
    await choose("Platinum");
    const platinum = total(PRICES.Platinum);
    await buy(platinum).click();
    await youreIn().waitFor({ state: "visible", timeout: 30_000 });
    expect((await wallet.requests()).slice(3).map(call)).toEqual([
      { name: "approve", args: [chain.raffle.address, platinum] },
      { name: "buyPack", args: [id, 4, 1, PUBLISHED_TERMS_HASH] }
    ]);
    await buyAgain();
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 0n], chain.buyer);
  }, 120_000);

  it("settles a pending record with nothing at its nonce from the chain, without a pasted hash", async () => {
    const intentHash = keccak256(toBytes("easy-buy-stuck"));
    const write = (record: { id: string; nonce: number; startedBlock: bigint }) => fixture.page.evaluate(({ key, value }) => localStorage.setItem(key, value),
      { key: journalKey(chain.buyer), value: JSON.stringify({ id: record.id, intentHash, nonce: record.nonce, startedBlock: record.startedBlock.toString(), hash: null }) });
    const saved = () => fixture.page.evaluate((key: string) => localStorage.getItem(key), journalKey(chain.buyer));
    const hashField = fixture.page.getByLabel("Transaction hash");
    await openPiece(chain.buyer);
    const nonce = await chain.client.getTransactionCount({ address: chain.buyer, blockTag: "pending" });

    // Nothing at its nonce and fewer than 25 blocks old: the person continues with one click.
    await write({ id: "recent-unsent", nonce, startedBlock: await chain.client.getBlockNumber() });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByText("Your wallet didn’t send your last transaction.", { exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
    expect(await fixture.page.getByText(/needs a check|paste/i).count()).toBe(0);
    expect(await hashField.count()).toBe(0);
    await fixture.page.locator(".resume-transaction summary", { hasText: /^Details$/ }).click();
    expect(await fixture.page.getByText("If your wallet still shows a request from LABx, reject it first.", { exact: true }).first().isVisible()).toBe(true);
    await agreement().check();
    await fixture.page.getByRole("button", { name: "Continue", exact: true }).first().click();
    await expect.poll(saved, { timeout: 10_000 }).toBeNull();
    await buy(total(PRICES.Entry)).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByText("Your wallet didn’t send your last transaction.", { exact: true }).count()).toBe(0);

    // At least 25 blocks old with still nothing at its nonce: it clears by itself.
    const block = await chain.client.getBlockNumber();
    await write({ id: "aged-unsent", nonce, startedBlock: block > 30n ? block - 30n : 0n });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(saved, { timeout: 20_000 }).toBeNull();
    await agreement().check();
    await buy(total(PRICES.Entry)).waitFor({ state: "visible", timeout: 15_000 });

    // Its nonce is already spent and nothing is pending: it clears by itself.
    await write({ id: "spent", nonce: nonce - 1, startedBlock: await chain.client.getBlockNumber() });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(saved, { timeout: 20_000 }).toBeNull();

    // Something is pending at its nonce: the page waits, then clears once that send is mined.
    await chain.rpc("evm_setAutomine", [false]);
    try {
      await chain.rpc("eth_sendTransaction", [{ from: chain.buyer, to: chain.buyer, value: "0x0", nonce: `0x${nonce.toString(16)}`, gas: "0x5208" }]);
      await write({ id: "waiting", nonce, startedBlock: await chain.client.getBlockNumber() });
      await fixture.page.reload({ waitUntil: "domcontentloaded" });
      await agreement().check();
      await fixture.page.getByText("Waiting for your last transaction to confirm…", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
      expect(await saved()).not.toBeNull();
      await chain.mine();
    } finally {
      await chain.rpc("evm_setAutomine", [true]);
    }
    await expect.poll(saved, { timeout: 20_000 }).toBeNull();
    await buy(total(PRICES.Entry)).waitFor({ state: "visible", timeout: 15_000 });
    expect(await hashField.count()).toBe(0);
    // Only the test's own send at that nonce went out: the page never asked the wallet for anything.
    expect(await chain.client.getTransactionCount({ address: chain.buyer })).toBe(nonce + 1);
  }, 120_000);

  it("does not open the wallet when it cannot pay the network fee, and says how much it needs", async () => {
    await chain.rpc("anvil_setBalance", [chain.stranger, "0x3e8"]);
    try {
      await openPiece(chain.stranger);
      const wallet = await watchWallet(fixture.page);
      await agreement().check();
      await buy(total(PRICES.Entry)).click();
      await fixture.page.getByText(/^Your wallet needs about \d+(\.\d+)? ETH for the network fee\.$/).waitFor({ state: "visible", timeout: 20_000 });
      expect(await fixture.page.getByText("Action unavailable", { exact: true }).count()).toBe(0);
      expect(await wallet.requests()).toEqual([]);
      expect(await fixture.page.evaluate((key: string) => localStorage.getItem(key), journalKey(chain.stranger))).toBeNull();
    } finally {
      await chain.rpc("anvil_setBalance", [chain.stranger, "0x21e19e0c9bab2400000"]);
    }
  }, 60_000);
});
