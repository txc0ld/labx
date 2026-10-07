import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes, type Address } from "viem";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_PRIVATE_RECORDS_BROWSER === "1" ? describe : describe.skip;

type BrowserRoute = {
  request(): { postDataJSON(): unknown };
  fulfill(input: { status: number; contentType: string; body: string }): Promise<void>;
};

type PendingReceipt = {
  recipient: string;
  respond(input: { status?: number; delivered?: boolean; reason?: string }): Promise<void>;
};

type PendingRecords = {
  respond(input?: { receiptStatus?: "missing" | "pending" | "delivered"; raffleId?: string }): Promise<void>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object request body.");
  return Object.fromEntries(Object.entries(value));
}

run("wallet-scoped private-record feedback", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  const pendingReceipts: PendingReceipt[] = [];
  const pendingRecords: PendingRecords[] = [];
  let holdNextRecords = false;
  const savedEmail = "receipts@example.test";

  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    const tokenId = 701n;
    const commitment = keccak256(toBytes("private-record-feedback"));
    await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      tokenId,
      block.timestamp + 86_400n,
      commitment,
      commitment,
      "Receipt feedback fixture",
      [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, tokenId], chain.seller);
    await chain.write(chain.raffle, "escrow", [1n], chain.seller);
    await chain.admit(1n);
    await chain.write(chain.raffle, "open", [1n], chain.seller);
    for (const account of [chain.buyer, chain.stranger]) {
      await chain.write(chain.usdc, "mint", [account, 100_000_000n]);
      await chain.write(chain.usdc, "approve", [chain.raffle.address, 27_500_000n], account);
      await chain.write(chain.raffle, "buyPack", [1n, 0, 1, PUBLISHED_TERMS_HASH], account);
    }

    fixture = await browserChain(chain, chain.buyer);
    await fixture.page.addInitScript((email: string) => {
      window.localStorage.setItem("labx-preferences-v1", JSON.stringify({ email }));
    }, savedEmail);
    await fixture.page.route("**/api/records", async (route: BrowserRoute) => {
      const body = record(route.request().postDataJSON());
      const input = record(body.input);
      const purchases = Array.isArray(input.purchases) ? input.purchases : [];
      const raffleIds = Array.isArray(input.raffleIds) ? input.raffleIds : [];
      const respond = async (response: { receiptStatus?: "missing" | "pending" | "delivered"; raffleId?: string } = {}) => {
        const receipts = purchases.map((value) => {
          const purchase = record(value);
          return { transactionHash: purchase.transactionHash, logIndex: purchase.logIndex, status: response.receiptStatus ?? "missing" };
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, receipts, agreements: (response.raffleId ? [response.raffleId] : raffleIds).map(raffleId => ({ raffleId, recorded: true, at: null })) })
        });
      };
      if (!holdNextRecords) return respond();
      holdNextRecords = false;
      await new Promise<void>((resolve) => {
        pendingRecords.push({ async respond(input) { await respond(input); resolve(); } });
      });
    });
    await fixture.page.route("**/api/email/receipt", async (route: BrowserRoute) => {
      const body = record(route.request().postDataJSON());
      const recipient = typeof body.to === "string" ? body.to : "";
      await new Promise<void>((resolve) => {
        pendingReceipts.push({
          recipient,
          async respond(input) {
            await route.fulfill({
              status: input.status ?? 200,
              contentType: "application/json",
              body: JSON.stringify(input.status && input.status >= 400
                ? { ok: false, error: input.reason ?? "Delayed delivery failed." }
                : { ok: true, delivered: input.delivered ?? true, reason: input.reason })
            });
            resolve();
          }
        });
      });
    });
  }, 45_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  function short(account: Address) {
    return `${account.slice(0, 6)}…${account.slice(-4)}`;
  }

  async function waitForAccount(account: Address) {
    await expect.poll(async () => (await fixture.page.locator(".wallet-identity").allInnerTexts()).join(" "), { timeout: 10_000 }).toContain(short(account));
  }

  async function switchAccount(account: Address) {
    await fixture.switchAccount(account);
    await waitForAccount(account);
  }

  async function openRecords(account: Address) {
    const response = await fixture.page.goto(`${fixture.baseUrl}/profile/receipts`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await waitForAccount(account);
    const load = fixture.page.getByRole("button", { name: "Sign to load records", exact: true });
    await load.waitFor({ state: "visible", timeout: 10_000 });
    await load.click();
    await fixture.page.getByRole("heading", { name: "Receipts", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  }

  async function reloadRecords(account: Address) {
    await expect.poll(async () => (await fixture.page.locator(".wallet-identity").allInnerTexts()).join(" "), { timeout: 10_000 }).toContain(short(account));
    const load = fixture.page.getByRole("button", { name: "Sign to load records", exact: true });
    await load.waitFor({ state: "visible", timeout: 10_000 });
    await load.click();
    await fixture.page.getByRole("heading", { name: "Receipts", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  }

  async function startDelivery() {
    const before = pendingReceipts.length;
    await fixture.page.getByRole("button", { name: "Sign and send receipt", exact: true }).click();
    await expect.poll(() => pendingReceipts.length, { timeout: 10_000 }).toBe(before + 1);
    return pendingReceipts[before];
  }

  async function startRecordLoad() {
    const before = pendingRecords.length;
    const load = fixture.page.getByRole("button", { name: "Sign to load records", exact: true });
    await load.waitFor({ state: "visible", timeout: 10_000 });
    await load.click();
    await expect.poll(() => pendingRecords.length, { timeout: 10_000 }).toBe(before + 1);
    return pendingRecords[before];
  }

  async function setFixtureSession(input: { chainId: number; account: Address; connected?: boolean }) {
    await fixture.page.evaluate(async ({ nextChainId, currentAccount, connected }: { nextChainId: number; currentAccount: string; connected: boolean }) => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type FixtureWindow = Window & {
        ethereum: { request: Request };
        __labxSetAccount(next: string): Promise<void>;
        __labxOriginalRequest?: Request;
        __labxFixtureChainId?: number;
        __labxFixtureConnected?: boolean;
      };
      const scope = window as unknown as FixtureWindow;
      scope.__labxOriginalRequest ??= scope.ethereum.request.bind(scope.ethereum);
      const original = scope.__labxOriginalRequest;
      scope.__labxFixtureChainId = nextChainId;
      scope.__labxFixtureConnected = connected;
      scope.ethereum.request = request => {
        if (request.method === "eth_chainId") return Promise.resolve(`0x${(scope.__labxFixtureChainId ?? 31337).toString(16)}`);
        if ((request.method === "eth_accounts" || request.method === "eth_requestAccounts") && scope.__labxFixtureConnected === false) return Promise.resolve([]);
        return original(request);
      };
      await scope.__labxSetAccount(currentAccount);
    }, { nextChainId: input.chainId, currentAccount: input.account, connected: input.connected ?? true });
  }

  it("drops delayed receipt feedback across wallet revisions, accounts, networks and route lifetimes", async () => {
    await openRecords(chain.buyer);

    const oldSuccess = await startDelivery();
    await switchAccount(chain.stranger);
    await reloadRecords(chain.stranger);
    await switchAccount(chain.buyer);
    await reloadRecords(chain.buyer);
    const currentSuccess = await startDelivery();
    const requestCount = pendingReceipts.length;
    await oldSuccess.respond({ delivered: true });
    await expect.poll(async () => fixture.page.getByText("Delivered", { exact: true }).count()).toBe(0);
    await expect.poll(async () => fixture.page.getByText("Not delivered", { exact: true }).count()).toBe(1);
    await expect.poll(async () => (await fixture.page.locator('[role="alert"]').allInnerTexts()).join(" ")).not.toMatch(/wallet or network changed/i);
    const sending = fixture.page.getByRole("button", { name: "Sending…", exact: true });
    await expect.poll(async () => sending.isDisabled()).toBe(true);
    await sending.click({ force: true });
    await fixture.page.waitForTimeout(100);
    expect(pendingReceipts).toHaveLength(requestCount);
    await currentSuccess.respond({ delivered: true });
    await fixture.page.getByText("Delivered", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    await switchAccount(chain.buyer);
    await expect.poll(async () => fixture.page.getByRole("button", { name: "Sign to load records", exact: true }).count()).toBe(1);
    holdNextRecords = true;
    const staleRecords = await startRecordLoad();
    await switchAccount(chain.stranger);
    await reloadRecords(chain.stranger);
    await switchAccount(chain.buyer);
    await reloadRecords(chain.buyer);
    await staleRecords.respond({ receiptStatus: "delivered", raffleId: "999" });
    await expect.poll(async () => fixture.page.getByText("Delivered", { exact: true }).count()).toBe(0);
    await expect.poll(async () => fixture.page.getByText("Raffle #999", { exact: true }).count()).toBe(0);

    const oldError = await startDelivery();
    await switchAccount(chain.stranger);
    await reloadRecords(chain.stranger);
    await oldError.respond({ status: 503, reason: "Delayed wallet A failure." });
    await expect.poll(async () => (await fixture.page.locator('[role="alert"]').allInnerTexts()).join(" ")).not.toMatch(/Delayed wallet A failure/i);

    await switchAccount(chain.buyer);
    await reloadRecords(chain.buyer);
    const disconnected = await startDelivery();
    await setFixtureSession({ chainId: 1, account: chain.buyer });
    await fixture.page.getByText("Wrong network", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.getByRole("button", { name: "Disconnect wallet", exact: true }).click();
    await setFixtureSession({ chainId: 31337, account: chain.buyer });
    await fixture.page.getByRole("button", { name: "Browser wallet", exact: true }).click();
    await reloadRecords(chain.buyer);
    await disconnected.respond({ delivered: true });
    await expect.poll(async () => fixture.page.getByText("Not delivered", { exact: true }).count()).toBe(1);
    await expect.poll(async () => (await fixture.page.locator('[role="alert"]').allInnerTexts()).join(" ")).not.toMatch(/wallet or network changed/i);

    const wrongNetwork = await startDelivery();
    await setFixtureSession({ chainId: 1, account: chain.buyer });
    await fixture.page.getByText("Wrong network", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await wrongNetwork.respond({ status: 503, reason: "Delayed old-network failure." });
    await expect.poll(async () => (await fixture.page.locator('[role="alert"]').allInnerTexts()).join(" ")).not.toMatch(/Delayed old-network failure/i);
    await setFixtureSession({ chainId: 31337, account: chain.buyer });
    await reloadRecords(chain.buyer);

    const unmounted = await startDelivery();
    await fixture.page.goto(`${fixture.baseUrl}/profile`, { waitUntil: "domcontentloaded" });
    await openRecords(chain.buyer);
    await unmounted.respond({ delivered: true });
    await expect.poll(async () => fixture.page.getByText("Not delivered", { exact: true }).count()).toBe(1);
  }, 90_000);

  it("shows the saved recipient and prevents duplicate sends in the current wallet session", async () => {
    await setFixtureSession({ chainId: 31337, account: chain.buyer });
    await openRecords(chain.buyer);
    await expect.poll(async () => fixture.page.getByText(savedEmail, { exact: false }).count()).toBe(1);
    await expect.poll(async () => fixture.page.getByText(/saved browser preference.*not a verified wallet identity/i).count()).toBe(1);

    const before = pendingReceipts.length;
    const delivery = await startDelivery();
    expect(delivery.recipient).toBe(savedEmail);
    const send = fixture.page.getByRole("button", { name: "Sending…", exact: true });
    await expect.poll(async () => send.isDisabled()).toBe(true);
    await send.click({ force: true });
    await fixture.page.waitForTimeout(100);
    expect(pendingReceipts).toHaveLength(before + 1);
    await delivery.respond({ delivered: true });
    await fixture.page.getByText("Delivered", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  }, 45_000);
});
