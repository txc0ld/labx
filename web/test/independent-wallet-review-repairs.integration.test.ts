import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import { configuredBrowserService } from "../lib/chain/browser";
import { readPrivateRecords } from "../lib/chain/api";
import { memoryPendingJournal, transactionIntent, type PendingIntent } from "../lib/chain/pending-journal";
import { createRaffleService } from "../lib/chain/service";
import { WalletSession } from "../lib/chain/wallet-session";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import type { DeploymentManifest, WalletProvider } from "../lib/chain/types";
import { localChain, type LocalChain } from "./fixtures/local-chain";

vi.mock("../lib/chain/browser", () => ({ configuredBrowserService: vi.fn() }));

const run = process.env.RUN_INDEPENDENT_WALLET_REVIEW_REPAIRS === "1" ? describe : describe.skip;
const accountA: Address = "0x1111111111111111111111111111111111111111";
const accountB: Address = "0x2222222222222222222222222222222222222222";
const apiManifest: DeploymentManifest = {
  address: "0x3333333333333333333333333333333333333333",
  usdc: "0x4444444444444444444444444444444444444444",
  runtimeCodeHash: PUBLISHED_TERMS_HASH,
  chainId: 31337,
  version: 3,
  deploymentBlock: 1n
};
const workflowContext = {
  origin: "https://labx.example",
  chainId: apiManifest.chainId,
  contract: apiManifest.address,
  termsHash: PUBLISHED_TERMS_HASH,
  termsVersion: TERMS_VERSION
};

