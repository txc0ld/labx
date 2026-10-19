import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { createRaffleService } from "../lib/chain/service";
import { memoryPendingJournal, type PendingIntent } from "../lib/chain/pending-journal";
import { NotSentError } from "../lib/chain/submission-errors";
import { WalletSession } from "../lib/chain/wallet-session";
import type { RaffleService } from "../lib/chain/ports";
import type { SubmissionCheckpoint, WalletProvider } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";

const run = process.env.RUN_CHAIN_INTEGRATION === "1" ? describe : describe.skip;

type SendParams = { from: Address; to: Address; data: Hex; value: Hex; chainId: Hex; nonce?: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex };

run("buyer sends: fee suggestion, gas pre-check and pending records on isolated Anvil", () => {
  let chain: LocalChain;
  let id: bigint;

  beforeAll(async () => {
    chain = await localChain();
    await chain.write(chain.nft, "mint", [chain.seller, 1n]);
    const block = await chain.client.getBlock();
    const reserve = keccak256(toBytes("pending-send"));
    await chain.write(chain.raffle, "createRaffle", [chain.nft.address, 1n, block.timestamp + 3600n, reserve, reserve, "Pending send", [{ name: "Entry", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 100 }]], chain.seller);
    id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" }) - 1n;
    await chain.write(chain.nft, "approve", [chain.raffle.address, 1n], chain.seller);
    await chain.write(chain.raffle, "escrow", [id], chain.seller);
    await chain.admit(id);
    const policy = await chain.service.openingPolicy();
    await chain.write(chain.raffle, "openWithPolicy", [id, policy.hash], chain.seller);
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000n]);
  }, 60_000);

  afterAll(() => chain?.close());

  /** A wallet whose eth_sendTransaction is `send`; every other request goes to Anvil. */
  async function wallet(account: Address, send: (params: SendParams) => Promise<unknown>) {
    const requests: SendParams[] = [];
    const provider: WalletProvider = {
      async request({ method, params }) {
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_sendTransaction") { const call = params?.[0] as SendParams; requests.push(call); return send(call); }
        return chain.rpc(method, params);
      }
    };
    const session = new WalletSession(provider, 31337);
    await session.connect();
    return { session, requests };
  }
  const broadcast = (params: SendParams) => chain.rpc("eth_sendTransaction", [params]);
  const approval = () => ({ kind: "approveUsdc" as const, id, packId: 0, quantity: 1 });

  async function fresh() {
    const journal = memoryPendingJournal();
    return { journal, service: createRaffleService(chain.client, chain.manifest, journal) as RaffleService };
  }

  it("sends the network's EIP-1559 fee suggestion with the exact reviewed call and nonce", async () => {
    const { service, journal } = await fresh();
    const buyer = await wallet(chain.buyer, broadcast);
    const prepared = await service.prepare({ action: approval(), wallet: buyer.session });
    const nonce = await chain.client.getTransactionCount({ address: chain.buyer, blockTag: "pending" });
    const block = await chain.client.getBlock();
    const transaction = await service.submit({ prepared, wallet: buyer.session });
    expect(buyer.requests).toHaveLength(1);
    const [sent] = buyer.requests;
    expect({ from: sent.from, to: sent.to, data: sent.data, value: sent.value, chainId: sent.chainId, nonce: sent.nonce }).toEqual({
      from: chain.buyer, to: prepared.to, data: prepared.data, value: "0x0", chainId: "0x7a69", nonce: `0x${nonce.toString(16)}`
    });
    const maxFee = BigInt(sent.maxFeePerGas ?? "0x0"), tip = BigInt(sent.maxPriorityFeePerGas ?? "0x0");
    expect(tip).toBeGreaterThanOrEqual(1_000_000n);
    expect(maxFee).toBeGreaterThanOrEqual(tip + (block.baseFeePerGas ?? 0n));
    await chain.mine(); await chain.mine();
    expect(await service.confirm({ transaction, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
    expect(journal.read(chain.buyer)).toBeNull();
  });

  it("does not open the wallet or write a pending record when the account cannot pay the network fee", async () => {
    const { service, journal } = await fresh();
    await chain.rpc("anvil_setBalance", [chain.stranger, "0x3e8"]);
    try {
      const poor = await wallet(chain.stranger, broadcast);
      const prepared = await service.prepare({ action: approval(), wallet: poor.session });
      const refused = service.submit({ prepared, wallet: poor.session });
      await expect(refused).rejects.toThrow(/^Your wallet needs about \d+(\.\d+)? ETH for the network fee\.$/);
      await expect(refused).rejects.toMatchObject({ cause: expect.any(NotSentError) });
      expect(poor.requests).toEqual([]);
      expect(journal.read(chain.stranger)).toBeNull();
    } finally {
      await chain.rpc("anvil_setBalance", [chain.stranger, "0x21e19e0c9bab2400000"]);
    }
  });

  it("retires a wallet's own pre-broadcast failure when nothing is pending at its nonce, and says why", async () => {
    const { service, journal } = await fresh();
    const failing = await wallet(chain.buyer, async () => { throw { code: -32603, message: "Internal JSON-RPC error.", data: { code: -32000, message: "insufficient funds for gas * price + value" } }; });
    const prepared = await service.prepare({ action: approval(), wallet: failing.session });
    const retired: SubmissionCheckpoint[] = [];
    let written: SubmissionCheckpoint | null = null;
    await expect(service.submit({ prepared, wallet: failing.session, beforeRequest: checkpoint => { written = checkpoint; }, onNotDispatched: checkpoint => { retired.push(checkpoint); } }))
      .rejects.toThrow(new NotSentError("Your wallet doesn't have enough ETH for its network fee. Nothing was sent."));
    expect(failing.requests).toHaveLength(1);
    expect(retired).toEqual([written]);
    expect(journal.read(chain.buyer)).toBeNull();
  });

  it("keeps the record when a pre-broadcast-looking failure left a send at its nonce, then clears it once that send is mined", async () => {
    const { service, journal } = await fresh();
    const lying = await wallet(chain.buyer, async params => { await broadcast(params); throw { code: -32603, message: "Internal JSON-RPC error." }; });
    const prepared = await service.prepare({ action: approval(), wallet: lying.session });
    await chain.rpc("evm_setAutomine", [false]);
    try {
      await expect(service.submit({ prepared, wallet: lying.session })).rejects.toThrow(/uncertain/);
      const pending = await service.pending({ wallet: lying.session });
      expect(pending).toMatchObject({ hash: null });
      if (!pending) throw new Error("The record was not kept.");
      expect(await service.settlePending({ wallet: lying.session, expected: pending, continueUnsent: true })).toEqual({ kind: "waiting" });
      await chain.mine();
      expect(await service.settlePending({ wallet: lying.session, expected: pending })).toEqual({ kind: "spent" });
      expect(journal.read(chain.buyer)).toBeNull();
    } finally {
      await chain.rpc("evm_setAutomine", [true]);
    }
  });

  it("keeps a code-only failure whose send reaches LABx's RPC shortly after the error, and no second send can start", async () => {
    const { service, journal } = await fresh();
    await chain.rpc("evm_setAutomine", [false]);
    try {
      // WalletConnect reports any wallet exception as -32000; this wallet's own RPC took the send and it arrives 50 ms later.
      const late = await wallet(chain.buyer, async params => {
        setTimeout(() => { void broadcast(params); }, 50);
        throw { code: -32000, message: "request failed" };
      });
      const prepared = await service.prepare({ action: approval(), wallet: late.session });
      await expect(service.submit({ prepared, wallet: late.session })).rejects.toThrow(/uncertain/);
      const pending = await service.pending({ wallet: late.session });
      expect(pending).toMatchObject({ hash: null });
      if (!pending) throw new Error("The record was not kept.");
      expect(await chain.client.getTransactionCount({ address: chain.buyer, blockTag: "pending" })).toBe(pending.nonce + 1);
      await expect(service.submit({ prepared: await service.prepare({ action: approval(), wallet: late.session }), wallet: late.session })).rejects.toThrow(/unresolved/);
      expect(late.requests).toHaveLength(1);
      expect(await service.settlePending({ wallet: late.session, expected: pending, continueUnsent: true })).toEqual({ kind: "waiting" });
      await chain.mine();
      expect(await service.settlePending({ wallet: late.session, expected: pending })).toEqual({ kind: "spent" });
      expect(journal.read(chain.buyer)).toBeNull();
    } finally {
      await chain.rpc("evm_setAutomine", [true]);
    }
  }, 20_000);

  it("retires a code-only failure only after the pending nonce stays quiet for a few seconds", async () => {
    const { service, journal } = await fresh();
    const failing = await wallet(chain.buyer, async () => { throw { code: -32603, message: "Internal error" }; });
    const prepared = await service.prepare({ action: approval(), wallet: failing.session });
    const started = Date.now();
    await expect(service.submit({ prepared, wallet: failing.session })).rejects.toThrow(new NotSentError("Your wallet couldn't send this transaction. Nothing was sent."));
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_500);
    expect(journal.read(chain.buyer)).toBeNull();
  }, 20_000);

  it("leaves another tab's record alone when its own wallet fails before broadcast", async () => {
    const { service, journal } = await fresh();
    const other = (nonce: number): PendingIntent => ({ id: "other-tab-send", intentHash: keccak256(toBytes("other-tab")), nonce, startedBlock: "1", hash: null });
    const failing = await wallet(chain.buyer, async params => {
      // While this request was open, another tab's record took the nonce.
      journal.write(chain.buyer, other(Number(BigInt(params.nonce ?? "0x0"))));
      throw { code: -32603, data: { message: "insufficient funds for gas * price + value" } };
    });
    const prepared = await service.prepare({ action: approval(), wallet: failing.session });
    await expect(service.submit({ prepared, wallet: failing.session })).rejects.toThrow(/uncertain/);
    expect(journal.read(chain.buyer)?.id).toBe("other-tab-send");
  });

  it("checks and clears its pre-broadcast failure only inside the journal lock", async () => {
    const { service, journal } = await fresh();
    let release!: () => void, failed!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const thrown = new Promise<void>(resolve => { failed = resolve; });
    let otherTab: Promise<void> | null = null;
    const failing = await wallet(chain.buyer, async params => {
      // Another tab holds the journal lock as the wallet fails, then retires this record and writes its own send.
      otherTab = journal.exclusive(chain.buyer, async () => {
        await held;
        journal.write(chain.buyer, { id: "other-tab-send", intentHash: keccak256(toBytes("other-tab")), nonce: Number(BigInt(params.nonce ?? "0x0")), startedBlock: "1", hash: null });
      });
      failed();
      throw { code: -32603, data: { message: "insufficient funds for gas * price + value" } };
    });
    const prepared = await service.prepare({ action: approval(), wallet: failing.session });
    let settled = false;
    const sending = service.submit({ prepared, wallet: failing.session }).finally(() => { settled = true; });
    await thrown;
    const ours = journal.read(chain.buyer);
    for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(journal.read(chain.buyer)).toEqual(ours);
    release();
    await otherTab;
    await expect(sending).rejects.toThrow(/uncertain/);
    expect(journal.read(chain.buyer)?.id).toBe("other-tab-send");
  });

  it("never lets another tab settle a record while this tab's wallet request is open, and keeps the hash it returns", async () => {
    const { service: tabA, journal } = await fresh();
    const tabB = createRaffleService(chain.client, chain.manifest, journal) as RaffleService;
    let approve!: () => void, opened!: () => void;
    const approved = new Promise<void>(resolve => { approve = resolve; });
    const open = new Promise<void>(resolve => { opened = resolve; });
    const slow = await wallet(chain.buyer, async params => { opened(); await approved; return broadcast(params); });
    const prepared = await tabA.prepare({ action: approval(), wallet: slow.session });
    const sending = tabA.submit({ prepared, wallet: slow.session });
    await open;
    const pending = await tabB.pending({ wallet: slow.session });
    if (!pending) throw new Error("The record was not written before the wallet opened.");
    for (let block = 0; block < 26; block++) await chain.mine();
    expect(await tabB.settlePending({ wallet: slow.session, expected: pending, continueUnsent: true })).toEqual({ kind: "waiting" });
    expect(journal.read(chain.buyer)?.id).toBe(pending.id);
    approve();
    const transaction = await sending;
    expect(journal.read(chain.buyer)).toMatchObject({ id: pending.id, hash: transaction.hash });
    await chain.mine(); await chain.mine();
    expect(await tabA.confirm({ transaction, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
    expect(journal.read(chain.buyer)).toBeNull();
  }, 20_000);

  it("records the hash a wallet returns after its record was removed, so the send is still tracked", async () => {
    const { service, journal } = await fresh();
    const cleared = await wallet(chain.buyer, async params => {
      journal.remove(chain.buyer);
      return broadcast(params);
    });
    const prepared = await service.prepare({ action: approval(), wallet: cleared.session });
    const transaction = await service.submit({ prepared, wallet: cleared.session });
    expect(journal.read(chain.buyer)).toMatchObject({ hash: transaction.hash });
    await chain.mine(); await chain.mine();
    expect(await service.confirm({ transaction, timeoutMs: 3_000 })).toMatchObject({ kind: "confirmed" });
    expect(journal.read(chain.buyer)).toBeNull();
  });

  it("keeps an uncertain failure that is not pre-broadcast until the chain or the person settles it", async () => {
    const { service, journal } = await fresh();
    const silent = await wallet(chain.buyer, async () => { throw new Error("provider timed out"); });
    const prepared = await service.prepare({ action: approval(), wallet: silent.session });
    await expect(service.submit({ prepared, wallet: silent.session })).rejects.toThrow(/uncertain/);
    const pending = await service.pending({ wallet: silent.session });
    if (!pending) throw new Error("The record was not kept.");
    expect(await service.settlePending({ wallet: silent.session, expected: pending })).toEqual({ kind: "unsent" });
    expect(journal.read(chain.buyer)?.id).toBe(pending.id);
    expect(await service.settlePending({ wallet: silent.session, expected: pending, continueUnsent: true })).toEqual({ kind: "dropped" });
    expect(journal.read(chain.buyer)).toBeNull();
  });

  it("never settles this tab's own open wallet request from the chain", async () => {
    const { service, journal } = await fresh();
    let reject!: () => void, opened!: () => void;
    const answered = new Promise<never>((_resolve, fail) => { reject = () => fail({ code: 4001, message: "User rejected the request." }); });
    const open = new Promise<void>(resolve => { opened = resolve; });
    const slow = await wallet(chain.buyer, async () => { opened(); return answered; });
    const prepared = await service.prepare({ action: approval(), wallet: slow.session });
    const sending = service.submit({ prepared, wallet: slow.session });
    await open;
    const pending = await service.pending({ wallet: slow.session });
    if (!pending) throw new Error("The record was not written before the wallet opened.");
    expect(await service.settlePending({ wallet: slow.session, expected: pending, continueUnsent: true })).toEqual({ kind: "waiting" });
    expect(journal.read(chain.buyer)?.id).toBe(pending.id);
    reject();
    await expect(sending).rejects.toMatchObject({ code: 4001 });
    expect(journal.read(chain.buyer)).toBeNull();
  });
});
