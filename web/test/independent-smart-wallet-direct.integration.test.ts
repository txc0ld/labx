import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWalletClient, encodeFunctionData, erc721Abi, http, isHex, keccak256, toBytes, toHex, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { raffleAbi } from "../lib/chain/abi";
import { memoryPendingJournal } from "../lib/chain/pending-journal";
import type { WalletSessionPort } from "../lib/chain/ports";
import { createRaffleService } from "../lib/chain/service";
import type { SubmittedAction } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { standardMembershipPacks } from "./fixtures/membership-tiers";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;
const anvilMnemonic = "test test test test test test test test test test test junk";

function transactionHash(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) throw new Error("Fixture transaction hash missing.");
  return value;
}

run("independent EIP-7702 direct-wallet boundaries on isolated Anvil", () => {
  let chain: LocalChain;
  let executor: Awaited<ReturnType<LocalChain["deploy"]>>;
  let raffleId: bigint;
  let checkpoint: unknown;

  beforeAll(async () => {
    chain = await localChain();
    executor = await chain.deploy("Mocks.sol", "OwnerExecutorFixture");

    const authority = mnemonicToAccount(anvilMnemonic, { addressIndex: 1 });
    expect(authority.address.toLowerCase()).toBe(chain.seller.toLowerCase());
    const walletClient = createWalletClient({ account: authority, transport: http(chain.url) });
    const authorization = await walletClient.signAuthorization({ contractAddress: executor.address, executor: "self" });
    const activationHash = await walletClient.sendTransaction({ authorizationList: [authorization], chain: null, to: chain.buyer });
    expect((await chain.client.waitForTransactionReceipt({ hash: activationHash })).status).toBe("success");
    expect((await chain.client.getCode({ address: chain.seller }))?.toLowerCase()).toBe(`0xef0100${executor.address.slice(2).toLowerCase()}`);

    await chain.write(chain.nft, "mint", [chain.seller, 7_702n]);
    const current = await chain.client.getBlock();
    const reserve = keccak256(toBytes("independent-7702-boundary"));
    raffleId = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    const commitment = await chain.client.readContract({
      address: chain.raffle.address,
      abi: raffleAbi,
      functionName: "hashCommitment",
      args: [reserve, chain.nft.address, 7_702n, reserve, reserve, reserve]
    });
    await chain.write(chain.raffle, "createRaffle", [
      chain.nft.address,
      7_702n,
      current.timestamp + 86_400n,
      reserve,
      commitment,
      "Independent EIP-7702 boundaries",
      standardMembershipPacks((_, index) => ({ priceUsdc: 25_000_000n + BigInt(index), bonusEntries: 1, maxSupply: 20 }))
    ], chain.seller);
  }, 30_000);

  beforeEach(async () => { checkpoint = await chain.rpc("evm_snapshot"); });
  afterEach(async () => { await chain.rpc("evm_revert", [checkpoint]); });
  afterAll(() => chain?.close());

  async function reviewedApproval() {
    const journal = memoryPendingJournal();
    const service = createRaffleService(chain.client, chain.manifest, journal);
    const wallet = chain.wallet(chain.seller).session;
    await wallet.connect();
    const prepared = await service.prepare({ action: { kind: "approvePrize", id: raffleId }, wallet });
    return { journal, service, wallet, prepared };
  }

  function replaceRequest(
    wallet: WalletSessionPort,
    request: (transaction: { to: Address; data: Hex; value: bigint; nonce?: number }) => Promise<Hex>
  ) {
    wallet.requestTransaction = async (_expected, transaction, beforeRequest, onProviderRequest) => {
      await beforeRequest?.();
      onProviderRequest?.();
      return request(transaction);
    };
  }

  async function confirmedBlock(transaction: SubmittedAction) {
    await chain.client.waitForTransactionReceipt({ hash: transaction.hash });
    await chain.mine();
  }

  it("refuses a successful wrapped self-call as confirmation of the reviewed direct action", async () => {
    const { service, wallet, prepared } = await reviewedApproval();
    replaceRequest(wallet, async transaction => transactionHash(await chain.rpc("eth_sendTransaction", [{
      from: chain.seller,
      to: chain.seller,
      data: encodeFunctionData({ abi: executor.abi, functionName: "execute", args: [transaction.to, transaction.data] }),
      value: toHex(transaction.value),
      nonce: toHex(transaction.nonce!),
      gas: "0x989680"
    }])));

    const submitted = await service.submit({ prepared, wallet });
    await confirmedBlock(submitted);
    expect(await chain.client.readContract({ address: chain.nft.address, abi: erc721Abi, functionName: "getApproved", args: [7_702n] })).toBe(chain.raffle.address);
    await expect(service.confirm({ transaction: submitted, timeoutMs: 3_000 })).resolves.toMatchObject({ kind: "replaced" });
    await expect(service.pending({ wallet })).resolves.toBeNull();
  });

  it("rejects a relayer hash as the delegated wallet's action and preserves recovery", async () => {
    const { service, wallet, prepared } = await reviewedApproval();
    replaceRequest(wallet, async () => transactionHash(await chain.rpc("eth_sendTransaction", [{
      from: chain.buyer,
      to: chain.buyer,
      value: "0x0",
      gas: "0x5208"
    }])));

    const submitted = await service.submit({ prepared, wallet });
    await confirmedBlock(submitted);
    await expect(service.resume({ hash: submitted.hash, wallet })).rejects.toThrow(/not from the connected wallet/i);
    await expect(service.confirm({ transaction: submitted, timeoutMs: 3_000 })).rejects.toThrow(/sender/i);
    await expect(service.pending({ wallet })).resolves.toMatchObject({ hash: submitted.hash });
  });

  it("rejects an exact-intent transaction sent at the next nonce and preserves the expected nonce", async () => {
    const { service, wallet, prepared } = await reviewedApproval();
    let expectedNonce: number | undefined;
    replaceRequest(wallet, async transaction => {
      expectedNonce = transaction.nonce;
      if (expectedNonce === undefined) throw new Error("Service did not bind an explicit nonce.");
      await chain.rpc("eth_sendTransaction", [{
        from: chain.seller,
        to: chain.buyer,
        value: "0x0",
        nonce: toHex(expectedNonce),
        gas: "0x5208"
      }]);
      return transactionHash(await chain.rpc("eth_sendTransaction", [{
        from: chain.seller,
        to: transaction.to,
        data: transaction.data,
        value: toHex(transaction.value),
        nonce: toHex(expectedNonce + 1),
        gas: "0x989680"
      }]));
    });

    const submitted = await service.submit({ prepared, wallet });
    await confirmedBlock(submitted);
    await expect(service.resume({ hash: submitted.hash, wallet })).rejects.toThrow(/unrelated/i);
    await expect(service.confirm({ transaction: submitted, timeoutMs: 3_000 })).rejects.toThrow(/does not reconcile/i);
    await expect(service.pending({ wallet })).resolves.toMatchObject({ hash: submitted.hash, nonce: expectedNonce });
  });

  it("does not accept an operation-like identifier as an Ethereum transaction", async () => {
    const { service, wallet, prepared } = await reviewedApproval();
    const operationId = keccak256(toBytes("not-an-ethereum-transaction"));
    replaceRequest(wallet, async () => operationId);

    const submitted = await service.submit({ prepared, wallet });
    await expect(service.confirm({ transaction: submitted, timeoutMs: 100 })).resolves.toEqual({ kind: "pending", hash: operationId });
    await expect(service.inspectOutcome({ hash: operationId, account: chain.seller, timeoutMs: 100 })).resolves.toMatchObject({ kind: "unknown" });
    await expect(service.resume({ hash: operationId, wallet })).rejects.toThrow();
    await expect(service.pending({ wallet })).resolves.toMatchObject({ hash: operationId });
  });
});
