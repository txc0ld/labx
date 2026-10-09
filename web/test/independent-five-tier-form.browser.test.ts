import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, keccak256, toBytes, type Hex } from "viem";
import { STANDARD_MEMBERSHIP_TIERS } from "../lib/membership-tiers";
import { raffleAbi } from "../lib/chain/abi";
import type { DraftInput } from "../lib/chain/types";
import { browserChain } from "./fixtures/browser-chain";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_FIVE_TIER_VERIFICATION === "1" || process.env.RUN_SELLER_PORTAL_BROWSER === "1" ? describe : describe.skip;

run("independent five-tier rendered journey", () => {
  let chain: LocalChain;
  let fixture: Awaited<ReturnType<typeof browserChain>>;
  let evidenceDir: string;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const legacy: { id: bigint; draft: DraftInput }[] = [];

  beforeAll(async () => {
    evidenceDir = process.env.LABX_FIVE_TIER_EVIDENCE_DIR
      ? resolve(process.env.LABX_FIVE_TIER_EVIDENCE_DIR)
      : mkdtempSync(resolve(tmpdir(), "labx-five-tier-verification-"));
    mkdirSync(evidenceDir, { recursive: true });
    chain = await localChain();
    const block = await chain.client.getBlock();
    await chain.write(chain.nft, "mint", [chain.seller, 8_000n]);
    const legacyNames = [
      ["Only"],
      ["eNTRY", "BASIC"],
      ["ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"],
      [" Entry "]
    ] as const;
    for (const [fixtureIndex, names] of legacyNames.entries()) {
      const tokenId = 8_001n + BigInt(fixtureIndex);
      await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
      const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
      const draft: DraftInput = {
        nft: chain.nft.address,
        tokenId,
        salesEnd: block.timestamp + 120n,
        reserveNonce: keccak256(toBytes(`browser-legacy-nonce-${tokenId}`)),
        reserveCommit: keccak256(toBytes(`browser-legacy-commit-${tokenId}`)),
        title: `Browser legacy ${names.length}`,
        packs: names.map((name, index) => ({
          name,
          priceUsdc: BigInt(index + 1) * 1_000_000n,
          bonusEntries: index + 1,
          maxSupply: (index + 1) * 10
        }))
      };
      await chain.write(chain.raffle, "createRaffle", [
        draft.nft,
        draft.tokenId,
        draft.salesEnd,
        draft.reserveNonce,
        draft.reserveCommit,
        draft.title,
        draft.packs
      ], chain.seller);
      legacy.push({ id, draft });
    }
    await chain.warp(block.timestamp + 121n);
    fixture = await browserChain(chain, chain.seller);
    fixture.page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    fixture.page.on("console", (message: { type(): string; text(): string }) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
  }, 45_000);

  afterAll(async () => {
    await fixture?.close();
    chain?.close();
  });

  async function goto(path: string) {
    const response = await fixture.page.goto(`${fixture.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const connect = fixture.page.getByRole("button", { name: "Connect wallet", exact: true });
    if (await connect.isVisible().catch(() => false)) await connect.click();
  }

  async function transact(label: string) {
    const trigger = fixture.page.getByRole("button", { name: label, exact: true }).first();
    await trigger.waitFor({ state: "visible", timeout: 15_000 });
    await trigger.click();
    const review = fixture.page.locator(".transaction-review").first();
    await review.waitFor({ state: "visible", timeout: 10_000 });
    const blockBeforeSubmit = await chain.client.getBlockNumber({ cacheTime: 0 });
    await review.getByRole("button", { name: `Confirm ${label.toLowerCase()}`, exact: true }).click();
    await expect.poll(async () => chain.client.getBlockNumber({ cacheTime: 0 }), { timeout: 15_000 }).toBeGreaterThan(blockBeforeSubmit);
    await expect.poll(async () => fixture.page.locator(".transaction-review").count(), { timeout: 15_000 }).toBe(0);
  }

  it("creates the exact five tiers responsively and repairs expired legacy drafts without remapping them", async () => {
    await goto("/seller");
    const draftSummary = fixture.page.locator("summary").filter({ hasText: "Prepare a draft" });
    await draftSummary.waitFor({ state: "visible", timeout: 15_000 });
    await draftSummary.click();
    await fixture.page.getByText("5 standard tiers", { exact: true }).waitFor({ state: "visible" });
    const createPanel = fixture.page.locator("section[aria-label='Create a raffle draft']");
    const groups = STANDARD_MEMBERSHIP_TIERS.map((name, index) =>
      createPanel.getByRole("group", { name: `Membership ${index + 1}: ${name}`, exact: true }));
    for (const group of groups) {
      expect(await group.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["", "", ""]);
      expect(await group.locator("input").evaluateAll((inputs) => inputs.every((input) => (input as HTMLInputElement).required))).toBe(true);
    }
    expect(await fixture.page.getByLabel("Name", { exact: true }).count()).toBe(0);
    expect(await fixture.page.getByRole("button", { name: /Add membership|Remove membership/ }).count()).toBe(0);

    await fixture.page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [320, 390, 768, 1440]) {
      await fixture.page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
      await fixture.page.evaluate(async () => { await document.fonts.ready; });
      expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await createPanel.screenshot({ path: resolve(evidenceDir, `new-five-tier-form-${width}.png`) });
      await fixture.page.screenshot({ path: resolve(evidenceDir, `new-five-tier-fullpage-${width}.png`), fullPage: true });
      for (const [position, group] of [["first", groups[0]], ["last", groups[groups.length - 1]]] as const) {
        await group.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          window.scrollTo({ top: window.scrollY + bounds.top - 160 });
        });
        await group.screenshot({ path: resolve(evidenceDir, `new-five-tier-${position}-${width}.png`) });
      }
    }
    await fixture.page.setViewportSize({ width: 768, height: 900 });
    await fixture.page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await createPanel.screenshot({ path: resolve(evidenceDir, "new-five-tier-form-768-zoom-200.png") });
    await fixture.page.evaluate(() => { document.documentElement.style.zoom = ""; });

    const entryPrice = groups[0].getByLabel("Price in USDC", { exact: true });
    await entryPrice.focus();
    await fixture.page.keyboard.press("Tab");
    expect(await groups[0].getByLabel("Bonus entries", { exact: true }).evaluate((input) => document.activeElement === input)).toBe(true);
    await fixture.page.keyboard.press("Tab");
    expect(await groups[0].getByLabel("Supply", { exact: true }).evaluate((input) => document.activeElement === input)).toBe(true);

    const current = await chain.client.getBlock();
    await fixture.page.getByLabel("Raffle title").fill("Independent five tier raffle");
    await fixture.page.getByLabel("NFT contract").fill(chain.nft.address);
    await fixture.page.getByLabel("Token ID").fill("8000");
    await fixture.page.getByLabel("Sales deadline in UTC").fill(new Date(Number(current.timestamp + 86_400n) * 1_000).toISOString().slice(0, 16));
    for (const [index, group] of groups.entries()) {
      await group.getByLabel("Price in USDC", { exact: true }).fill(String(index + 1));
      await group.getByLabel("Bonus entries", { exact: true }).fill(String(index + 2));
      await group.getByLabel("Supply", { exact: true }).fill(String((index + 1) * 11));
    }
    await fixture.page.getByRole("button", { name: "Prepare raffle draft", exact: true }).click();
    for (const [index, name] of STANDARD_MEMBERSHIP_TIERS.entries()) {
      const row = fixture.page.locator(".review-list > div").filter({ has: fixture.page.locator("dt", { hasText: name }) });
      expect(await row.locator("dd").innerText()).toContain(`${index + 1} USDC`);
      expect(await row.locator("dd").innerText()).toContain(`${index + 2} bonus entries`);
      expect(await row.locator("dd").innerText()).toContain(`${(index + 1) * 11} supply`);
    }
    await fixture.page.setViewportSize({ width: 1440, height: 900 });
    await fixture.page.screenshot({ path: resolve(evidenceDir, "new-five-tier-review-1440.png"), fullPage: true });
    await fixture.page.getByRole("button", { name: "Edit draft", exact: true }).click();
    for (const [index, group] of groups.entries()) {
      expect(await group.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual([
        String(index + 1),
        String(index + 2),
        String((index + 1) * 11)
      ]);
    }
    await fixture.page.getByRole("button", { name: "Prepare raffle draft", exact: true }).click();
    await fixture.page.getByRole("button", { name: "Sign to prepare raffle", exact: true }).click();
    const newId = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await transact("Create raffle draft");
    const created = await chain.service.readRaffle({ id: newId });
    expect(created.packs.map((pack, index) => ({ name: pack.name, priceUsdc: pack.priceUsdc, bonusEntries: pack.bonusEntries, maxSupply: pack.maxSupply, index }))).toEqual(
      STANDARD_MEMBERSHIP_TIERS.map((name, index) => ({ name, priceUsdc: BigInt(index + 1) * 1_000_000n, bonusEntries: index + 2, maxSupply: (index + 1) * 11, index }))
    );

    for (const [fixtureIndex, item] of legacy.entries()) {
      const before = await chain.service.readRaffle({ id: item.id });
      await goto(`/seller/${item.id.toString()}`);
      await fixture.page.locator("summary").filter({ hasText: "Edit draft" }).click();
      await fixture.page.getByText(`${item.draft.packs.length} existing membership${item.draft.packs.length === 1 ? "" : "s"}`, { exact: true }).waitFor({ state: "visible" });
      for (const [packIndex, pack] of item.draft.packs.entries()) {
        const group = fixture.page.getByRole("group", { name: `Membership ${packIndex + 1}: ${pack.name.trim()}`, exact: true });
        expect(await group.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual([
          String(packIndex + 1),
          String(packIndex + 1),
          String((packIndex + 1) * 10)
        ]);
      }
      expect(await fixture.page.getByRole("button", { name: /Add membership|Remove membership/ }).count()).toBe(0);
      if (item.draft.packs.length === 2) {
        await fixture.page.setViewportSize({ width: 390, height: 844 });
        await fixture.page.locator("form").screenshot({ path: resolve(evidenceDir, "legacy-two-pack-edit-390.png") });
      }
      if (item.draft.packs[0]?.name === "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456") {
        await fixture.page.setViewportSize({ width: 320, height: 844 });
        const longNameGroup = fixture.page.getByRole("group", { name: "Membership 1: ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", exact: true });
        const overflow = await longNameGroup.evaluate((group) => {
          const legend = group.querySelector("legend strong");
          if (!(legend instanceof HTMLElement)) return null;
          const groupBounds = group.getBoundingClientRect();
          const legendBounds = legend.getBoundingClientRect();
          return {
            document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            group: group.scrollWidth - group.clientWidth,
            legendRight: legendBounds.right - groupBounds.right,
            legendLeft: groupBounds.left - legendBounds.left
          };
        });
        await fixture.page.locator("form").screenshot({ path: resolve(evidenceDir, "legacy-32-byte-name-edit-320.png") });
        expect(overflow).not.toBeNull();
        expect(overflow?.document).toBeLessThanOrEqual(0);
        expect(overflow?.group).toBeLessThanOrEqual(0);
        expect(overflow?.legendRight).toBeLessThanOrEqual(1);
        expect(overflow?.legendLeft).toBeLessThanOrEqual(1);
      }
      const repairBlock = await chain.client.getBlock();
      const salesEnd = repairBlock.timestamp + 86_400n + BigInt(fixtureIndex);
      const enteredSalesEnd = salesEnd - salesEnd % 60n;
      await fixture.page.getByLabel("Sales deadline in UTC").fill(new Date(Number(enteredSalesEnd) * 1_000).toISOString().slice(0, 16));
      await fixture.page.getByRole("button", { name: "Prepare raffle draft", exact: true }).click();
      await fixture.page.getByText("The saved draw setup for this NFT will be retained. No additional storage signature is needed.", { exact: true }).waitFor({ state: "visible" });
      if (item.draft.packs[0]?.name === " Entry ") {
        await fixture.page.evaluate(() => {
          type Request = (input: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
          const target = window as unknown as { ethereum: { request: Request }; __labxCapturedUpdateData?: string };
          const provider = target.ethereum;
          const original = provider.request;
          provider.request = async input => {
            if (input.method === "eth_sendTransaction") {
              const transaction = Array.isArray(input.params) ? input.params[0] : null;
              if (transaction && typeof transaction === "object" && "data" in transaction && typeof transaction.data === "string") {
                target.__labxCapturedUpdateData = transaction.data;
              }
            }
            return original.call(provider, input);
          };
        });
      }
      await transact("Update raffle draft");
      if (item.draft.packs[0]?.name === " Entry ") {
        const data = await fixture.page.evaluate(() => (window as unknown as { __labxCapturedUpdateData?: string }).__labxCapturedUpdateData);
        expect(data).toMatch(/^0x[0-9a-f]+$/i);
        const decoded = decodeFunctionData({ abi: raffleAbi, data: data as Hex });
        expect(decoded.functionName).toBe("updateDraft");
        expect(decoded.args?.[7]).toMatchObject([{ name: " Entry " }]);
      }
      const after = await chain.service.readRaffle({ id: item.id });
      expect(after.raffle.reserveNonce).toBe(before.raffle.reserveNonce);
      expect(after.raffle.reserveCommit).toBe(before.raffle.reserveCommit);
      expect(after.raffle.salesEnd).toBe(enteredSalesEnd);
      expect(after.packs).toEqual(before.packs);
    }
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }, 120_000);
});