run("independent wallet review repairs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects an A-to-B-to-A context race before any private signature", async () => {
    let account = accountA;
    const provider: WalletProvider = {
      request: vi.fn(async ({ method }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
        if (method === "eth_chainId") return "0x7a69";
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "personal_sign") return "0xab";
        throw new Error(`Unexpected wallet method ${method}`);
      })
    };
    const wallet = new WalletSession(provider, apiManifest.chainId);
    await wallet.connect();
    const service = createRaffleService(createPublicClient({ transport: http("http://127.0.0.1:1") }), apiManifest);
    vi.mocked(configuredBrowserService).mockReturnValue({ kind: "configured", service, wallet });
    vi.stubGlobal("window", { location: { origin: workflowContext.origin } });
    let contextHeld = false;
    let releaseContext: (response: Response) => void = () => { throw new Error("Workflow context request was not held."); };
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        contextHeld = true;
        releaseContext = resolve;
      }))
      .mockRejectedValue(new Error("A signed private endpoint was reached."));
    vi.stubGlobal("fetch", fetcher);

    const result = readPrivateRecords(wallet, { raffleIds: ["1"], purchases: [] });
    account = accountB;
    await wallet.refresh();
    account = accountA;
    await wallet.refresh();
    if (!contextHeld) throw new Error("Workflow context request was not held.");
    releaseContext(new Response(JSON.stringify({ ok: true, context: workflowContext })));

    await expect(result).rejects.toThrow(/changed/);
    expect(vi.mocked(provider.request).mock.calls.filter(([request]) => request.method === "personal_sign")).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    wallet.dispose();
  });

  describe("service recovery boundaries", () => {
    let chain: LocalChain;
    let checkpoint: unknown;

    beforeAll(async () => {
      chain = await localChain();
      const block = await chain.client.getBlock();
      const digest = keccak256("0x1234");
      await chain.write(chain.nft, "mint", [chain.seller, 1n]);
      await chain.write(chain.raffle, "createRaffle", [
        chain.nft.address,
        1n,
        block.timestamp + 86_400n,
        digest,
        digest,
        "Independent wallet repair",
        [{ name: "Member", priceUsdc: 25_000_000n, bonusEntries: 1, maxSupply: 20 }]
      ], chain.seller);
    }, 30_000);

    beforeEach(async () => { checkpoint = await chain.rpc("evm_snapshot"); });
    afterEach(async () => {
      await chain.rpc("evm_revert", [checkpoint]);
    });
    afterAll(() => chain?.close());

    it("clears only the rejecting wallet's unsent intent for direct numeric code 5000", async () => {
      const journal = memoryPendingJournal();
      const otherIntent: PendingIntent = {
        id: "other-wallet",
        intentHash: keccak256("0x1111"),
        nonce: 9,
        startedBlock: "1",
        hash: null
      };
      journal.write(chain.buyer, otherIntent);
      const service = createRaffleService(chain.client, chain.manifest, journal);
      const wallet = chain.wallet(chain.seller).session;
      await wallet.connect();
      const rejection = Object.assign(new Error("opaque wallet refusal"), { code: 5000 });
      vi.spyOn(wallet, "requestTransaction").mockImplementationOnce(async (_expected, _transaction, beforeRequest, onProviderRequest) => {
        await beforeRequest?.();
        onProviderRequest?.();
        throw rejection;
      });

      const prepared = await service.prepare({ action: { kind: "approvePrize", id: 1n }, wallet });
      await expect(service.submit({ prepared, wallet })).rejects.toBe(rejection);
      expect(journal.read(chain.seller)).toBeNull();
      expect(journal.read(chain.buyer)).toEqual(otherIntent);
    });

    it("retains a known hash after numeric rejection and retains nested ambiguous failures", async () => {
      const cases = [
        { name: "known hash plus direct 4001", failure: Object.assign(new Error("late refusal"), { code: 4001 }), knownHash: keccak256("0x2222") },
        { name: "nested ambiguous 5000", failure: { code: -32603, data: { originalError: { code: 5000 } } }, knownHash: null }
      ];
      for (const scenario of cases) {
        const journal = memoryPendingJournal();
        const service = createRaffleService(chain.client, chain.manifest, journal);
        const wallet = chain.wallet(chain.seller).session;
        await wallet.connect();
        vi.spyOn(wallet, "requestTransaction").mockImplementationOnce(async (_expected, _transaction, beforeRequest, onProviderRequest) => {
          await beforeRequest?.();
          onProviderRequest?.();
          if (scenario.knownHash !== null) {
            const current = journal.read(chain.seller);
            if (current === null) throw new Error("Current recovery intent was not recorded.");
            journal.write(chain.seller, { ...current, hash: scenario.knownHash });
          }
          throw scenario.failure;
        });
        const prepared = await service.prepare({ action: { kind: "approvePrize", id: 1n }, wallet });
        await expect(service.submit({ prepared, wallet }), scenario.name).rejects.toThrow(/uncertain/);
        expect(journal.read(chain.seller), scenario.name).toMatchObject({ hash: scenario.knownHash });
      }
    });

    it("stops before a matching raffle beyond 480 IDs and bypasses discovery for a live journal", async () => {
      await chain.write(chain.nft, "mint", [chain.seller, 2n]);
      const receipt = await chain.write(chain.nft, "approve", [chain.raffle.address, 2n], chain.seller);
      const transaction = await chain.client.getTransaction({ hash: receipt.transactionHash });
      const template = (await chain.service.readRaffle({ id: 1n })).raffle;
      const read = chain.client.readContract.bind(chain.client);
      const calls = vi.spyOn(chain.client, "readContract").mockImplementation(async input => {
        if (input.functionName === "nextId") return 482n;
        if (input.functionName === "getRaffle") {
          const id = input.args?.[0];
          return { ...template, seller: id === 481n ? chain.seller : chain.stranger, tokenId: 2n };
        }
        if (input.args?.length) return read({ ...input, args: [1n, ...input.args.slice(1)] });
        return read(input);
      });
      const journal = memoryPendingJournal();
      const service = createRaffleService(chain.client, chain.manifest, journal);
      const wallet = chain.wallet(chain.seller).session;
      await wallet.connect();

      await expect(service.resume({ hash: transaction.hash, wallet })).rejects.toThrow(/bounded search.*480/i);
      expect(journal.read(chain.seller)).toBeNull();
      expect(calls.mock.calls.filter(([call]) => call.functionName === "getRaffle")).toHaveLength(480);
      expect(calls.mock.calls.some(([call]) => ["getPack", "getRaffleAdmission", "getRafflePolicy"].includes(call.functionName))).toBe(false);

      calls.mockClear();
      journal.write(chain.seller, {
        id: "live-recovery",
        intentHash: transactionIntent({ to: chain.nft.address, data: transaction.input, value: transaction.value }),
        nonce: transaction.nonce,
        startedBlock: receipt.blockNumber.toString(),
        hash: null
      });
      const resumed = await service.resume({ hash: transaction.hash, wallet });
      expect(resumed.hash).toBe(transaction.hash);
      expect(journal.read(chain.seller)?.hash).toBe(transaction.hash);
      expect(calls.mock.calls.some(([call]) => call.functionName === "nextId" || call.functionName === "getRaffle")).toBe(false);
    });
  });
});
