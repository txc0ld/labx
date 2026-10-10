import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, keccak256, toBytes, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { connectWallet } from "./fixtures/connect-wallet";

const run = process.env.RUN_OWNER_REVIEW_RACE_BROWSER === "1" ? describe : describe.skip;
type RpcRequest = { method: string; params?: readonly unknown[] };

run("owner review async lifetimes", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    const commitment = keccak256(toBytes("owner-review-race"));
    await chain.write(chain.nft, "mint", [chain.seller, 771n]);
    await chain.write(chain.raffle, "createRaffle", [chain.nft.address, 771n, block.timestamp + 86_400n, commitment, commitment, "Owner review race", [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 771n], chain.seller);
    await chain.write(chain.raffle, "escrow", [1n], chain.seller);
    fixture = await browserChain(chain, chain.operator);
  }, 60_000);

  afterAll(async () => { await fixture?.close(); chain?.close(); });

  async function openApproval() {
    const response = await fixture.page.goto(`${fixture.baseUrl}/review/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await connectWallet(fixture.page, fixture.page.getByRole("heading", { name: "Approve this raffle", exact: true }));
    expect(await fixture.page.getByRole("checkbox").count()).toBe(0);
    await fixture.page.getByText(/By clicking Approve, I confirm that I checked the canonical collection provenance/).waitFor({ state: "visible" });
  }

  async function hideAutomaticDiscovery() {
    await fixture.page.route(`${chain.url}/`, async route => {
      const body = route.request().postDataJSON() as { id?: number; method?: string } | undefined;
      if (body?.method === "eth_getLogs") await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }) });
      else await route.continue();
    });
  }
  async function restoreAutomaticDiscovery() { await fixture.page.unroute(`${chain.url}/`); }

  it("binds all attestations and sends the exact Safe request from one Approve click", async () => {
    await openApproval();
    await fixture.page.evaluate(() => {
      type Scope = Window & { ethereum: { request(input: RpcRequest): Promise<unknown> }; __ownerRequests: RpcRequest[] };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      scope.__ownerRequests = [];
      scope.ethereum.request = input => { scope.__ownerRequests.push(input); return original(input); };
    });
    await fixture.page.getByRole("button", { name: "Approve", exact: true }).dblclick();
    await fixture.page.getByRole("heading", { name: "Approval recorded", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    const requests = await fixture.page.evaluate(() => (window as unknown as Window & { __ownerRequests: RpcRequest[] }).__ownerRequests.filter(request => request.method === "eth_sendTransaction"));
    expect(requests).toHaveLength(1);
    const params = requests[0]?.params?.[0];
    expect(params).toMatchObject({ from: chain.operator, to: chain.raffle.address, value: "0x0" });
    if (!params || typeof params !== "object" || !("data" in params) || typeof params.data !== "string") throw new Error("Missing owner calldata.");
    const decoded = decodeFunctionData({ abi: raffleAbi, data: params.data as Hex });
    expect(decoded.functionName).toBe("approveRaffle");
    expect(decoded.args[0]).toBe(1n);
    expect(decoded.args[1]).toBe((await chain.service.readAdmission({ id: 1n })).snapshot.admission.record.approvedReviewHash);
  }, 30_000);

  it("persists recovery before dispatch and does not treat a wallet reference as execution", async () => {
    const review = await chain.service.readAdmission({ id: 1n });
    if (review.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    await chain.write(chain.raffle, "revokeRaffleApproval", [1n, review.snapshot.admission.reviewHash]);
    await openApproval();
    await hideAutomaticDiscovery();
    await fixture.page.evaluate(() => {
      type Scope = Window & { ethereum: { request(input: RpcRequest): Promise<unknown> }; __ownerIntentPresentAtDispatch: boolean; __ownerReceiptQueries: number };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      scope.__ownerIntentPresentAtDispatch = false;
      scope.__ownerReceiptQueries = 0;
      scope.ethereum.request = input => {
        if (input.method === "eth_sendTransaction") scope.__ownerIntentPresentAtDispatch = Object.keys(localStorage).some(key => key.startsWith("labx:owner-review:v1:"));
        if (input.method === "eth_getTransactionReceipt") scope.__ownerReceiptQueries += 1;
        return original(input);
      };
    });
    await fixture.page.getByRole("button", { name: "Approve", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __ownerIntentPresentAtDispatch: boolean }).__ownerIntentPresentAtDispatch)).toBe(true);
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __ownerReceiptQueries: number }).__ownerReceiptQueries)).toBe(0);
    expect(await fixture.page.getByText(/wallet acceptance or proposal alone is not approval/i).isVisible()).toBe(true);
    await restoreAutomaticDiscovery();
  }, 30_000);

  it("reloads a pending Safe request for observation without resubmitting it", async () => {
    await hideAutomaticDiscovery();
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.evaluate(() => {
      type Scope = Window & { ethereum: { request(input: RpcRequest): Promise<unknown> }; __ownerReloadSends: number };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      scope.__ownerReloadSends = 0;
      scope.ethereum.request = input => { if (input.method === "eth_sendTransaction") scope.__ownerReloadSends += 1; return original(input); };
    });
    await fixture.page.waitForTimeout(750);
    expect(await fixture.page.evaluate(() => (window as unknown as Window & { __ownerReloadSends: number }).__ownerReloadSends)).toBe(0);
    expect(await fixture.page.getByRole("button", { name: "Approve", exact: true }).count()).toBe(0);
    await restoreAutomaticDiscovery();
  }, 30_000);

  it("reloads an executed revocation only as receipt confirmation recovery", async () => {
    await fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:owner-review:v1:")).forEach(key => localStorage.removeItem(key)));
    const response = await fixture.page.goto(`${fixture.baseUrl}/review/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const prepare = fixture.page.getByRole("button", { name: "Prepare revocation", exact: true });
    await prepare.waitFor({ state: "visible", timeout: 10_000 });
    await prepare.click();
    await fixture.page.getByRole("button", { name: "Download revocation file", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the revocation in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await hideAutomaticDiscovery();
    const review = await chain.service.readAdmission({ id: 1n });
    if (review.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    const receipt = await chain.write(chain.raffle, "revokeRaffleApproval", [1n, review.snapshot.admission.reviewHash]);
    await chain.mine();
    await fixture.page.getByRole("button", { name: "Refresh exact state", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Confirm the recorded revocation", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("heading", { name: "Confirm the recorded revocation", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByRole("button", { name: "Copy exact call fields", exact: true }).count()).toBe(0);
    expect(await fixture.page.getByRole("link", { name: /Open Safe/ }).count()).toBe(0);
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);
    await fixture.page.getByRole("button", { name: "Confirm recorded revocation", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Approval revoked", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await restoreAutomaticDiscovery();
    expect(await fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:owner-review:v1:") && /:\d+$/.test(key)))).toEqual([]);
  }, 30_000);
});
