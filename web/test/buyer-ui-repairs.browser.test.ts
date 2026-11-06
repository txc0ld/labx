import { openWalletActivity } from "./fixtures/wallet-activity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Locator } from "playwright";
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, toBytes, type Address } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";
import { watchWallet } from "./fixtures/wallet-watch";

const run = process.env.RUN_BUYER_UI_REPAIRS_BROWSER === "1" ? describe : describe.skip;

const APPROVE = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x0000000000000000000000000000000000000000", 0n] }).slice(0, 10);

run("buyer UI repair invariants in a rendered browser", () => {
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
    const reserve = keccak256(toBytes(`buyer-ui-${tokenId.toString()}`));
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
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    const identity = fixture.page.locator(".wallet-identity", { hasText: `${account.slice(0, 6)}…${account.slice(-4)}` });
    await expect.poll(async () => await connect.isVisible().catch(() => false) || await identity.isVisible().catch(() => false), { timeout: 15_000 }).toBe(true);
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await identity.waitFor({ state: "visible", timeout: 15_000 });
  }

  /** The button is inside the viewport, on top, and no element between it and the page scrolls on its own. */
  async function expectFullyOnScreen(button: Locator) {
    await button.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => button.evaluate(element => {
      const box = element.getBoundingClientRect();
      const inside = box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= document.documentElement.clientWidth;
      let innerScroll = false;
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) innerScroll = true;
      }
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { inside, innerScroll, onTop: top !== null && element.contains(top) };
    }), { timeout: 5_000 }).toEqual({ inside: true, innerScroll: false, onTop: true });
  }

  beforeAll(async () => {
    chain = await localChain();
    service = chain.service;
    seller = chain.wallet(chain.seller).session;
    await seller.connect();
    await chain.write(chain.nft, "mint", [chain.seller, 901n]);
    await chain.write(chain.nft, "mint", [chain.seller, 902n]);
    await chain.write(chain.nft, "mint", [chain.seller, 903n]);
    await chain.write(chain.usdc, "mint", [chain.buyer, 2_000_000_000n]);
    await chain.write(chain.usdc, "mint", [chain.stranger, 2_000_000_000n]);
    expect(await createOpenRaffle(901n, "Exact selection raffle", standardMembershipPacks((tier) => ({
      priceUsdc: tier === "Entry" ? 10_000_000n : tier === "Gold" ? 50_000_000n : 20_000_000n,
      bonusEntries: tier === "Gold" ? 7 : 1,
      maxSupply: 20
    })))).toBe(1n);
    expect(await createOpenRaffle(902n, "Recovery account raffle", standardMembershipPacks(() => ({ priceUsdc: 15_000_000n, bonusEntries: 1, maxSupply: 20 })))).toBe(2n);
    expect(await createOpenRaffle(903n, "Refreshing selection raffle", standardMembershipPacks((tier) => ({
      priceUsdc: tier === "Entry" ? 10_000_000n : 20_000_000n,
      bonusEntries: tier === "Entry" ? 1 : 2,
      maxSupply: tier === "Entry" ? 1 : 20
    })))).toBe(3n);
    fixture = await browserChain(chain, chain.buyer);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  it("keeps catalog status, fee-inclusive price and deadline in each raffle link name", async () => {
    const response = await fixture.page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const card = fixture.page.getByRole("link", { name: /Exact selection raffle[\s\S]*Open[\s\S]*From 12\.50 USDC incl\. fee[\s\S]*Sales end/i });
    await card.waitFor({ state: "visible", timeout: 10_000 });
  }, 30_000);

  it("keeps a non-default pack and quantity through approval, purchases that exact choice in one click, and keeps confirmation visible", async () => {
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await openPiece(1n, chain.buyer);
    const wallet = await watchWallet(fixture.page);

    const gold = fixture.page.getByRole("radio", { name: /Gold/ });
    await fixture.page.locator("label.squishy-pack-card").filter({ hasText: "Gold" }).click();
    const quantity = fixture.page.getByRole("spinbutton", { name: "Quantity", exact: true });
    await expect(quantity.getAttribute("max")).resolves.toBe("20");
    await quantity.fill("21");
    await fixture.page.getByText(/quantity must be a whole number from 1 to 20/i).waitFor({ state: "visible" });
    await quantity.fill("3");
    const buy = fixture.page.getByRole("button", { name: "Buy for 153.00 USDC", exact: true });
    await buy.waitFor({ state: "visible", timeout: 10_000 });
    expect(await buy.isDisabled()).toBe(true);
    expect(await fixture.page.getByText(/Plus a processing fee of 2% or 2\.50 USDC per purchase, whichever is more\. Not refunded\./).count()).toBe(1);
    const agreements = fixture.page.locator(".agreements input[type=checkbox]");
    expect(await agreements.count()).toBe(1);
    await agreements.check();
    await expect.poll(() => buy.isEnabled(), { timeout: 10_000 }).toBe(true);
    expect(await gold.isChecked()).toBe(true);
    await buy.click();

    const confirmed = fixture.page.locator(".transaction-state", { hasText: "You’re in" });
    await confirmed.waitFor({ state: "visible", timeout: 30_000 });
    // The exact choice reached the wallet: an approval of exactly its total, then that pack and quantity. No review, no signature.
    const requests = await wallet.requests();
    expect(requests.map(request => request.method)).toEqual(["eth_sendTransaction", "eth_sendTransaction"]);
    expect(decodeFunctionData({ abi: erc20Abi, data: requests[0].data as `0x${string}` }).args).toEqual([chain.raffle.address, 153_000_000n]);
    expect(decodeFunctionData({ abi: raffleAbi, data: requests[1].data as `0x${string}` }).args).toEqual([1n, 3, 3, PUBLISHED_TERMS_HASH]);
    expect(await wallet.reviews()).toBe(0);
    expect(await confirmed.innerText()).toContain("3 × Gold, 21 bonus entries.");
    await confirmed.locator("summary", { hasText: "Transaction details" }).click();
    const confirmationText = await confirmed.innerText();
    expect(confirmationText).toMatch(/Confirmed in block \d+/);
    expect(confirmationText).toMatch(/0x[0-9a-f]{64}/i);
    await fixture.page.waitForTimeout(500);
    expect(await confirmed.locator(".hash").innerText()).toBe(confirmationText.match(/0x[0-9a-f]{64}/i)?.[0]);
    expect(await confirmed.innerText()).toMatch(/Confirmed in block \d+/);
    expect(await fixture.page.getByRole("button", { name: /^Buy for / }).count()).toBe(0);

    const account = await service.readAccount({ id: 1n, account: chain.buyer });
    expect(account).toMatchObject({ principal: 150_000_000n, fee: 3_000_000n });
    expect(await chain.client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "allowance", args: [chain.buyer, chain.raffle.address] })).toBe(0n);

    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByText("You’re in", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.getByRole("button", { name: "Refresh", exact: true }).click();
    const again = fixture.page.getByRole("button", { name: "Buy again", exact: true });
    await expect.poll(() => again.isEnabled(), { timeout: 15_000 }).toBe(true);
    await again.click();
    await expect.poll(() => fixture.page.getByText("You’re in", { exact: true }).count(), { timeout: 10_000 }).toBe(0);
    expect(await quantity.inputValue()).toBe("1");
    expect(await fixture.page.locator(".agreements input[type=checkbox]").isChecked()).toBe(false);
    await openWalletActivity(fixture.page);
    for (const dismiss of await fixture.page.getByRole("button", { name: "Dismiss receipt", exact: true }).all()) await dismiss.click();
  }, 90_000);

  it("explains a sold-out selection change and lets an unavailable ETH choice return to USDC", async () => {
    await openPiece(3n, chain.buyer);
    await fixture.page.getByRole("radio", { name: "ETH quote", exact: true }).check();
    await fixture.page.locator(".agreements input[type=checkbox]").check();
    const stranger = chain.wallet(chain.stranger).session;
    await stranger.connect();
    await act({ kind: "approveUsdc", id: 3n, packId: 0, quantity: 1 }, stranger);
    await act({ kind: "buyMembership", id: 3n, packId: 0, quantity: 1, acceptedTerms: PUBLISHED_TERMS_HASH, agreements: { terms: true, rules: true, age: true }, payment: { kind: "usdc" } }, stranger);
    await chain.write(chain.feed, "setAnswer", [0n]);
    await fixture.page.getByRole("button", { name: "Refresh", exact: true }).click();
    await fixture.page.getByText("The selected pack is no longer available. Bronze is now selected. Check the new total.", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.getByRole("button", { name: "Use USDC", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Buy for 22.50 USDC", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByRole("radio", { name: /Bronze/ }).isChecked()).toBe(true);
    expect(await fixture.page.locator(".order-total").innerText()).toContain("22.5");
    // The tick covers the terms, rules and age, not one order, so a changed pack keeps it.
    expect(await fixture.page.locator(".agreements input[type=checkbox]").isChecked()).toBe(true);
    expect(await fixture.page.getByText(/tick the box/i).count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Buy for 22.50 USDC", exact: true }).isEnabled()).toBe(true);
    await chain.write(chain.feed, "setAnswer", [2000_00000000n]);
  }, 45_000);

  it("clears only stale recovery feedback after an account switch and leaves the original wallet journal intact", async () => {
    await openPiece(2n, chain.buyer);
    const journalKey = `labx:pending:v1:${chain.manifest.chainId}:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${chain.buyer.toLowerCase()}`;
    const saved = () => fixture.page.evaluate((key: string) => localStorage.getItem(key), journalKey);
    // Nothing is at its nonce and it is new, so the page asks the buyer, once, whether to continue.
    const nonce = await chain.client.getTransactionCount({ address: chain.buyer, blockTag: "pending" });
    const startedBlock = (await chain.client.getBlockNumber()).toString();
    await fixture.page.evaluate(({ key, value }: { key: string; value: string }) => { localStorage.setItem(key, value); }, {
      key: journalKey, value: JSON.stringify({ id: "buyer-ui-recovery", intentHash: keccak256(toBytes("unresolved-buyer-action")), nonce, startedBlock, hash: null })
    });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    const unsent = fixture.page.getByText("Your wallet didn’t send your last transaction.", { exact: true });
    await unsent.first().waitFor({ state: "visible", timeout: 15_000 }).catch(async (error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : "Recovery action did not appear."}\nRendered page:\n${await fixture.page.locator("#content").innerText()}`);
    });

    await fixture.switchAccount(chain.stranger);
    await expect.poll(() => unsent.count(), { timeout: 10_000 }).toBe(0);
    await fixture.page.locator(".agreements input[type=checkbox]").check();
    await fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await saved()).not.toBeNull();

    // Back on the original wallet its record is still there, and Continue clears exactly it.
    await fixture.switchAccount(chain.buyer);
    await unsent.first().waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.getByRole("button", { name: "Continue", exact: true }).first().click();
    await expect.poll(saved, { timeout: 10_000 }).toBeNull();
    await expect.poll(() => unsent.count(), { timeout: 10_000 }).toBe(0);
  }, 60_000);

  it("drops a delayed prepare from an old wallet session and allows the fresh wallet action", async () => {
    await openPiece(2n, chain.buyer);
    const wallet = await watchWallet(fixture.page);
    await fixture.page.locator(".agreements input[type=checkbox]").check();
    await fixture.page.evaluate(() => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Held = { input: { method: string; params?: readonly unknown[] }; resolve(value: unknown): void; reject(error: unknown): void };
      type Scope = Window & {
        ethereum: { request: Request };
        __buyerHeldWalletCalls: number;
        __releaseBuyerWalletCalls(): void;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      const held: Held[] = [];
      let holding = true;
      scope.__buyerHeldWalletCalls = 0;
      scope.ethereum.request = input => {
        if (!holding || input.method !== "eth_accounts") return original(input);
        scope.__buyerHeldWalletCalls += 1;
        return new Promise((resolve, reject) => held.push({ input, resolve, reject }));
      };
      scope.__releaseBuyerWalletCalls = () => {
        holding = false;
        for (const call of held.splice(0)) void original(call.input).then(call.resolve, call.reject);
      };
    });

    await fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ }).click();
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __buyerHeldWalletCalls: number }).__buyerHeldWalletCalls), { timeout: 5_000 }).toBeGreaterThan(0);
    await fixture.switchAccount(chain.stranger);
    await fixture.page.evaluate(() => (window as unknown as Window & { __releaseBuyerWalletCalls(): void }).__releaseBuyerWalletCalls());

    await fixture.page.getByText("You switched wallets, so tick the box again.", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(async () => (await fixture.page.locator(".buyer-flow [role=alert]").allInnerTexts()).join(" "), { timeout: 10_000 }).not.toMatch(/wallet or network changed/i);
    expect(await wallet.requests()).toEqual([]);
    await fixture.page.locator(".agreements input[type=checkbox]").check();
    const fresh = fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ });
    await expect.poll(() => fresh.isEnabled(), { timeout: 10_000 }).toBe(true);
    await wallet.reject(APPROVE);
    await fresh.click();
    await fixture.page.getByText("Cancelled in your wallet. Nothing was sent.", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect((await wallet.requests()).map(request => [request.method, request.from])).toEqual([["eth_sendTransaction", chain.stranger.toLowerCase()]]);
  }, 45_000);

  it("drops a delayed prepare after leaving its raffle route", async () => {
    await openPiece(2n, chain.buyer);
    const wallet = await watchWallet(fixture.page);
    await fixture.page.locator(".agreements input[type=checkbox]").check();
    await fixture.page.evaluate(() => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Held = { input: { method: string; params?: readonly unknown[] }; resolve(value: unknown): void; reject(error: unknown): void };
      type Scope = Window & {
        ethereum: { request: Request };
        __buyerRouteHeldCalls: number;
        __releaseBuyerRouteCalls(): void;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      const held: Held[] = [];
      let holding = true;
      scope.__buyerRouteHeldCalls = 0;
      scope.ethereum.request = input => {
        if (!holding || input.method !== "eth_accounts") return original(input);
        scope.__buyerRouteHeldCalls += 1;
        return new Promise((resolve, reject) => held.push({ input, resolve, reject }));
      };
      scope.__releaseBuyerRouteCalls = () => {
        holding = false;
        for (const call of held.splice(0)) void original(call.input).then(call.resolve, call.reject);
      };
    });

    await fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ }).click();
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __buyerRouteHeldCalls: number }).__buyerRouteHeldCalls), { timeout: 5_000 }).toBeGreaterThan(0);
    await fixture.page.getByRole("link", { name: "Back to explore", exact: true }).click();
    await fixture.page.waitForURL(url => url.pathname === "/", { timeout: 10_000 });
    await fixture.page.evaluate(() => (window as unknown as Window & { __releaseBuyerRouteCalls(): void }).__releaseBuyerRouteCalls());
    await fixture.page.waitForTimeout(500);

    expect(new URL(fixture.page.url()).pathname).toBe("/");
    expect(await fixture.page.locator(".transaction-review, .transaction-state").count()).toBe(0);
    expect(await wallet.requests()).toEqual([]);
    await fixture.page.getByRole("link", { name: /Recovery account raffle/ }).click();
    await fixture.page.waitForURL("**/piece/2");
    await fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await wallet.requests()).toEqual([]);
  }, 45_000);

  it("shows a definite code 5000 wallet refusal as rejected and permits a fresh wallet request", async () => {
    await openPiece(2n, chain.buyer);
    const wallet = await watchWallet(fixture.page);
    await fixture.page.locator(".agreements input[type=checkbox]").check();
    await fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.evaluate(() => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type Scope = Window & { ethereum: { request: Request } };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      let refuse = true;
      scope.ethereum.request = input => {
        if (refuse && input.method === "eth_accounts") {
          refuse = false;
          return Promise.reject({ code: 5000 });
        }
        return original(input);
      };
    });

    await fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ }).click();
    await fixture.page.getByText("Cancelled in your wallet. Nothing was sent.", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await wallet.requests()).toEqual([]);
    await fixture.page.getByRole("button", { name: "Try again", exact: true }).click();
    await wallet.reject(APPROVE);
    await fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ }).click();
    await expect.poll(async () => (await wallet.requests()).map(request => request.method), { timeout: 10_000 }).toEqual(["eth_sendTransaction"]);
    await fixture.page.getByText("Cancelled in your wallet. Nothing was sent.", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  }, 45_000);

  it("keeps the loaded route and choice visible but blocks writes after a failed authoritative refresh", async () => {
    await openPiece(2n, chain.buyer);
    const quantity = fixture.page.getByRole("spinbutton", { name: "Quantity", exact: true });
    await quantity.fill("2");
    await fixture.page.locator(".agreements input[type=checkbox]").check();
    const approve = fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ });
    await expect.poll(() => approve.isEnabled(), { timeout: 10_000 }).toBe(true);
    await fixture.page.route(`${chain.url}/`, route => route.abort("failed"));
    await fixture.page.getByRole("button", { name: "Refresh", exact: true }).click();

    await fixture.page.getByText(/Couldn’t update the raffle:/).waitFor({ state: "visible", timeout: 15_000 });
    expect(await fixture.page.getByRole("heading", { name: "Recovery account raffle", exact: true }).isVisible()).toBe(true);
    expect(await quantity.inputValue()).toBe("2");
    expect(await approve.isDisabled()).toBe(true);

    await fixture.page.unroute(`${chain.url}/`);
    await fixture.page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => approve.isDisabled(), { timeout: 15_000 }).toBe(false);
    expect(await quantity.inputValue()).toBe("2");
  }, 45_000);
  it("keeps expanded seller actions open when an older saved receipt finishes verification", async () => {
    const historical = await chain.write(chain.usdc, "approve", [chain.raffle.address, 100n], chain.seller);
    await chain.mine();
    await chain.mine();
    const hint = historical.transactionHash;
    await fixture.page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: `labx:outcome:v1:31337:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${chain.seller.toLowerCase()}:${hint}`, value: hint
    });
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    await fixture.page.route(`${chain.url}/`, async route => {
      const body: unknown = route.request().postDataJSON();
      if (JSON.stringify(body).includes(hint)) await held;
      await route.continue();
    });
    try {
      // Raffle 2 is live with no sales, so Advanced holds Cancel raffle. Confirm the draw waits for a drawn winner.
      await fixture.switchAccount(chain.seller);
      await fixture.page.goto(`${fixture.baseUrl}/seller/2`, { waitUntil: "domcontentloaded" });
      const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
      const heading = fixture.page.getByRole("heading", { name: "Recovery account raffle", exact: true });
      await expect.poll(async () => await connect.isVisible().catch(() => false) || await heading.isVisible().catch(() => false), { timeout: 15_000 }).toBe(true);
      if (await connect.isVisible().catch(() => false)) await connect.click();
      await heading.waitFor({ state: "visible", timeout: 15_000 });
      const details = fixture.page.locator("details").filter({ has: fixture.page.locator("summary").filter({ hasText: "Advanced (" }) });
      await details.locator("summary").waitFor({ state: "visible", timeout: 15_000 });
      await details.locator("summary").click();
      expect(await details.getAttribute("open")).not.toBeNull();
      expect(await details.getByRole("button", { name: "Confirm the draw", exact: true }).count()).toBe(0);
      release();
      await openWalletActivity(fixture.page);
      const outcome = fixture.page.locator(".transaction-outcome").filter({ hasText: hint });
      await expect.poll(() => outcome.innerText(), { timeout: 10_000 }).toContain("Transaction confirmed");
      await fixture.page.waitForTimeout(300);
      expect(await details.getAttribute("open")).not.toBeNull();
      const cancel = details.getByRole("button", { name: "Cancel raffle", exact: true });
      expect(await cancel.isVisible()).toBe(true);
      expect(await cancel.isEnabled()).toBe(true);
    } finally { release(); await fixture.page.unroute(`${chain.url}/`); }
  }, 30_000);

  it("keeps the agreement and the Buy button fully on screen at 320x700 and 390x844 without inner scrolling", async () => {
    const sizes = [{ width: 320, height: 700 }, { width: 390, height: 844 }];
    const buy = fixture.page.getByRole("button", { name: /^Buy for [\d.,]+ USDC$/ });
    for (const size of sizes) {
      await fixture.page.setViewportSize(size);
      await openPiece(2n, chain.buyer);
      await buy.waitFor({ state: "visible", timeout: 10_000 });
      await expectFullyOnScreen(buy);
      const agreement = fixture.page.locator(".agreements input[type=checkbox]");
      await agreement.scrollIntoViewIfNeeded();
      await agreement.check();
      await expect.poll(() => buy.isEnabled(), { timeout: 10_000 }).toBe(true);
      await expectFullyOnScreen(buy);
      expect(await fixture.page.getByText(/^Your wallet asks twice: first to approve exactly [\d.,]+ USDC, then to buy\.$/).isVisible()).toBe(true);
      expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
    expect((await service.readAccount({ id: 2n, account: chain.buyer })).principal).toBe(0n);
  }, 90_000);

  it("re-reads a raffle with nothing to buy only in the last 15 minutes before its deadline", async () => {
    await chain.write(chain.raffle, "setPaused", [true]);
    const selector = encodeFunctionData({ abi: raffleAbi, functionName: "getRaffle", args: [2n] }).slice(0, 10);
    let reads = 0;
    try {
      await fixture.page.setViewportSize({ width: 1280, height: 900 });
      await fixture.switchAccount(chain.stranger);
      await fixture.page.goto(`${fixture.baseUrl}/piece/2`, { waitUntil: "domcontentloaded" });
      await fixture.page.getByRole("heading", { name: "Sales are paused", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      await fixture.page.waitForLoadState("networkidle");
      await fixture.page.route(`${chain.url}/`, async route => {
        const body: unknown = route.request().postDataJSON();
        for (const request of Array.isArray(body) ? body : [body]) {
          if (!request || typeof request !== "object" || !("method" in request) || request.method !== "eth_call" || !("params" in request) || !Array.isArray(request.params)) continue;
          const call: unknown = request.params[0];
          if (call && typeof call === "object" && "data" in call && typeof call.data === "string" && call.data.startsWith(selector)) reads++;
        }
        await route.continue();
      });
      // More than 15 minutes before the deadline the page stays still.
      await fixture.page.waitForTimeout(20_000);
      expect(reads).toBe(0);

      const { raffle } = await service.readRaffle({ id: 2n });
      await chain.warp(raffle.salesEnd - 600n);
      await fixture.page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => fixture.page.getByRole("button", { name: "Updating…", exact: true }).count(), { timeout: 15_000 }).toBe(0);
      reads = 0;
      await expect.poll(() => reads, { timeout: 25_000 }).toBeGreaterThan(0);
    } finally {
      await fixture.page.unroute(`${chain.url}/`);
      await chain.write(chain.raffle, "setPaused", [false]);
    }
  }, 90_000);
});
