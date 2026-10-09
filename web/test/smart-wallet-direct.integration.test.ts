import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWalletClient, erc721Abi, http, keccak256, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { createRaffleService } from "../lib/chain/service";
import { memoryPendingJournal, transactionIntent } from "../lib/chain/pending-journal";
import type { WorkflowAction } from "../lib/chain/types";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
run("direct transactions from EIP-7702 accounts", () => {
  let c: LocalChain, checkpoint: unknown;
  beforeAll(async () => {
    c = await localChain();
    const digest = keccak256("0x1234");
    await c.write(c.nft, "mint", [c.seller, 1n]);
    await c.write(c.raffle, "createRaffle", [c.nft.address, 1n, (await c.client.getBlock()).timestamp + 86400n, digest, digest, "Delegated seller", [{ name: "Member", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 20 }]], c.seller);
  }, 30_000);
  beforeEach(async () => { checkpoint = await c.rpc("evm_snapshot"); });
  afterEach(async () => { vi.restoreAllMocks(); await c.rpc("evm_revert", [checkpoint]); });
  afterAll(() => c?.close());

  async function delegateSeller() {
    // Anvil's public fixture mnemonic, used only against this test's loopback node.
    const account = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 1 });
    expect(account.address).toBe(c.seller);
    const signer = createWalletClient({ account, chain: foundry, transport: http(c.url) });
    const authorization = await signer.signAuthorization({ contractAddress: c.nft.address, executor: "self" });
    const hash = await signer.sendTransaction({ to: c.stranger, value: 0n, authorizationList: [authorization] });
    expect((await c.client.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(await c.client.getCode({ address: c.seller })).toBe(`0xef0100${c.nft.address.slice(2).toLowerCase()}`);
  }

  it.each([false, true])("confirms direct approval and escrow after real authorization, uppercase code: %s", async uppercase => {
    await delegateSeller();
    const journal = memoryPendingJournal(), service = createRaffleService(c.client, c.manifest, journal);
    const wallet = c.wallet(c.seller).session; await wallet.connect();
    const firstNonce = await c.client.getTransactionCount({ address: c.seller, blockTag: "pending" });
    const actions = [{ kind: "approvePrize", id: 1n }, { kind: "escrow", id: 1n }] satisfies WorkflowAction[];
    for (const [offset, action] of actions.entries()) {
      const prepared = await service.prepare({ action, wallet });
      if (uppercase) vi.spyOn(c.client, "getCode").mockResolvedValueOnce(`0xEF0100${c.nft.address.slice(2).toUpperCase()}`);
      const transaction = await service.submit({ prepared, wallet });
      const actual = await c.client.getTransaction({ hash: transaction.hash });
      expect(actual.from.toLowerCase()).toBe(c.seller.toLowerCase());
      expect(actual.to?.toLowerCase()).toBe(prepared.to.toLowerCase());
      expect(actual.input).toBe(prepared.data);
      expect(actual.value).toBe(prepared.value);
      expect(actual.nonce).toBe(firstNonce + offset);
      expect(journal.read(c.seller)).toMatchObject({ hash: transaction.hash, nonce: actual.nonce, intentHash: transactionIntent(prepared) });
      await c.client.waitForTransactionReceipt({ hash: transaction.hash }); await c.mine();
      expect(await service.confirm({ transaction, timeoutMs: 2000 })).toMatchObject({ kind: "confirmed" });
      expect(journal.read(c.seller)).toBeNull();
    }
    expect(await c.client.readContract({ address: c.nft.address, abi: erc721Abi, functionName: "ownerOf", args: [1n] })).toBe(c.raffle.address);
  });

  it.each([undefined, "0x"] satisfies (Hex | undefined)[])("retains empty-code direct submission for %s", async code => {
    const journal = memoryPendingJournal(), service = createRaffleService(c.client, c.manifest, journal);
    const wallet = c.wallet(c.seller).session; await wallet.connect();
    const prepared = await service.prepare({ action: { kind: "approvePrize", id: 1n }, wallet });
    vi.spyOn(c.client, "getCode").mockResolvedValueOnce(code);
    const transaction = await service.submit({ prepared, wallet });
    await c.client.waitForTransactionReceipt({ hash: transaction.hash }); await c.mine();
    expect(await service.confirm({ transaction, timeoutMs: 2000 })).toMatchObject({ kind: "confirmed" });
    expect(journal.read(c.seller)).toBeNull();
  });

  it.each([
    "0xef0100", `0xef0100${"12".repeat(19)}`, `0xef0100${"12".repeat(21)}`,
    `0xef0101${"12".repeat(20)}`, `0xef0000${"12".repeat(20)}`, `0xef0100${"gg".repeat(20)}`,
    `0xef0100${"12".repeat(20)}\n`, `0xef0100${"12".repeat(20)}\r\n`, "0x60006000f3"
  ] satisfies Hex[])("rejects unsupported account code %s before submission side effects", async code => {
    const journal = memoryPendingJournal(), service = createRaffleService(c.client, c.manifest, journal);
    const wallet = c.wallet(c.seller).session; await wallet.connect();
    const prepared = await service.prepare({ action: { kind: "approvePrize", id: 1n }, wallet });
    vi.spyOn(c.client, "getCode").mockResolvedValueOnce(code);
    const nonce = vi.spyOn(c.client, "getTransactionCount"), request = vi.spyOn(wallet, "requestTransaction");
    const read = vi.spyOn(journal, "read"), acquire = vi.spyOn(journal, "exclusive"), write = vi.spyOn(journal, "write"), remove = vi.spyOn(journal, "remove");
    await expect(service.submit({ prepared, wallet })).rejects.toThrow(/Direct transactions from contract wallets are unsupported/);
    for (const operation of [nonce, request, read, acquire, write, remove]) expect(operation).not.toHaveBeenCalled();
  });
});
