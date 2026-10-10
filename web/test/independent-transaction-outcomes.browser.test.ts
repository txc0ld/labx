import { openWalletActivity } from "./fixtures/wallet-activity";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEventLog, encodeFunctionData, erc20Abi, keccak256, toBytes, toHex, type Address, type Hex } from "viem";
import type { Route } from "playwright";
import { raffleAbi } from "../lib/chain/abi";
import { transactionIntent } from "../lib/chain/pending-journal";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";
import { connectWallet } from "./fixtures/connect-wallet";

const run = process.env.RUN_INDEPENDENT_TRANSACTION_OUTCOMES_BROWSER === "1" ? describe : describe.skip;

run("independent transaction outcome ownership", () => {
  let chain: LocalChain;
  let service: RaffleService;
  let seller: WalletSessionPort;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  const getRaffleSelector = encodeFunctionData({ abi: raffleAbi, functionName: "getRaffle", args: [1n] }).slice(0, 10).toLowerCase();

  function isRaffleSnapshotRead(request: unknown) {
    if (typeof request !== "object" || request === null || !("method" in request) || request.method !== "eth_call" || !("params" in request) || !Array.isArray(request.params)) return false;
    const call = request.params[0];
    return typeof call === "object" && call !== null && "data" in call && typeof call.data === "string" && call.data.toLowerCase().startsWith(getRaffleSelector);
  }

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
      packs: standardMembershipPacks(() => ({ priceUsdc, bonusEntries: 2, maxSupply: 20 }))
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

  function outcomeCheckpointKey(account: Address, hash: Hex) {
    return `labx:outcome:v1:${chain.manifest.chainId}:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${account.toLowerCase()}:${hash.toLowerCase()}`;
  }

  async function openPiece(id: bigint, account: Address) {
    await fixture.switchAccount(account);
    const response = await fixture.page.goto(`${fixture.baseUrl}/piece/${id.toString()}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.locator(".wallet-identity", { hasText: `${account.slice(0, 6)}…${account.slice(-4)}` }));
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
    for (const tokenId of [981n, 982n, 983n, 984n]) await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    for (const account of [chain.buyer, chain.stranger, chain.treasury, chain.operator]) await chain.write(chain.usdc, "mint", [account, 1_000_000_000n]);
    expect(await createOpenRaffle(981n, "Unrelated approval outcome", 10_000_000n)).toBe(1n);
    expect(await createOpenRaffle(982n, "Refresh during confirmation", 14_000_000n)).toBe(2n);
    expect(await createOpenRaffle(983n, "Late wallet completion", 18_000_000n)).toBe(3n);
    expect(await createOpenRaffle(984n, "Replacement recovery", 22_000_000n)).toBe(4n);
    const stranger = chain.wallet(chain.stranger).session;
    const treasury = chain.wallet(chain.treasury).session;
    const operator = chain.wallet(chain.operator).session;
    await Promise.all([stranger.connect(), treasury.connect(), operator.connect()]);
    await act({ kind: "approveUsdc", id: 2n, packId: 0, quantity: 1 }, stranger);
    await act({ kind: "approveUsdc", id: 3n, packId: 0, quantity: 1 }, treasury);
    await act({ kind: "approveUsdc", id: 4n, packId: 0, quantity: 1 }, operator);
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
    const callbackReads: string[] = [];
    await fixture.page.route(`${chain.url}/`, async route => {
      const body: unknown = route.request().postDataJSON();
      for (const request of Array.isArray(body) ? body : [body]) {
        if (isRaffleSnapshotRead(request)) callbackReads.push(JSON.stringify(request));
      }
      await route.continue();
    });
    try {
      await recovery.getByRole("button", { name: "Reconcile transaction", exact: true }).click();
      await expect.poll(() => fixture.page.evaluate((storageKey: string) => localStorage.getItem(storageKey), key), { timeout: 10_000 }).toBeNull();

      expect(await purchased(1n, chain.buyer)).toHaveLength(0);
      const buyerText = await fixture.page.locator(".buyer-flow").innerText();
      expect(buyerText).not.toMatch(/purchase confirmed/i);
      await fixture.page.getByRole("radiogroup", { name: "Membership packs" }).waitFor({ state: "visible", timeout: 10_000 });
      expect({
        falseCurrentActionConfirmation: await fixture.page.locator(".buyer-flow .transaction-state").getByText("Confirmed", { exact: true }).count(),
        confirmationCallbackReads: callbackReads.length
      }).toEqual({ falseCurrentActionConfirmation: 0, confirmationCallbackReads: 0 });
    } finally {
      await fixture.page.unroute(`${chain.url}/`);
    }
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
    const pending = fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: "Transaction submitted" });
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

    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await fixture.page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(image => image.complete ? Promise.resolve() : new Promise<void>(resolveImage => {
        image.addEventListener("load", () => resolveImage(), { once: true });
        image.addEventListener("error", () => resolveImage(), { once: true });
      })));
    });
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await fixture.page.screenshot({
      path: resolve(process.cwd(), "../../artifacts/seller-portal-fees-20261007/transaction-outcomes/independent/purchase-outcome-mobile.png"),
      fullPage: true,
      animations: "disabled"
    });
    const lowerRecords = fixture.page.getByText(/Inspect bonus-entry records \(1 lots\)/);
    await lowerRecords.scrollIntoViewIfNeeded();
    await fixture.page.waitForTimeout(300);
    const lowerLayout = await lowerRecords.evaluate(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { rect: { top: rect.top, bottom: rect.bottom, height: rect.height }, display: style.display, visibility: style.visibility, opacity: style.opacity, scrollY, viewportHeight: innerHeight };
    });
    expect(lowerLayout.rect.top).toBeGreaterThanOrEqual(0);
    expect(lowerLayout.rect.bottom).toBeLessThanOrEqual(lowerLayout.viewportHeight);
    expect(lowerLayout).toMatchObject({ visibility: "visible", opacity: "1" });
    await fixture.page.screenshot({
      path: resolve(process.cwd(), "../../artifacts/seller-portal-fees-20261007/transaction-outcomes/independent/purchase-outcome-mobile-lower-viewport.png"),
      fullPage: false,
      animations: "disabled"
    });
    const footer = fixture.page.locator(".site-footer");
    await footer.scrollIntoViewIfNeeded();
    await fixture.page.waitForTimeout(300);
    const footerLayout = await footer.evaluate(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { rect: { top: rect.top, bottom: rect.bottom, height: rect.height }, display: style.display, visibility: style.visibility, opacity: style.opacity, scrollY, viewportHeight: innerHeight };
    });
    expect(footerLayout.rect.top).toBeLessThan(footerLayout.viewportHeight);
    expect(footerLayout).toMatchObject({ display: "grid", visibility: "visible", opacity: "1" });
    writeFileSync(
      resolve(process.cwd(), "../../artifacts/seller-portal-fees-20261007/transaction-outcomes/independent/mobile-lower-layout.json"),
      JSON.stringify({ lowerLayout, footerLayout }, null, 2)
    );
    await fixture.page.screenshot({
      path: resolve(process.cwd(), "../../artifacts/seller-portal-fees-20261007/transaction-outcomes/independent/purchase-outcome-mobile-footer-viewport.png"),
      fullPage: false,
      animations: "disabled"
    });

    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    const retained = fixture.page.locator("#content", { hasText: hash! });
    await retained.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => retained.innerText(), { timeout: 15_000 }).toMatch(/purchase confirmed/i);
    await expect.poll(() => fixture.page.getByRole("button", { name: "Buy again", exact: true }).isEnabled(), { timeout: 15_000 }).toBe(true);
    expect(await retained.getByText("Saved transaction needs verification", { exact: true }).count()).toBe(0);
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
    const originalWalletRecovery = fixture.page.locator(".resume-transaction form");
    await originalWalletRecovery.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => originalWalletRecovery.getByLabel("Transaction hash").inputValue(), { timeout: 10_000 }).toBe(hash);
    expect(await originalWalletRecovery.innerText()).toMatch(/Pending wallet activity|unresolved transaction/i);
    expect(await fixture.page.locator("#content").innerText()).not.toMatch(/purchase confirmed/i);
  }, 75_000);

  it("inspects an old confirmed hint without changing a separate newer pending journal", async () => {
    const buyer = chain.wallet(chain.buyer).session;
    await buyer.connect();
    const oldApproval = await act({ kind: "approveUsdc", id: 1n, packId: 0, quantity: 3 }, buyer);
    const oldTransaction = await chain.client.getTransaction({ hash: oldApproval.hash });
    await openPiece(1n, chain.buyer);
    const pendingKey = journalKey(chain.buyer);
    const checkpointKey = outcomeCheckpointKey(chain.buyer, oldApproval.hash);
    const block = await chain.client.getBlockNumber({ cacheTime: 0 });
    const newerJournal = JSON.stringify({
      id: "independent-newer-pending",
      intentHash: keccak256(toBytes("separate-newer-wallet-intent")),
      nonce: oldTransaction.nonce + 1,
      startedBlock: block.toString(),
      hash: null
    });
    await fixture.page.evaluate(({ outcomeKey, outcomeHash, journalStorageKey, journal }) => {
      localStorage.setItem(outcomeKey, outcomeHash.toLowerCase());
      localStorage.setItem(journalStorageKey, journal);
    }, { outcomeKey: checkpointKey, outcomeHash: oldApproval.hash, journalStorageKey: pendingKey, journal: newerJournal });

    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    const oldOutcome = fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: oldApproval.hash });
    await openWalletActivity(fixture.page);
    await oldOutcome.waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.waitForTimeout(2_000);
    const rawAfterInspection = await fixture.page.evaluate((key: string) => localStorage.getItem(key), pendingKey);
    const outcomeText = await oldOutcome.innerText();
    const pendingText = await fixture.page.locator(".resume-transaction").innerText();
    await fixture.page.evaluate((key: string) => localStorage.removeItem(key), pendingKey);

    expect({
      journalUnchanged: rawAfterInspection === newerJournal,
      oldReceiptVerified: /transaction confirmed/i.test(outcomeText),
      newerPendingVisible: pendingText.includes(`nonce ${oldTransaction.nonce + 1}`)
    }).toEqual({ journalUnchanged: true, oldReceiptVerified: true, newerPendingVisible: true });
  }, 45_000);

  it("does not persist or reconcile wallet B while wallet A pending lookup is delayed", async () => {
    const walletB = chain.wallet(chain.treasury).session;
    await walletB.connect();
    const walletBApproval = await act({ kind: "approveUsdc", id: 3n, packId: 0, quantity: 2 }, walletB);
    await openPiece(1n, chain.buyer);
    const accountAKey = journalKey(chain.buyer);
    const accountBKey = journalKey(chain.treasury);
    const accountAPrefix = `labx:outcome:v1:${chain.manifest.chainId}:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${chain.buyer.toLowerCase()}:`;
    const accountAJournal = JSON.stringify({
      id: "independent-delayed-a-pending",
      intentHash: keccak256(toBytes("wallet-a-original-intent")),
      nonce: 777,
      startedBlock: (await chain.client.getBlockNumber({ cacheTime: 0 })).toString(),
      hash: null
    });
    await fixture.page.evaluate(({ keyA, keyB, valueA }) => {
      localStorage.setItem(keyA, valueA);
      localStorage.removeItem(keyB);
    }, { keyA: accountAKey, keyB: accountBKey, valueA: accountAJournal });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    const recovery = fixture.page.locator(".resume-transaction form");
    await recovery.waitFor({ state: "visible", timeout: 10_000 });
    await recovery.getByLabel("Transaction hash").fill(walletBApproval.hash);
    await fixture.page.evaluate(({ keyA, accountB }) => {
      type Scope = Window & {
        __labxSetAccount(next: string): Promise<void>;
        __pendingRaceWrites: { key: string; value: string }[];
        __restorePendingRace(): void;
      };
      const scope = window as unknown as Scope;
      const originalGet = Storage.prototype.getItem;
      const originalSet = Storage.prototype.setItem;
      let armed = true;
      scope.__pendingRaceWrites = [];
      Storage.prototype.getItem = function (key: string) {
        const value = originalGet.call(this, key);
        if (armed && this === localStorage && key === keyA) {
          armed = false;
          queueMicrotask(() => void scope.__labxSetAccount(accountB));
        }
        return value;
      };
      Storage.prototype.setItem = function (key: string, value: string) {
        scope.__pendingRaceWrites.push({ key, value });
        return originalSet.call(this, key, value);
      };
      scope.__restorePendingRace = () => {
        Storage.prototype.getItem = originalGet;
        Storage.prototype.setItem = originalSet;
      };
    }, { keyA: accountAKey, accountB: chain.treasury });

    await recovery.getByRole("button", { name: "Check transaction", exact: true }).click();
    await expect.poll(() => fixture.page.locator(".wallet-identity").innerText(), { timeout: 10_000 })
      .toContain(`${chain.treasury.slice(0, 6)}…${chain.treasury.slice(-4)}`);
    await fixture.page.waitForTimeout(1_000);
    const storageUnderB = await fixture.page.evaluate(({ keyA, keyB, prefixA, hashB }) => {
      const scope = window as unknown as Window & { __pendingRaceWrites: { key: string; value: string }[]; __restorePendingRace(): void };
      const accountACheckpoints = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .filter((key): key is string => typeof key === "string" && key.startsWith(prefixA))
        .map(key => ({ key, value: localStorage.getItem(key) }));
      const result = {
        accountAJournal: localStorage.getItem(keyA),
        accountBJournal: localStorage.getItem(keyB),
        accountBJournalWrites: scope.__pendingRaceWrites.filter(write => write.key === keyB),
        accountACheckpointsWithBHash: accountACheckpoints.filter(item => item.value?.toLowerCase() === hashB.toLowerCase())
      };
      scope.__restorePendingRace();
      return result;
    }, { keyA: accountAKey, keyB: accountBKey, prefixA: accountAPrefix, hashB: walletBApproval.hash });
    const walletBOutcomes = (await fixture.page.locator(".transaction-outcome").allInnerTexts()).join(" ");

    await fixture.switchAccount(chain.buyer);
    await expect.poll(() => fixture.page.locator(".wallet-identity").innerText(), { timeout: 10_000 })
      .toContain(`${chain.buyer.slice(0, 6)}…${chain.buyer.slice(-4)}`);
    const walletAOutcomes = (await fixture.page.locator(".transaction-outcome").allInnerTexts()).join(" ");
    await fixture.page.evaluate((key: string) => localStorage.removeItem(key), accountAKey);

    expect({
      accountAJournalUnchanged: storageUnderB.accountAJournal === accountAJournal,
      accountBJournalUnchanged: storageUnderB.accountBJournal === null,
      accountBJournalWrites: storageUnderB.accountBJournalWrites.length,
      accountACheckpointsWithBHash: storageUnderB.accountACheckpointsWithBHash.length,
      walletBShowsStaleAResult: walletBOutcomes.includes(walletBApproval.hash),
      walletAShowsBResultAfterReturn: walletAOutcomes.includes(walletBApproval.hash)
    }).toEqual({
      accountAJournalUnchanged: true,
      accountBJournalUnchanged: true,
      accountBJournalWrites: 0,
      accountACheckpointsWithBHash: 0,
      walletBShowsStaleAResult: false,
      walletAShowsBResultAfterReturn: false
    });
  }, 60_000);

  it("retires an errored original hash when its actual same-nonce cancellation is reconciled and survives reload", async () => {
    await openPiece(4n, chain.operator);
    const purchase = await reachPurchase();
    await purchase.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });

    let automine = false;
    await chain.rpc("evm_setAutomine", [false]);
    const failedReceipts: string[] = [];
    await fixture.page.route(`${chain.url}/`, async route => {
      const body: unknown = route.request().postDataJSON();
      const requests = Array.isArray(body) ? body : [body];
      const receiptRequest = requests.some(value => typeof value === "object" && value !== null && "method" in value && value.method === "eth_getTransactionReceipt");
      if (receiptRequest) {
        failedReceipts.push(route.request().postData() ?? "");
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    try {
      await review.getByRole("button", { name: "Confirm purchase membership", exact: true }).click();
      const original = fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: "Transaction needs attention" });
      await original.waitFor({ state: "visible", timeout: 20_000 });
      expect(failedReceipts.length).toBeGreaterThan(0);
      const h1 = (await original.innerText()).match(/0x[0-9a-f]{64}/i)?.[0] as Hex | undefined;
      expect(h1).toMatch(/^0x[0-9a-f]{64}$/i);
      const pendingTransaction = await chain.client.getTransaction({ hash: h1! });
      const maxFeePerGas = (pendingTransaction.maxFeePerGas ?? pendingTransaction.gasPrice ?? 1n) * 2n + 1n;
      const maxPriorityFeePerGas = (pendingTransaction.maxPriorityFeePerGas ?? 1n) * 2n + 1n;
      const replacement = await chain.rpc("eth_sendTransaction", [{
        from: chain.operator,
        to: chain.operator,
        value: "0x0",
        data: "0x",
        nonce: toHex(pendingTransaction.nonce),
        gas: toHex(21_000),
        maxFeePerGas: toHex(maxFeePerGas),
        maxPriorityFeePerGas: toHex(maxPriorityFeePerGas)
      }]);
      expect(replacement).toMatch(/^0x[0-9a-f]{64}$/i);
      const h2 = replacement as Hex;
      expect(h2).not.toBe(h1);
      await chain.rpc("evm_setAutomine", [true]);
      automine = true;
      await chain.mine();
      await fixture.page.unroute(`${chain.url}/`);

      const recovery = fixture.page.locator(".resume-transaction form");
      await recovery.waitFor({ state: "visible", timeout: 10_000 });
      await recovery.getByLabel("Transaction hash").fill(h2);
      await recovery.getByRole("button", { name: "Check transaction", exact: true }).click();
      await openWalletActivity(fixture.page);
      const replacementReceipt = fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: h2 });
      await expect.poll(() => replacementReceipt.innerText(), { timeout: 15_000 }).toMatch(/transaction (?:confirmed|replaced)/i);
      await expect.poll(() => fixture.page.evaluate((storageKey: string) => localStorage.getItem(storageKey), journalKey(chain.operator)), { timeout: 10_000 }).toBeNull();

      const staleOriginalBeforeReload = await original.count();
      const agreements = fixture.page.locator(".agreements input[type=checkbox]");
      await agreements.first().waitFor({ state: "visible", timeout: 10_000 });
      const record = fixture.page.getByRole("button", { name: "Sign and record agreement", exact: true });
      const nextPurchase = fixture.page.getByRole("button", { name: "Purchase membership", exact: true });
      let purchaseAvailable = false;
      let agreementRecorded = false;
      const controlsDeadline = Date.now() + 10_000;
      while (Date.now() < controlsDeadline && !purchaseAvailable) {
        for (const checkbox of await agreements.all()) if (!await checkbox.isChecked()) await checkbox.check();
        const recordAvailable = await record.isVisible().catch(() => false) && !await record.isDisabled().catch(() => true);
        if (recordAvailable && !agreementRecorded) { await record.click(); agreementRecorded = true; }
        purchaseAvailable = await nextPurchase.isVisible().catch(() => false) && !await nextPurchase.isDisabled().catch(() => true);
        if (!purchaseAvailable) await fixture.page.waitForTimeout(250);
      }
      const blockedBeforeReload = !purchaseAvailable;

      await fixture.page.reload({ waitUntil: "domcontentloaded" });
      const savedReplacement = fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: h2 });
      await openWalletActivity(fixture.page);
      await savedReplacement.waitFor({ state: "visible", timeout: 10_000 });
      const confirmedReplacement = savedReplacement.getByText("Transaction confirmed", { exact: true });
      await confirmedReplacement.waitFor({ state: "visible", timeout: 10_000 });
      const postReloadText = await fixture.page.locator("#content").innerText();
      const replacementRecovered = await confirmedReplacement.isVisible();
      const postReloadAlerts = await fixture.page.locator("#content [role=alert]").allInnerTexts();
      const unsupportedAfterReload = postReloadAlerts.length > 0 || /not a labx|not supported labx|could not be found|transaction.*not found/i.test(postReloadText);

      expect({ staleOriginalBeforeReload, blockedBeforeReload, replacementRecovered, unsupportedAfterReload }).toEqual({
        staleOriginalBeforeReload: 0,
        blockedBeforeReload: false,
        replacementRecovered: true,
        unsupportedAfterReload: false
      });
    } finally {
      if (!automine) await chain.rpc("evm_setAutomine", [true]);
      await fixture.page.unroute(`${chain.url}/`).catch(() => {});
    }
  }, 90_000);

  it("keeps a local successful purchase receipt and fresh-consent barrier after another tab acknowledges it", async () => {
    await fixture.page.setViewportSize({ width: 1440, height: 900 });
    const buyer = chain.wallet(chain.buyer).session;
    await buyer.connect();
    await act({ kind: "approveUsdc", id: 1n, packId: 0, quantity: 1 }, buyer);
    await openPiece(1n, chain.buyer);
    const purchase = await reachPurchase();
    await purchase.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });
    await review.getByRole("button", { name: "Confirm purchase membership", exact: true }).click();
    const submitted = fixture.page.locator(".resume-transaction .transaction-outcome", { hasText: "Transaction submitted" });
    await submitted.waitFor({ state: "visible", timeout: 10_000 });
    const transactionHash = (await submitted.innerText()).match(/0x[0-9a-f]{64}/i)?.[0];
    if (!transactionHash) throw new Error("The submitted purchase did not render its transaction hash.");
    await chain.mine();
    await chain.mine();
    const localReceipt = fixture.page.locator(".buyer-flow .transaction-state", { hasText: "Purchase confirmed" });
    await localReceipt.waitFor({ state: "visible", timeout: 15_000 });
    expect(await localReceipt.getByText(transactionHash, { exact: true }).innerText()).toBe(transactionHash);
    await expect.poll(() => purchased(1n, chain.buyer), { timeout: 10_000 }).toHaveLength(1);

    const remote = await fixture.context.newPage();
    const sensitiveMethods: string[] = [];
    const request = chain.rpc.bind(chain);
    const rpc = vi.spyOn(chain, "rpc").mockImplementation(async (method, params) => {
      if (method === "eth_sendTransaction" || method === "personal_sign" || method.startsWith("eth_sign")) sensitiveMethods.push(method);
      return request(method, params);
    });
    try {
      const response = await remote.goto(`${fixture.baseUrl}/piece/1`, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      const remoteAccounts = await remote.evaluate(() =>
        (window as unknown as Window & { ethereum: { request(input: { method: string }): Promise<unknown> } }).ethereum
          .request({ method: "eth_accounts" }));
      if (!Array.isArray(remoteAccounts) || !remoteAccounts.every(account => typeof account === "string")) {
        throw new Error("The remote provider did not return a string account list.");
      }
      expect(remoteAccounts.map(account => account.toLowerCase())).toEqual([chain.buyer.toLowerCase()]);
      const remoteReceipt = remote.locator(".buyer-flow .transaction-state", { hasText: "Purchase confirmed" });
      await remoteReceipt.getByText(transactionHash, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      await remote.getByRole("button", { name: "Refresh state", exact: true }).click();
      const remoteAgain = remote.getByRole("button", { name: "Buy again", exact: true });
      await expect.poll(() => remoteAgain.isEnabled(), { timeout: 15_000 }).toBe(true);
      await remoteAgain.click();
      await expect.poll(() => remote.getByText("Purchase confirmed", { exact: true }).count(), { timeout: 10_000 }).toBe(0);

      await localReceipt.getByText(transactionHash, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      expect(sensitiveMethods).toEqual([]);
      await fixture.page.getByRole("button", { name: "Refresh state", exact: true }).click();
      const localAgain = fixture.page.getByRole("button", { name: "Buy again", exact: true });
      await expect.poll(() => localAgain.isEnabled(), { timeout: 15_000 }).toBe(true);
      await localAgain.click();
      await expect.poll(() => fixture.page.getByText("Purchase confirmed", { exact: true }).count(), { timeout: 10_000 }).toBe(0);
      await fixture.page.getByRole("radiogroup", { name: "Membership packs" }).waitFor({ state: "visible", timeout: 10_000 });
      expect(await fixture.page.getByRole("spinbutton", { name: "Quantity" }).inputValue()).toBe("1");
      for (const checkbox of await fixture.page.locator(".agreements input[type=checkbox]").all()) expect(await checkbox.isChecked()).toBe(false);
      expect(await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).count()).toBe(0);
      expect(sensitiveMethods).toEqual([]);
    } finally {
      rpc.mockRestore();
      await remote.close();
    }
  }, 90_000);

  it("does not treat an older same-intent nonce as the current flow's recovered success", async () => {
    const buyer = chain.wallet(chain.buyer).session;
    await buyer.connect();
    const older = await act({ kind: "approveUsdc", id: 1n, packId: 0, quantity: 1 }, buyer);
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 0n], chain.buyer);
    await openPiece(1n, chain.buyer);
    const approve = fixture.page.getByRole("button", { name: "Approve exact USDC", exact: true });
    await approve.waitFor({ state: "visible", timeout: 10_000 });
    await approve.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });

    let failFreshLookup = true;
    const callbackReads: string[] = [];
    await fixture.page.route(`${chain.url}/`, async route => {
      const payload: unknown = route.request().postDataJSON();
      if (typeof payload === "object" && payload !== null && "method" in payload && payload.method === "eth_getTransactionByHash" && failFreshLookup) {
        failFreshLookup = false;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: "id" in payload ? payload.id : null, error: { code: -32602, message: "The test RPC rejected this fresh lookup." } })
        });
        return;
      }
      for (const request of Array.isArray(payload) ? payload : [payload]) {
        if (isRaffleSnapshotRead(request)) callbackReads.push(JSON.stringify(request));
      }
      await route.continue();
    });
    try {
      await review.getByRole("button", { name: "Confirm approve exact USDC", exact: true }).click();
      const recovery = fixture.page.locator(".buyer-flow .transaction-state", { hasText: "Reconcile pending wallet activity" });
      await recovery.waitFor({ state: "visible", timeout: 15_000 });
      const freshHash = await recovery.getByLabel("Transaction hash").inputValue();
      expect(freshHash).toMatch(/^0x[0-9a-f]{64}$/i);
      const fresh = await chain.client.getTransaction({ hash: freshHash as Hex });
      const historical = await chain.client.getTransaction({ hash: older.hash });
      expect(fresh.nonce).not.toBe(historical.nonce);

      const key = journalKey(chain.buyer);
      await fixture.page.evaluate((storageKey: string) => localStorage.removeItem(storageKey), key);
      expect(await fixture.page.evaluate((storageKey: string) => localStorage.getItem(storageKey), key)).toBeNull();
      callbackReads.length = 0;
      await recovery.getByLabel("Transaction hash").fill(older.hash);
      await recovery.getByRole("button", { name: "Reconcile transaction", exact: true }).click();
      const historicalState = fixture.page.locator(".buyer-flow .transaction-state", { hasText: older.hash });
      await historicalState.waitFor({ state: "visible", timeout: 15_000 });
      expect({
        neutralReceipts: await historicalState.getByText("Recovered transaction receipt", { exact: true }).count(),
        falseCurrentActionConfirmation: await historicalState.getByText("Confirmed", { exact: true }).count(),
        confirmationCallbackReads: callbackReads.length
      }).toEqual({ neutralReceipts: 1, falseCurrentActionConfirmation: 0, confirmationCallbackReads: 0 });
    } finally {
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 90_000);

  it("accepts the current flow's canonically verified same-nonce fee replacement", async () => {
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 0n], chain.treasury);
    await openPiece(1n, chain.treasury);
    const approve = fixture.page.getByRole("button", { name: "Approve exact USDC", exact: true });
    await approve.waitFor({ state: "visible", timeout: 10_000 });
    await approve.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });

    let automine = false;
    let failFreshLookup = true;
    const callbackReads: string[] = [];
    await chain.rpc("evm_setAutomine", [false]);
    await fixture.page.route(`${chain.url}/`, async route => {
      const payload: unknown = route.request().postDataJSON();
      if (typeof payload === "object" && payload !== null && "method" in payload && payload.method === "eth_getTransactionByHash" && failFreshLookup) {
        failFreshLookup = false;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: "id" in payload ? payload.id : null, error: { code: -32602, message: "The test RPC rejected this fresh lookup." } })
        });
        return;
      }
      for (const request of Array.isArray(payload) ? payload : [payload]) {
        if (isRaffleSnapshotRead(request)) callbackReads.push(JSON.stringify(request));
      }
      await route.continue();
    });
    try {
      await review.getByRole("button", { name: "Confirm approve exact USDC", exact: true }).click();
      const recovery = fixture.page.locator(".buyer-flow .transaction-state", { hasText: "Reconcile pending wallet activity" });
      await recovery.waitFor({ state: "visible", timeout: 15_000 });
      const originalHash = await recovery.getByLabel("Transaction hash").inputValue() as Hex;
      const original = await chain.client.getTransaction({ hash: originalHash });
      if (!original.to) throw new Error("The owned approval did not have a transaction target.");
      const maxFeePerGas = (original.maxFeePerGas ?? original.gasPrice ?? 1n) * 2n + 1n;
      const maxPriorityFeePerGas = (original.maxPriorityFeePerGas ?? 1n) * 2n + 1n;
      const replacement = await chain.rpc("eth_sendTransaction", [{
        from: chain.treasury,
        to: original.to,
        value: toHex(original.value),
        data: original.input,
        nonce: toHex(original.nonce),
        gas: toHex(original.gas),
        maxFeePerGas: toHex(maxFeePerGas),
        maxPriorityFeePerGas: toHex(maxPriorityFeePerGas)
      }]);
      expect(replacement).toMatch(/^0x[0-9a-f]{64}$/i);
      const replacementHash = replacement as Hex;
      expect(replacementHash).not.toBe(originalHash);
      await chain.rpc("evm_setAutomine", [true]);
      automine = true;
      await chain.mine();
      await chain.mine();
      const canonical = await chain.client.getTransaction({ hash: replacementHash });
      expect(canonical.nonce).toBe(original.nonce);
      expect({ to: canonical.to, data: canonical.input, value: canonical.value }).toEqual({ to: original.to, data: original.input, value: original.value });

      callbackReads.length = 0;
      await recovery.getByLabel("Transaction hash").fill(replacementHash);
      await recovery.getByRole("button", { name: "Reconcile transaction", exact: true }).click();
      await expect.poll(() => callbackReads.length, { timeout: 15_000 }).toBeGreaterThan(0);
      await fixture.page.locator(".agreements input[type=checkbox]").first().waitFor({ state: "visible", timeout: 15_000 });
      expect(await fixture.page.getByText("Recovered transaction receipt", { exact: true }).count()).toBe(0);
      await expect.poll(() => fixture.page.evaluate((storageKey: string) => localStorage.getItem(storageKey), journalKey(chain.treasury)), { timeout: 10_000 }).toBeNull();
    } finally {
      if (!automine) await chain.rpc("evm_setAutomine", [true]);
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 90_000);

  it("renders a cold self-cancellation neutrally after the current flow's journal was cleared", async () => {
    await chain.write(chain.usdc, "approve", [chain.raffle.address, 0n], chain.operator);
    await openPiece(1n, chain.operator);
    const approve = fixture.page.getByRole("button", { name: "Approve exact USDC", exact: true });
    await approve.waitFor({ state: "visible", timeout: 10_000 });
    await approve.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });

    let automine = false;
    let failFreshLookup = true;
    const callbackReads: string[] = [];
    await chain.rpc("evm_setAutomine", [false]);
    await fixture.page.route(`${chain.url}/`, async route => {
      const payload: unknown = route.request().postDataJSON();
      if (typeof payload === "object" && payload !== null && "method" in payload && payload.method === "eth_getTransactionByHash" && failFreshLookup) {
        failFreshLookup = false;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: "id" in payload ? payload.id : null, error: { code: -32602, message: "The test RPC rejected this fresh lookup." } })
        });
        return;
      }
      for (const request of Array.isArray(payload) ? payload : [payload]) {
        if (isRaffleSnapshotRead(request)) callbackReads.push(JSON.stringify(request));
      }
      await route.continue();
    });
    try {
      await review.getByRole("button", { name: "Confirm approve exact USDC", exact: true }).click();
      const recovery = fixture.page.locator(".buyer-flow .transaction-state", { hasText: "Reconcile pending wallet activity" });
      await recovery.waitFor({ state: "visible", timeout: 15_000 });
      const originalHash = await recovery.getByLabel("Transaction hash").inputValue() as Hex;
      const original = await chain.client.getTransaction({ hash: originalHash });
      const maxFeePerGas = (original.maxFeePerGas ?? original.gasPrice ?? 1n) * 2n + 1n;
      const maxPriorityFeePerGas = (original.maxPriorityFeePerGas ?? 1n) * 2n + 1n;
      const cancellation = await chain.rpc("eth_sendTransaction", [{
        from: chain.operator,
        to: chain.operator,
        value: "0x0",
        data: "0x",
        nonce: toHex(original.nonce),
        gas: toHex(21_000),
        maxFeePerGas: toHex(maxFeePerGas),
        maxPriorityFeePerGas: toHex(maxPriorityFeePerGas)
      }]);
      expect(cancellation).toMatch(/^0x[0-9a-f]{64}$/i);
      const cancellationHash = cancellation as Hex;
      await chain.rpc("evm_setAutomine", [true]);
      automine = true;
      await chain.mine();
      await chain.mine();
      const canonical = await chain.client.getTransaction({ hash: cancellationHash });
      expect(canonical.nonce).toBe(original.nonce);
      expect({ from: canonical.from.toLowerCase(), to: canonical.to?.toLowerCase(), data: canonical.input })
        .toEqual({ from: chain.operator.toLowerCase(), to: chain.operator.toLowerCase(), data: "0x" });

      const key = journalKey(chain.operator);
      await fixture.page.evaluate((storageKey: string) => localStorage.removeItem(storageKey), key);
      callbackReads.length = 0;
      await recovery.getByLabel("Transaction hash").fill(cancellationHash);
      await recovery.getByRole("button", { name: "Reconcile transaction", exact: true }).click();
      const cancellationState = fixture.page.locator(".buyer-flow .transaction-state", { hasText: cancellationHash });
      await cancellationState.waitFor({ state: "visible", timeout: 15_000 });
      await fixture.page.waitForLoadState("networkidle");
      expect({
        neutralReceipts: await cancellationState.getByText("Recovered transaction receipt", { exact: true }).count(),
        falseCurrentActionConfirmation: await cancellationState.getByText("Confirmed", { exact: true }).count(),
        confirmationCallbackReads: callbackReads.length,
        journal: await fixture.page.evaluate((storageKey: string) => localStorage.getItem(storageKey), key)
      }).toEqual({ neutralReceipts: 1, falseCurrentActionConfirmation: 0, confirmationCallbackReads: 0, journal: null });
    } finally {
      if (!automine) await chain.rpc("evm_setAutomine", [true]);
      await fixture.page.unroute(`${chain.url}/`);
    }
  }, 90_000);
});
