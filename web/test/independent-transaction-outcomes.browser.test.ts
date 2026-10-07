import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeEventLog, erc20Abi, keccak256, toBytes, type Address, type Hex } from "viem";
import type { Route } from "playwright";
import { raffleAbi } from "../lib/chain/abi";
import { transactionIntent } from "../lib/chain/pending-journal";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_INDEPENDENT_TRANSACTION_OUTCOMES_BROWSER === "1" ? describe : describe.skip;

run("independent transaction outcome ownership", () => {
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
    return submitted;
  }

  async function createOpenRaffle(tokenId: bigint, title: string, priceUsdc: bigint) {
    const block = await chain.client.getBlock();
    const commitment = keccak256(toBytes(`independent-outcome-${tokenId.toString()}`));
    const draft: DraftInput = {
      nft: chain.nft.address,
      tokenId,
      salesEnd: block.timestamp + 7_200n,
      reserveNonce: commitment,
      reserveCommit: commitment,
      title,
      packs: [{ name: "Entry", priceUsdc, bonusEntries: 2, maxSupply: 20 }]
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

  function journalKey(account: Address) {
    return `labx:pending:v1:${chain.manifest.chainId}:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${account.toLowerCase()}`;
  }

  async function openPiece(id: bigint, account: Address) {
    await fixture.switchAccount(account);
    const response = await fixture.page.goto(`${fixture.baseUrl}/piece/${id.toString()}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await expect.poll(() => fixture.page.locator(".wallet-identity").innerText(), { timeout: 10_000 })
      .toContain(`${account.slice(0, 6)}…${account.slice(-4)}`);
  }

  async function acceptAndRecord() {
    const agreements = fixture.page.locator(".agreements input[type=checkbox]");
    await agreements.first().waitFor({ state: "visible", timeout: 10_000 });
    for (const checkbox of await agreements.all()) await checkbox.check();
    const record = fixture.page.getByRole("button", { name: "Sign and record agreement", exact: true });
    await record.waitFor({ state: "visible", timeout: 10_000 });
    await record.click();
  }

  async function reachPurchase() {
    await acceptAndRecord();
    const purchase = fixture.page.getByRole("button", { name: "Purchase membership", exact: true });
    await purchase.waitFor({ state: "visible", timeout: 10_000 });
    return purchase;
  }

  async function purchased(id: bigint, buyer: Address) {
    const logs = await chain.client.getLogs({ address: chain.raffle.address, fromBlock: chain.manifest.deploymentBlock });
    return logs.flatMap(log => {
      try {
        const event = decodeEventLog({ abi: raffleAbi, data: log.data, topics: log.topics, strict: true });
        return event.eventName === "PackPurchased" && event.args.id === id && event.args.buyer.toLowerCase() === buyer.toLowerCase() ? [event.args] : [];
      } catch { return []; }
    });
  }

  beforeAll(async () => {
    chain = await localChain();
    service = chain.service;
    seller = chain.wallet(chain.seller).session;
    await seller.connect();
    for (const tokenId of [981n, 982n, 983n]) await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    for (const account of [chain.buyer, chain.stranger, chain.treasury]) await chain.write(chain.usdc, "mint", [account, 1_000_000_000n]);
    expect(await createOpenRaffle(981n, "Unrelated approval outcome", 10_000_000n)).toBe(1n);
    expect(await createOpenRaffle(982n, "Refresh during confirmation", 14_000_000n)).toBe(2n);
    expect(await createOpenRaffle(983n, "Late wallet completion", 18_000_000n)).toBe(3n);
    const stranger = chain.wallet(chain.stranger).session;
    const treasury = chain.wallet(chain.treasury).session;
    await Promise.all([stranger.connect(), treasury.connect()]);
    await act({ kind: "approveUsdc", id: 2n, packId: 0, quantity: 1 }, stranger);
    await act({ kind: "approveUsdc", id: 3n, packId: 0, quantity: 1 }, treasury);
    fixture = await browserChain(chain, chain.buyer, false);
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  it("does not label a reconciled approval as a purchase or hide the untouched purchase form", async () => {
    const buyer = chain.wallet(chain.buyer).session;
    await buyer.connect();
    const approval = await act({ kind: "approveUsdc", id: 1n, packId: 0, quantity: 4 }, buyer);
    const transaction = await chain.client.getTransaction({ hash: approval.hash });
    const receipt = await chain.client.getTransactionReceipt({ hash: approval.hash });
    expect(transaction.to).not.toBeNull();

    await openPiece(1n, chain.buyer);
    const key = journalKey(chain.buyer);
    await fixture.page.evaluate(({ storageKey, record }) => localStorage.setItem(storageKey, JSON.stringify(record)), {
      storageKey: key,
      record: {
        id: "independent-unrelated-approval",
        intentHash: transactionIntent({ to: transaction.to!, data: transaction.input, value: transaction.value }),
        nonce: transaction.nonce,
        startedBlock: receipt.blockNumber.toString(),
        hash: approval.hash
      }
    });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await acceptAndRecord();

    const recovery = fixture.page.locator(".buyer-flow .transaction-state", { hasText: "Reconcile pending wallet activity" });
    await recovery.waitFor({ state: "visible", timeout: 10_000 });
    expect(await recovery.getByLabel("Transaction hash").inputValue()).toBe(approval.hash);
    await recovery.getByRole("button", { name: "Reconcile transaction", exact: true }).click();
    await expect.poll(() => fixture.page.evaluate((storageKey: string) => localStorage.getItem(storageKey), key), { timeout: 10_000 }).toBeNull();

    expect(await purchased(1n, chain.buyer)).toHaveLength(0);
    const buyerText = await fixture.page.locator(".buyer-flow").innerText();
    expect(buyerText).not.toMatch(/purchase confirmed/i);
    await fixture.page.getByRole("radiogroup", { name: "Membership packs" }).waitFor({ state: "visible", timeout: 10_000 });
  }, 60_000);

  it("keeps the purchase receipt visible when refresh replaces controls during confirmation", async () => {
    await openPiece(2n, chain.stranger);
    const purchase = await reachPurchase();
    await purchase.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });

    const held: Route[] = [];
    let holding = true;
    await fixture.page.route(`${chain.url}/`, async route => {
      const body: unknown = route.request().postDataJSON();
      const requests = Array.isArray(body) ? body : [body];
      const receiptRequest = requests.some(value => typeof value === "object" && value !== null && "method" in value && value.method === "eth_getTransactionReceipt");
      if (holding && receiptRequest) { held.push(route); return; }
      await route.continue();
    });

    await review.getByRole("button", { name: "Confirm purchase membership", exact: true }).click();
    const pending = fixture.page.locator(".buyer-flow .transaction-state", { hasText: "Transaction submitted" });
    await pending.waitFor({ state: "visible", timeout: 10_000 });
    const hash = (await pending.innerText()).match(/0x[0-9a-f]{64}/i)?.[0] as Hex | undefined;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);
    await expect.poll(() => held.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await chain.mine();
    await chain.mine();

    await fixture.page.getByRole("button", { name: "Refresh state", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Refresh state", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    holding = false;
    await Promise.all(held.splice(0).map(route => route.continue()));
    await fixture.page.unroute(`${chain.url}/`);
    const key = journalKey(chain.stranger);
    await expect.poll(() => fixture.page.evaluate((storageKey: string) => localStorage.getItem(storageKey), key), { timeout: 15_000 }).toBeNull();

    await fixture.page.getByRole("button", { name: "Refresh state", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Refresh state", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await purchased(2n, chain.stranger)).toHaveLength(1);
    expect(await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).count()).toBe(0);
    const workspaceText = await fixture.page.locator("#content").innerText();
    expect(workspaceText).toContain(hash!);
    expect(workspaceText).toMatch(/purchase confirmed/i);
  }, 75_000);

  it("surfaces a late purchase hash only after an A-B-A wallet prompt returns to its original wallet", async () => {
    await openPiece(3n, chain.treasury);
    const purchase = await reachPurchase();
    await purchase.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.evaluate(() => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Held = { input: { method: string; params?: readonly unknown[] }; resolve(value: unknown): void; reject(error: unknown): void };
      type Scope = Window & {
        ethereum: { request: Request };
        __latePurchaseRequests: number;
        __latePurchaseHash?: string;
        __releaseLatePurchase(): void;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      const held: Held[] = [];
      scope.__latePurchaseRequests = 0;
      scope.ethereum.request = input => {
        if (input.method !== "eth_sendTransaction") return original(input);
        scope.__latePurchaseRequests += 1;
        return new Promise((resolve, reject) => held.push({ input, resolve, reject }));
      };
      scope.__releaseLatePurchase = () => {
        for (const call of held.splice(0)) void original(call.input).then(value => {
          scope.__latePurchaseHash = String(value);
          call.resolve(value);
        }, call.reject);
      };
    });

    await review.getByRole("button", { name: "Confirm purchase membership", exact: true }).click();
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __latePurchaseRequests: number }).__latePurchaseRequests), { timeout: 10_000 }).toBe(1);
    await fixture.switchAccount(chain.buyer);
    await expect.poll(() => fixture.page.locator(".wallet-identity").innerText(), { timeout: 10_000 })
      .toContain(`${chain.buyer.slice(0, 6)}…${chain.buyer.slice(-4)}`);
    expect(await fixture.page.locator(".buyer-flow").innerText()).not.toMatch(/purchase confirmed/i);

    await fixture.switchAccount(chain.treasury);
    await expect.poll(() => fixture.page.locator(".wallet-identity").innerText(), { timeout: 10_000 })
      .toContain(`${chain.treasury.slice(0, 6)}…${chain.treasury.slice(-4)}`);
    await fixture.page.evaluate(() => (window as unknown as Window & { __releaseLatePurchase(): void }).__releaseLatePurchase());
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __latePurchaseHash?: string }).__latePurchaseHash), { timeout: 10_000 }).toMatch(/^0x[0-9a-f]{64}$/i);
    const hash = await fixture.page.evaluate(() => (window as unknown as Window & { __latePurchaseHash?: string }).__latePurchaseHash);
    await chain.mine();
    await chain.mine();

    const saved = await fixture.page.evaluate((storageKey: string) => localStorage.getItem(storageKey), journalKey(chain.treasury));
    expect(saved).toContain(hash);
    const originalWalletText = await fixture.page.locator("#content").innerText();
    expect(originalWalletText).toContain(hash);
  }, 75_000);
});
