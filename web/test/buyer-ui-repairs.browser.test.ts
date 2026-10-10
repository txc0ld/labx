import { openWalletActivity } from "./fixtures/wallet-activity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, keccak256, toBytes, type Address } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import type { RaffleService, WalletSessionPort } from "../lib/chain/ports";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";

const run = process.env.RUN_BUYER_UI_REPAIRS_BROWSER === "1" ? describe : describe.skip;

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

  it("keeps a non-default pack and quantity through approval, purchases that exact choice, and keeps confirmation visible", async () => {
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    await openPiece(1n, chain.buyer);

    const gold = fixture.page.getByRole("radio", { name: /Gold/ });
    await fixture.page.locator("label.squishy-pack-card").filter({ hasText: "Gold" }).click();
    const quantity = fixture.page.getByRole("spinbutton", { name: "Quantity", exact: true });
    await expect(quantity.getAttribute("max")).resolves.toBe("20");
    await quantity.fill("21");
    await fixture.page.getByText(/quantity must be a whole number from 1 to 20/i).waitFor({ state: "visible" });
    await quantity.fill("3");
    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByText(/Plus a processing fee of 2% or 2\.50 USDC per purchase, whichever is more\. Not refunded\./).count()).toBe(1);

    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).click();
    const approvalReview = fixture.page.locator(".transaction-review");
    await approvalReview.waitFor({ state: "visible", timeout: 10_000 });
    await approvalReview.locator("summary", { hasText: "Transaction details" }).click();
    const approvalText = await approvalReview.innerText();
    expect(approvalText).toMatch(/Raffle\s+#?1/i);
    expect(approvalText).toMatch(/Pack ID\s+3/i);
    expect(approvalText).toMatch(/Quantity\s+3/i);
    expect(approvalText).toContain("153.00 USDC");
    await approvalReview.getByRole("button", { name: "Confirm approval", exact: true }).click();

    await expect.poll(() => gold.isChecked(), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => quantity.inputValue(), { timeout: 15_000 }).toBe("3");
    const agreements = fixture.page.locator(".agreements input[type=checkbox]");
    await agreements.first().waitFor({ state: "visible", timeout: 10_000 });
    const recordAgreement = fixture.page.getByRole("button", { name: "Sign agreement", exact: true });
    await expect.poll(async () => {
      for (const checkbox of await agreements.all()) if (!await checkbox.isChecked()) await checkbox.check();
      return await recordAgreement.isVisible() && await recordAgreement.isEnabled();
    }, { timeout: 10_000 }).toBe(true);
    await recordAgreement.waitFor({ state: "visible", timeout: 10_000 }).catch(async (error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : "Agreement action did not appear."}\nRendered page:\n${await fixture.page.locator("#content").innerText()}`);
    });
    await recordAgreement.click();
    await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).click();
    const purchaseReview = fixture.page.locator(".transaction-review");
    await purchaseReview.waitFor({ state: "visible", timeout: 10_000 });
    await purchaseReview.locator("summary", { hasText: "Transaction details" }).click();
    const purchaseText = await purchaseReview.innerText();
    expect(purchaseText).toMatch(/Raffle\s+#?1/i);
    expect(purchaseText).toMatch(/Pack ID\s+3/i);
    expect(purchaseText).toMatch(/Quantity\s+3/i);
    await purchaseReview.getByRole("button", { name: "Confirm purchase", exact: true }).click();

    const confirmed = fixture.page.locator(".transaction-state", { hasText: "You’re in" });
    await confirmed.waitFor({ state: "visible", timeout: 15_000 });
    expect(await confirmed.innerText()).toContain("3 × Gold, 21 bonus entries.");
    await confirmed.locator("summary", { hasText: "Transaction details" }).click();
    const confirmationText = await confirmed.innerText();
    expect(confirmationText).toMatch(/Confirmed in block \d+/);
    expect(confirmationText).toMatch(/0x[0-9a-f]{64}/i);
    await fixture.page.waitForTimeout(500);
    expect(await confirmed.locator(".hash").innerText()).toBe(confirmationText.match(/0x[0-9a-f]{64}/i)?.[0]);
    expect(await confirmed.innerText()).toMatch(/Confirmed in block \d+/);
    expect(await fixture.page.getByRole("button", { name: "Purchase membership", exact: true }).count()).toBe(0);

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
    for (const checkbox of await fixture.page.locator(".agreements input[type=checkbox]").all()) expect(await checkbox.isChecked()).toBe(false);
    await openWalletActivity(fixture.page);
    for (const dismiss of await fixture.page.getByRole("button", { name: "Dismiss receipt", exact: true }).all()) await dismiss.click();
  }, 90_000);

  it("explains a sold-out selection change and lets an unavailable ETH choice return to USDC", async () => {
    await openPiece(3n, chain.buyer);
    await fixture.page.getByRole("radio", { name: "ETH quote", exact: true }).check();
    for (const checkbox of await fixture.page.locator(".agreements input[type=checkbox]").all()) await checkbox.check();
    const stranger = chain.wallet(chain.stranger).session;
    await stranger.connect();
    await act({ kind: "approveUsdc", id: 3n, packId: 0, quantity: 1 }, stranger);
    await act({ kind: "buyMembership", id: 3n, packId: 0, quantity: 1, acceptedTerms: PUBLISHED_TERMS_HASH, agreements: { terms: true, rules: true, age: true }, payment: { kind: "usdc" } }, stranger);
    await chain.write(chain.feed, "setAnswer", [0n]);
    await fixture.page.getByRole("button", { name: "Refresh", exact: true }).click();
    await fixture.page.getByText(/The selected pack is no longer available. Bronze is now selected/).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.getByText("Your order changed, so tick the boxes again.", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.getByRole("button", { name: "Use USDC", exact: true }).click();
    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByRole("radio", { name: /Bronze/ }).isChecked()).toBe(true);
    expect(await fixture.page.locator(".order-total").innerText()).toContain("22.5");
    for (const checkbox of await fixture.page.locator(".agreements input[type=checkbox]").all()) expect(await checkbox.isChecked()).toBe(false);
    await chain.write(chain.feed, "setAnswer", [2000_00000000n]);
  }, 45_000);

  it("clears only stale recovery feedback after an account switch and leaves the original wallet journal intact", async () => {
    await openPiece(2n, chain.buyer);
    const journalKey = `labx:pending:v1:${chain.manifest.chainId}:${chain.manifest.address.toLowerCase()}:${chain.manifest.runtimeCodeHash.toLowerCase()}:${chain.buyer.toLowerCase()}`;
    await fixture.page.evaluate(({ key, intentHash }: { key: string; intentHash: string }) => {
      localStorage.setItem(key, JSON.stringify({ id: "buyer-ui-recovery", intentHash, nonce: 9, startedBlock: "1", hash: null }));
    }, { key: journalKey, intentHash: keccak256(toBytes("unresolved-buyer-action")) });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.locator(".buyer-flow").getByText("Your last transaction needs a check", { exact: true }).waitFor({ state: "visible", timeout: 10_000 }).catch(async (error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : "Recovery action did not appear."}\nRendered page:\n${await fixture.page.locator("#content").innerText()}`);
    });

    await fixture.switchAccount(chain.stranger);
    await expect.poll(async () => fixture.page.locator(".buyer-flow").getByText("Your last transaction needs a check", { exact: true }).count(), { timeout: 10_000 }).toBe(0);
    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.evaluate((key: string) => localStorage.getItem(key), journalKey)).not.toBeNull();
    await fixture.page.evaluate((key: string) => localStorage.removeItem(key), journalKey);
  }, 45_000);

  it("drops a delayed prepare from an old wallet session and allows the fresh wallet action", async () => {
    await openPiece(2n, chain.buyer);
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

    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).click();
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __buyerHeldWalletCalls: number }).__buyerHeldWalletCalls), { timeout: 5_000 }).toBeGreaterThan(0);
    await fixture.switchAccount(chain.stranger);
    await fixture.page.evaluate(() => (window as unknown as Window & { __releaseBuyerWalletCalls(): void }).__releaseBuyerWalletCalls());

    await expect.poll(async () => fixture.page.locator(".transaction-review").count(), { timeout: 10_000 }).toBe(0);
    await expect.poll(async () => (await fixture.page.locator(".buyer-flow [role=alert]").allInnerTexts()).join(" "), { timeout: 10_000 }).not.toMatch(/wallet or network changed/i);
    const fresh = fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ });
    await fresh.waitFor({ state: "visible", timeout: 10_000 });
    await fresh.click();
    const review = fixture.page.locator(".transaction-review");
    await review.waitFor({ state: "visible", timeout: 10_000 });
    expect(await review.innerText()).toContain(chain.stranger.slice(0, 6));
  }, 45_000);

  it("drops a delayed prepare after leaving its raffle route", async () => {
    await openPiece(2n, chain.buyer);
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

    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).click();
    await expect.poll(() => fixture.page.evaluate(() => (window as unknown as Window & { __buyerRouteHeldCalls: number }).__buyerRouteHeldCalls), { timeout: 5_000 }).toBeGreaterThan(0);
    await fixture.page.getByRole("link", { name: "Back to explore", exact: true }).click();
    await fixture.page.waitForURL(url => url.pathname === "/", { timeout: 10_000 });
    await fixture.page.evaluate(() => (window as unknown as Window & { __releaseBuyerRouteCalls(): void }).__releaseBuyerRouteCalls());
    await fixture.page.waitForTimeout(500);

    expect(new URL(fixture.page.url()).pathname).toBe("/");
    expect(await fixture.page.locator(".transaction-review, .transaction-state").count()).toBe(0);
    await fixture.page.getByRole("link", { name: /Recovery account raffle/ }).click();
    await fixture.page.waitForURL("**/piece/2");
    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).waitFor({ state: "visible", timeout: 10_000 });
  }, 45_000);

  it("shows a definite code 5000 wallet refusal as rejected and permits a fresh review", async () => {
    await openPiece(2n, chain.buyer);
    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).waitFor({ state: "visible", timeout: 10_000 });
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

    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).click();
    await fixture.page.getByText("Cancelled in your wallet. Nothing was sent.", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.getByRole("button", { name: "Try again", exact: true }).click();
    await fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ }).click();
    await fixture.page.locator(".transaction-review").waitFor({ state: "visible", timeout: 10_000 });
  }, 45_000);

  it("keeps the loaded route and choice visible but blocks writes after a failed authoritative refresh", async () => {
    await openPiece(2n, chain.buyer);
    const quantity = fixture.page.getByRole("spinbutton", { name: "Quantity", exact: true });
    await quantity.fill("2");
    const approve = fixture.page.getByRole("button", { name: /^Approve [\d.,]+ USDC$/ });
    await approve.waitFor({ state: "visible", timeout: 10_000 });
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
    const snapshot = await service.readRaffle({ id: 3n });
    const historical = await chain.write(chain.usdc, "approve", [chain.raffle.address, 100n], chain.seller);
    await chain.warp(snapshot.raffle.salesEnd);
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
      await fixture.switchAccount(chain.seller);
      await fixture.page.goto(`${fixture.baseUrl}/seller/3`, { waitUntil: "domcontentloaded" });
      const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
      const heading = fixture.page.getByRole("heading", { name: "Refreshing selection raffle", exact: true });
      await expect.poll(async () => await connect.isVisible().catch(() => false) || await heading.isVisible().catch(() => false), { timeout: 15_000 }).toBe(true);
      if (await connect.isVisible().catch(() => false)) await connect.click();
      await heading.waitFor({ state: "visible", timeout: 15_000 });
      const details = fixture.page.locator("details").filter({ has: fixture.page.locator("summary").filter({ hasText: "Advanced (" }) });
      await details.locator("summary").waitFor({ state: "visible", timeout: 15_000 });
      await details.locator("summary").click();
      expect(await details.getAttribute("open")).not.toBeNull();
      release();
      await openWalletActivity(fixture.page);
      const outcome = fixture.page.locator(".transaction-outcome").filter({ hasText: hint });
      await expect.poll(() => outcome.innerText(), { timeout: 10_000 }).toContain("Transaction confirmed");
      await fixture.page.waitForTimeout(300);
      expect(await details.getAttribute("open")).not.toBeNull();
      expect(await fixture.page.getByRole("button", { name: "Sign to continue", exact: true }).isVisible()).toBe(true);
      expect(await fixture.page.getByRole("button", { name: "Sign to continue", exact: true }).isEnabled()).toBe(true);
    } finally { release(); await fixture.page.unroute(`${chain.url}/`); }
  }, 30_000);

});
