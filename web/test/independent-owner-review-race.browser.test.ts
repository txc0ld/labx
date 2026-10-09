import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes, zeroHash } from "viem";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_INDEPENDENT_OWNER_REVIEW_RACE_BROWSER === "1" ? describe : describe.skip;

run("independent owner review race verification", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    const commitment = keccak256(toBytes("independent-owner-review-race"));
    for (const id of [1n, 2n, 3n, 4n, 5n, 6n]) {
      const tokenId = 880n + id;
      await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
      await chain.write(chain.raffle, "createRaffle", [
        chain.nft.address,
        tokenId,
        block.timestamp + 86_400n,
        commitment,
        commitment,
        `Independent owner review ${id.toString()}`,
        [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]
      ], chain.seller);
      await chain.write(chain.nft, "approve", [chain.raffle.address, tokenId], chain.seller);
      await chain.write(chain.raffle, "escrow", [id], chain.seller);
    }
    fixture = await browserChain(chain, chain.operator);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  async function openReview(id: bigint) {
    const response = await fixture.page.goto(`${fixture.baseUrl}/review/${id.toString()}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await fixture.page.evaluate(() => localStorage.clear());
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await fixture.page.getByRole("heading", { name: "Choose the current draft action", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  }

  async function openChecklist(id: bigint) {
    await openReview(id);
    await fixture.page.getByRole("button", { name: "Review approval checklist", exact: true }).click();
    for (const checkbox of await fixture.page.locator("fieldset input[type=checkbox]").all()) await checkbox.check();
  }

  async function prepareApproval() {
    await fixture.page.getByRole("button", { name: "Download approval file", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  }

  async function ownerStorageKeys() {
    return fixture.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("labx:owner-review:v1:")));
  }

  async function hideAutomaticDiscovery() {
    await fixture.page.route(`${chain.url}/`, async route => {
      const body = route.request().postDataJSON() as { id?: number; method?: string } | undefined;
      if (body?.method === "eth_getLogs") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }) });
      } else await route.continue();
    });
  }

  async function restoreAutomaticDiscovery() {
    await fixture.page.unroute(`${chain.url}/`);
  }

  it("retires a delayed prepare error after a same-account wallet revision and permits a fresh saved export", async () => {
    await openChecklist(1n);
    await fixture.page.evaluate(() => {
      type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
      type HeldRequest = {
        input: { method: string; params?: readonly unknown[] };
        resolve(value: unknown): void;
        reject(error: unknown): void;
      };
      type Scope = Window & {
        ethereum: { request: Request };
        __ownerHeldCalls: number;
        __stopHoldingOwnerCalls(): void;
        __releaseOwnerCalls(): void;
      };
      const scope = window as unknown as Scope;
      const original = scope.ethereum.request.bind(scope.ethereum);
      const held: HeldRequest[] = [];
      let holding = true;
      scope.__ownerHeldCalls = 0;
      scope.ethereum.request = input => {
        if (!holding || input.method !== "eth_accounts") return original(input);
        scope.__ownerHeldCalls += 1;
        return new Promise((resolve, reject) => held.push({ input, resolve, reject }));
      };
      scope.__stopHoldingOwnerCalls = () => { holding = false; };
      scope.__releaseOwnerCalls = () => {
        for (const request of held.splice(0)) void original(request.input).then(request.resolve, request.reject);
      };
    });

    await fixture.page.getByRole("button", { name: "Download approval file", exact: true }).click();
    await expect.poll(() => fixture.page.evaluate(() =>
      (window as unknown as Window & { __ownerHeldCalls: number }).__ownerHeldCalls), { timeout: 5_000 }).toBeGreaterThan(0);
    await fixture.page.evaluate(async account => {
      type Scope = Window & {
        __labxSetAccount(next: string): Promise<void>;
        __stopHoldingOwnerCalls(): void;
        __releaseOwnerCalls(): void;
      };
      const scope = window as unknown as Scope;
      scope.__stopHoldingOwnerCalls();
      await scope.__labxSetAccount(account);
      scope.__releaseOwnerCalls();
    }, chain.operator);
    await fixture.page.getByRole("heading", { name: "Choose the current draft action", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    await fixture.page.waitForTimeout(250);
    expect(await fixture.page.getByRole("heading", { name: "Owner action unavailable", exact: true }).count()).toBe(0);
    expect(await ownerStorageKeys()).toEqual([]);

    await fixture.page.getByRole("button", { name: "Review approval checklist", exact: true }).click();
    for (const checkbox of await fixture.page.locator("fieldset input[type=checkbox]").all()) await checkbox.check();
    await prepareApproval();
    expect(await ownerStorageKeys()).toHaveLength(1);
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await ownerStorageKeys()).toHaveLength(1);
    expect(await fixture.page.getByRole("button", { name: "Download approval file", exact: true }).isDisabled()).toBe(true);
    await fixture.page.getByText("I already have the executed Ethereum transaction hash", { exact: true }).click();
    expect(await fixture.page.getByLabel("Executed Ethereum transaction hash").isVisible()).toBe(true);
    const reviewAgain = fixture.page.getByRole("button", { name: "Review checklist for a new file", exact: true });
    await expect.poll(() => reviewAgain.isEnabled(), { timeout: 10_000 }).toBe(true);
    await reviewAgain.click();
    for (const checkbox of await fixture.page.locator("fieldset input[type=checkbox]").all()) expect(await checkbox.isChecked()).toBe(false);
    expect(await fixture.page.getByRole("button", { name: "Download approval file", exact: true }).isDisabled()).toBe(true);
  }, 30_000);

  it("does not let an old clipboard completion overwrite a newly exported review", async () => {
    await openChecklist(2n);
    await prepareApproval();
    await fixture.page.evaluate(() => {
      type Scope = Window & { __resolveIndependentOwnerCopy(): void };
      let resolveCopy: (() => void) | undefined;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => new Promise<void>(resolve => { resolveCopy = resolve; }) }
      });
      (window as unknown as Scope).__resolveIndependentOwnerCopy = () => resolveCopy?.();
    });

    await fixture.page.getByText("Manual call fields and technical details", { exact: true }).click();
    await fixture.page.getByRole("button", { name: "Copy exact call fields", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Discard exported review", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Review approval checklist", exact: true }).click();
    for (const checkbox of await fixture.page.locator("fieldset input[type=checkbox]").all()) expect(await checkbox.isChecked()).toBe(false);
    for (const checkbox of await fixture.page.locator("fieldset input[type=checkbox]").all()) await checkbox.check();
    await prepareApproval();
    await fixture.page.evaluate(() =>
      (window as unknown as Window & { __resolveIndependentOwnerCopy(): void }).__resolveIndependentOwnerCopy());

    await fixture.page.waitForTimeout(250);
    await fixture.page.getByText("Manual call fields and technical details", { exact: true }).click();
    expect(await fixture.page.getByRole("button", { name: "Copy exact call fields", exact: true }).count()).toBe(1);
    expect(await fixture.page.getByRole("button", { name: "Payload copied", exact: true }).count()).toBe(0);
    expect(await ownerStorageKeys()).toHaveLength(1);
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  }, 30_000);

  it("retires a deferred confirmation resolved in the same task as a same-account wallet event", async () => {
    await openChecklist(4n);
    await prepareApproval();
    const review = await chain.service.readAdmission({ id: 4n });
    if (review.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    const receipt = await chain.write(chain.raffle, "approveRaffle", [4n, review.snapshot.admission.reviewHash]);
    await chain.mine();
    await hideAutomaticDiscovery();
    await fixture.page.getByText("I already have the executed Ethereum transaction hash", { exact: true }).click();
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);
    await fixture.page.evaluate(() => {
      type HeldResponse = { response: Response; resolve(response: Response): void };
      type Scope = Window & {
        __ownerHeldResponses: number;
        __stopHoldingOwnerResponses(): void;
        __releaseOwnerResponses(): void;
      };
      const scope = window as unknown as Scope;
      const original = window.fetch.bind(window);
      const held: HeldResponse[] = [];
      let holding = true;
      scope.__ownerHeldResponses = 0;
      window.fetch = async (...input) => {
        const response = await original(...input);
        const body = input[1]?.body;
        if (!holding || typeof body !== "string" || !body.includes("eth_getTransactionReceipt")) return response;
        scope.__ownerHeldResponses += 1;
        return new Promise(resolve => held.push({ response, resolve }));
      };
      scope.__stopHoldingOwnerResponses = () => { holding = false; };
      scope.__releaseOwnerResponses = () => {
        for (const item of held.splice(0)) item.resolve(item.response);
      };
    });

    await fixture.page.getByRole("button", { name: "Confirm canonical execution", exact: true }).click();
    await expect.poll(() => fixture.page.evaluate(() =>
      (window as unknown as Window & { __ownerHeldResponses: number }).__ownerHeldResponses), { timeout: 5_000 }).toBeGreaterThan(0);
    await fixture.page.evaluate(async account => {
      type Scope = Window & {
        __labxSetAccount(next: string): Promise<void>;
        __stopHoldingOwnerResponses(): void;
        __releaseOwnerResponses(): void;
      };
      const scope = window as unknown as Scope;
      scope.__stopHoldingOwnerResponses();
      await scope.__labxSetAccount(account);
      scope.__releaseOwnerResponses();
    }, chain.operator);

    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.waitForTimeout(250);
    expect(await fixture.page.getByRole("heading", { name: "Approval recorded", exact: true }).count()).toBe(0);
    expect(await ownerStorageKeys()).toHaveLength(1);
    await restoreAutomaticDiscovery();
  }, 30_000);

  it("reloads an exactly advanced revocation as confirmation-only and confirms its receipt", async () => {
    const approved = await chain.service.readAdmission({ id: 3n });
    if (approved.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    await chain.write(chain.raffle, "approveRaffle", [3n, approved.snapshot.admission.reviewHash]);
    await openReview(3n);
    await fixture.page.getByRole("button", { name: "Prepare revocation", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Download revocation file", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Finish the revocation in Safe", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await hideAutomaticDiscovery();

    const before = await chain.service.readAdmission({ id: 3n });
    if (before.snapshot.admission.reviewHash === null) throw new Error("Approved review hash missing.");
    const receipt = await chain.write(chain.raffle, "revokeRaffleApproval", [3n, before.snapshot.admission.reviewHash]);
    await chain.mine();
    const after = await chain.service.readAdmission({ id: 3n });
    expect(after.snapshot.admission.record.reviewRevision).toBe(before.snapshot.admission.record.reviewRevision + 1n);
    expect(after.ownerGeneration).toBe(before.ownerGeneration);
    expect(after.openingPolicyGeneration).toBe(before.openingPolicyGeneration);
    expect(after.snapshot.owner).toBe(before.snapshot.owner);
    expect(after.snapshot.admission.status).toBe("pending");
    expect(after.snapshot.admission.record.approvedReviewHash).toBe(zeroHash);

    await fixture.page.getByRole("button", { name: "Refresh exact state", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Confirm the recorded revocation", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fixture.page.reload({ waitUntil: "domcontentloaded" });
    await fixture.page.getByRole("heading", { name: "Confirm the recorded revocation", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(await fixture.page.getByRole("button", { name: "Copy exact call fields", exact: true }).count()).toBe(0);
    expect(await fixture.page.getByRole("link", { name: /Open this exact Safe/ }).count()).toBe(0);

    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);
    await fixture.page.getByRole("button", { name: "Confirm recorded revocation", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Approval revoked", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await restoreAutomaticDiscovery();
    expect(await ownerStorageKeys()).toEqual([]);
  }, 30_000);

  it("keeps a confirmed approval receipt historical after the seller changes the draft", async () => {
    await openChecklist(5n);
    await prepareApproval();
    const review = await chain.service.readAdmission({ id: 5n });
    if (review.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    const receipt = await chain.write(chain.raffle, "approveRaffle", [5n, review.snapshot.admission.reviewHash]);
    await chain.mine();
    await fixture.page.getByText("I already have the executed Ethereum transaction hash", { exact: true }).click();
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);
    await fixture.page.getByRole("button", { name: "Confirm canonical execution", exact: true }).click();
    const approvalHeading = fixture.page.getByRole("heading", { name: "Approval recorded", exact: true });
    await approvalHeading.waitFor({ state: "visible", timeout: 15_000 });

    const beforeEdit = await chain.service.readAdmission({ id: 5n });
    await chain.write(chain.raffle, "updateDraft", [
      5n,
      chain.nft.address,
      885n,
      beforeEdit.snapshot.raffle.salesEnd,
      beforeEdit.snapshot.raffle.reserveNonce,
      beforeEdit.snapshot.raffle.reserveCommit,
      "Edited after approval receipt",
      [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]
    ], chain.seller);
    await fixture.page.getByRole("button", { name: "Refresh exact state", exact: true }).click();
    await fixture.page.getByText("Changed since review", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    const receiptPanel = approvalHeading.locator("..");
    expect(await receiptPanel.getByText("Approval execution was confirmed at the block below. Check the current draft status above before opening.", { exact: true }).count()).toBe(1);
    expect(await fixture.page.getByText(/current draft remains approved and can be opened/i).count()).toBe(0);
    expect(await receiptPanel.getByText(receipt.transactionHash, { exact: true }).count()).toBe(1);
    expect(await receiptPanel.getByText(receipt.blockNumber.toString(), { exact: true }).count()).toBe(1);
    await fixture.page.getByRole("button", { name: "Review current state", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Review approval checklist", exact: true }).click();
    for (const checkbox of await fixture.page.locator("fieldset input[type=checkbox]").all()) expect(await checkbox.isChecked()).toBe(false);
    expect(await fixture.page.getByRole("button", { name: "Download approval file", exact: true }).isDisabled()).toBe(true);
  }, 30_000);

  it("requires a fresh checklist after an executed approval is stale against a new digest", async () => {
    await openChecklist(6n);
    await prepareApproval();
    await hideAutomaticDiscovery();
    const before = await chain.service.readAdmission({ id: 6n });
    if (before.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    const receipt = await chain.write(chain.raffle, "approveRaffle", [6n, before.snapshot.admission.reviewHash]);
    await chain.write(chain.raffle, "updateDraft", [
      6n,
      chain.nft.address,
      886n,
      before.snapshot.raffle.salesEnd,
      before.snapshot.raffle.reserveNonce,
      before.snapshot.raffle.reserveCommit,
      "Edited before approval confirmation",
      [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]
    ], chain.seller);
    await chain.mine();
    await fixture.page.getByText("I already have the executed Ethereum transaction hash", { exact: true }).click();
    await fixture.page.getByLabel("Executed Ethereum transaction hash").fill(receipt.transactionHash);
    await fixture.page.getByRole("button", { name: "Confirm canonical execution", exact: true }).click();
    await fixture.page.getByRole("heading", { name: "Stale at confirmation", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await fixture.page.getByRole("button", { name: "Review current state", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Review approval checklist", exact: true }).click();
    for (const checkbox of await fixture.page.locator("fieldset input[type=checkbox]").all()) expect(await checkbox.isChecked()).toBe(false);
    expect(await fixture.page.getByRole("button", { name: "Download approval file", exact: true }).isDisabled()).toBe(true);
    await restoreAutomaticDiscovery();
  }, 30_000);
});
