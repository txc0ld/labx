import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_SAFE_APPROVAL_BROWSER === "1" ? describe : describe.skip;

run("Safe approval handoff", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;

  beforeAll(async () => {
    chain = await localChain();
    const block = await chain.client.getBlock();
    const digest = keccak256(toBytes("safe-approval-browser"));
    await chain.write(chain.nft, "mint", [chain.seller, 901n]);
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      901n,
      block.timestamp + 86_400n,
      digest,
      digest,
      "Safe approval browser",
      [{ name: "Membership", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 10 }]
    ], chain.seller);
    await chain.write(chain.nft, "approve", [chain.raffle.address, 901n], chain.seller);
    await chain.write(chain.raffle, "escrow", [1n], chain.seller);
    fixture = await browserChain(chain, chain.seller);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  it("guides the wrong account before the owner gate and completes a keyboard-accessible fresh download", async () => {
    await fixture.page.setViewportSize({ width: 320, height: 800 });
    const queueResponse = await fixture.page.goto(`${fixture.baseUrl}/review`, { waitUntil: "domcontentloaded" });
    expect(queueResponse?.status()).toBe(200);
    await fixture.page.getByRole("heading", { name: "Connect the Safe to LABx", level: 2, exact: true }).waitFor({ timeout: 10_000 });
    expect(await fixture.page.getByRole("heading", { level: 1 }).count()).toBe(1);
    expect(await fixture.page.getByText(chain.operator, { exact: true }).isVisible()).toBe(true);
    expect(await fixture.page.getByText(/LABx currently sees/).isVisible()).toBe(true);
    expect(await fixture.page.getByText(/drafts loaded/).count()).toBe(0);

    const response = await fixture.page.goto(`${fixture.baseUrl}/review/1`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);

    await fixture.page.getByRole("heading", { name: "Connect the Safe to LABx", exact: true }).waitFor({ timeout: 10_000 });
    expect(await fixture.page.getByText(chain.operator, { exact: true }).isVisible()).toBe(true);
    expect(await fixture.page.getByText(/Beneath the QR code choose Copy link/).isVisible()).toBe(true);
    expect(await fixture.page.getByText(/Safe header choose WalletConnect/).isVisible()).toBe(true);
    expect(await fixture.page.getByRole("button", { name: "Download approval file", exact: true }).count()).toBe(0);

    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
    await fixture.switchAccount(chain.operator);
    await fixture.page.getByRole("heading", { name: "Choose the current draft action", exact: true }).waitFor({ timeout: 10_000 });

    for (const width of [320, 390, 768, 1440]) {
      await fixture.page.setViewportSize({ width, height: 900 });
      expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }

    const checklist = fixture.page.getByRole("button", { name: "Review approval checklist", exact: true });
    await expect.poll(() => checklist.isEnabled(), { timeout: 10_000 }).toBe(true);
    await checklist.press("Enter");
    await fixture.page.getByRole("heading", { name: "Approval checklist", exact: true }).waitFor({ timeout: 5_000 });
    const approval = fixture.page.getByRole("button", { name: "Download approval file", exact: true });
    expect(await approval.isDisabled()).toBe(true);
    for (const checkbox of await fixture.page.getByRole("checkbox").all()) {
      await checkbox.focus();
      await fixture.page.keyboard.press("Space");
    }
    expect(await approval.isEnabled()).toBe(true);

    const downloadPromise = fixture.page.waitForEvent("download");
    await approval.focus();
    await fixture.page.keyboard.press("Enter");
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^labx-approve-raffle-1-[a-f0-9]{12}\.json$/);
    const path = await download.path();
    if (path === null) throw new Error("Safe transaction file did not download.");
    const batch = JSON.parse(readFileSync(path, "utf8")) as {
      chainId: string;
      meta: { createdFromSafeAddress: string };
      transactions: { to: string; value: string; data: string }[];
    };
    expect(batch.chainId).toBe("31337");
    expect(batch.meta.createdFromSafeAddress.toLowerCase()).toBe(chain.operator.toLowerCase());
    expect(batch.transactions).toHaveLength(1);
    expect(batch.transactions[0]).toMatchObject({ to: chain.raffle.address, value: "0" });

    await fixture.page.getByRole("heading", { name: "Finish the approval in Safe", exact: true }).waitFor({ timeout: 10_000 });
    expect(await fixture.page.getByText("0 ETH", { exact: true }).isVisible()).toBe(true);
    expect(await fixture.page.getByText(/New transaction/).isVisible()).toBe(true);
    expect(await fixture.page.getByText(/Transaction Builder/).isVisible()).toBe(true);
    for (const width of [320, 390, 768, 1440]) {
      await fixture.page.setViewportSize({ width, height: 900 });
      expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }, 45_000);

  it("discovers the outer Ethereum hash on return and leaves the manual hash fallback available", async () => {
    const review = await chain.service.readAdmission({ id: 1n });
    if (review.snapshot.admission.reviewHash === null) throw new Error("Draft review hash missing.");
    const receipt = await chain.write(chain.raffle, "approveRaffle", [1n, review.snapshot.admission.reviewHash]);
    await chain.mine();
    await fixture.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await fixture.page.getByRole("heading", { name: "Approval recorded", exact: true }).waitFor({ timeout: 15_000 });
    expect(await fixture.page.getByText(receipt.transactionHash, { exact: true }).isVisible()).toBe(true);
  }, 30_000);
});
