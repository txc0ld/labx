import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, maxUint256, toHex, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { localChain, type LocalChain } from "./fixtures/local-chain";
import { raffleAbi } from "../lib/chain/abi";
import { serverWorkflow } from "../lib/chain/server";
import { createDrawChain } from "../lib/draw-runner/chain";
import { createDrawCronHandler } from "../lib/draw-runner/http";
import { activeStore, MemoryStore } from "../lib/store";
import { createReserve, readReserveRecord } from "../lib/reserve";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import { STANDARD_MEMBERSHIP_TIERS } from "../lib/membership-tiers";
import type { DraftInput, WorkflowAction } from "../lib/chain/types";
import type { WalletSessionPort } from "../lib/chain/ports";
import { GET } from "../app/api/cron/draw/route";

// Anvil's public test mnemonic. Index 0 is the fixture owner; index 5 is unused by the fixture.
const anvilMnemonic = "test test test test test test test test test test test junk";
function anvilKey(index: number): Hex {
  const key = mnemonicToAccount(anvilMnemonic, { addressIndex: index }).getHdKey().privateKey;
  if (!key) throw new Error("Anvil key missing.");
  return toHex(key);
}
const runner = mnemonicToAccount(anvilMnemonic, { addressIndex: 5 }).address;
const secret = "draw-runner-integration-secret";

type Item = { id: string; action: string; hash: Hex | null; outcome: string };
type Body = { ok: boolean; status?: string; runner?: Address; sends?: number; items?: Item[]; error?: string };

const run = process.env.RUN_DRAW_RUNNER_INTEGRATION === "1" ? describe : describe.skip;
run("draw runner on a local chain", () => {
  let chain: LocalChain;
  let seller: WalletSessionPort;
  let offset = 0;
  const realNow = Date.now.bind(Date);

  beforeAll(async () => {
    chain = await localChain();
    seller = chain.wallet(chain.seller).session;
    await seller.connect();
    await chain.write(chain.usdc, "mint", [chain.buyer, 100_000_000_000n]);
    await chain.write(chain.usdc, "approve", [chain.raffle.address, maxUint256], chain.buyer);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LABX_STORE", "memory");
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", anvilKey(5));
    vi.stubEnv("NEXT_PUBLIC_LOCAL_RPC_URL", chain.url);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3113");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST", JSON.stringify({
      ...chain.manifest,
      deploymentBlock: chain.manifest.deploymentBlock.toString(),
      expectedPolicy: { ...chain.manifest.expectedPolicy, subscriptionId: chain.manifest.expectedPolicy.subscriptionId.toString(), minBuyerFeeUsdc: chain.manifest.expectedPolicy.minBuyerFeeUsdc.toString() }
    }));
    // Each run takes a fresh two-minute lease window without waiting in real time.
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  }, 60_000);
  afterAll(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); chain?.close(); });

  async function invoke(handler: (request: Request) => Promise<Response> = GET): Promise<{ status: number; body: Body }> {
    offset += 120_000;
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await handler(new Request("http://127.0.0.1:3113/api/cron/draw", { headers: { Authorization: `Bearer ${secret}` } }));
      const body = await response.json();
      const output = `${JSON.stringify(body)}\n${JSON.stringify(logged.mock.calls)}`.toLowerCase();
      expect(output).not.toContain(process.env.LABX_KEEPER_PRIVATE_KEY!.slice(2).toLowerCase());
      expect(output).not.toContain(secret);
      return { status: response.status, body };
    } finally { logged.mockRestore(); }
  }
  async function act(action: WorkflowAction) {
    const prepared = await chain.service.prepare({ action, wallet: seller });
    const transaction = await chain.service.submit({ prepared, wallet: seller });
    await chain.client.waitForTransactionReceipt({ hash: transaction.hash }); await chain.mine();
    expect((await chain.service.confirm({ transaction, timeoutMs: 3000 })).kind).toBe("confirmed");
  }
  async function listed(tokenId: bigint, lots: number) {
    await chain.write(chain.nft, "mint", [chain.seller, tokenId]);
    const store = new MemoryStore();
    const commitment = await createReserve(store, { nft: chain.nft.address, tokenId: String(tokenId), seller: chain.seller, publicSummary: "The escrowed token is the prize.", privateCommitment: `Runner fixture ${tokenId}`, chainId: 31337n, labx: chain.raffle.address });
    const reveal = await readReserveRecord(store, commitment.commit);
    const latest = await chain.client.getBlock();
    const draft: DraftInput = {
      nft: chain.nft.address, tokenId, title: `Runner ${tokenId}`, salesEnd: latest.timestamp + 1000n, reserveNonce: commitment.nonce, reserveCommit: commitment.commit,
      packs: STANDARD_MEMBERSHIP_TIERS.map((name, index) => ({ name, priceUsdc: 5_000_000n + BigInt(index) * 1_000_000n, bonusEntries: 1 + index, maxSupply: 500 }))
    };
    const id = await chain.client.readContract({ address: chain.raffle.address, abi: raffleAbi, functionName: "nextId" });
    await act({ kind: "createDraft", draft });
    await act({ kind: "approvePrize", id }); await act({ kind: "escrow", id }); await chain.admit(id);
    await act({ kind: "open", id, expectedPolicyHash: (await chain.service.openingPolicy()).hash });
    for (let index = 0; index < lots; index++) await chain.write(chain.raffle, "buyPack", [id, index % 5, 1, PUBLISHED_TERMS_HASH], chain.buyer);
    return { id, salesEnd: draft.salesEnd, reveal };
  }
  const phase = async (id: bigint) => (await chain.service.readRaffle({ id })).raffle.phase;
  const runnerNonce = () => chain.client.getTransactionCount({ address: runner });
  async function expectRunnerCalls(items: Item[]) {
    for (const item of items) {
      const transaction = await chain.client.getTransaction({ hash: item.hash! });
      expect(transaction.from.toLowerCase()).toBe(runner.toLowerCase());
      expect(transaction.to?.toLowerCase()).toBe(chain.raffle.address.toLowerCase());
      expect(transaction.value).toBe(0n);
      expect(decodeFunctionData({ abi: raffleAbi, data: transaction.input }).functionName).toBe(item.action);
    }
  }

  let first: Awaited<ReturnType<typeof listed>>;
  it("leaves an open raffle alone until its sales deadline, then closes, counts in batches and starts the draw", async () => {
    first = await listed(1n, 101);
    const early = await invoke();
    expect(early).toEqual({ status: 200, body: { ok: true, status: "complete", runner, sends: 0, items: [], nextCursor: "1" } });

    await chain.warp(first.salesEnd);
    const before = await runnerNonce();
    const started = await invoke();
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ ok: true, status: "complete", runner, sends: 4 });
    expect(started.body.items!.map(item => `${item.id}:${item.action}:${item.outcome}`)).toEqual(["1:close:succeeded", "1:snapshot:succeeded", "1:snapshot:succeeded", "1:requestRandomness:succeeded"]);
    await expectRunnerCalls(started.body.items!);
    expect(await runnerNonce()).toBe(before + 4);
    expect(await phase(first.id)).toBe(3);
    const snapshot = await chain.service.readRaffle({ id: first.id });
    expect(snapshot.raffle.snapshotted).toBe(true); expect(snapshot.raffle.lotCursor).toBe(101n);

    const idle = await invoke();
    expect(idle.body).toMatchObject({ ok: true, status: "complete", sends: 0, items: [] });
  }, 120_000);

  it("waits for the seller to confirm the draw, then finishes the raffle", async () => {
    const drawing = await chain.service.readRaffle({ id: first.id });
    await chain.write(chain.vrf, "fulfill", [chain.raffle.address, drawing.raffle.vrfRequestId, 4n]);
    expect(await phase(first.id)).toBe(4);
    const waiting = await invoke();
    expect(waiting.body).toMatchObject({ ok: true, status: "complete", sends: 0, items: [] });

    await act({ kind: "reveal", id: first.id, publicHash: first.reveal.publicHash, privateHash: first.reveal.privateHash, salt: first.reveal.salt });
    const settled = await invoke();
    expect(settled.body).toMatchObject({ ok: true, status: "complete", sends: 1 });
    expect(settled.body.items!.map(item => `${item.id}:${item.action}:${item.outcome}`)).toEqual(["1:settle:succeeded"]);
    await expectRunnerCalls(settled.body.items!);
    expect(await phase(first.id)).toBe(5);
  }, 60_000);

  it("skips a step a stranger already took and sends nothing for it", async () => {
    const raced = await listed(2n, 1);
    await chain.warp(raced.salesEnd);
    const racing = createDrawCronHandler({
      store: activeStore,
      async chain(account) {
        const { client, manifest } = await serverWorkflow();
        const real = createDrawChain({ client, manifest, account });
        return {
          ...real,
          async prepare(action) {
            if (action.kind === "close") await chain.write(chain.raffle, "close", [action.id], chain.stranger);
            return real.prepare(action);
          }
        };
      }
    });
    const before = await runnerNonce();
    const skipped = await invoke(racing);
    expect(skipped.body).toMatchObject({ ok: true, status: "complete", sends: 0, items: [{ id: raced.id.toString(), action: "close", hash: null, outcome: "skipped" }] });
    expect(await runnerNonce()).toBe(before);
    expect(await phase(raced.id)).toBe(2);

    const resumed = await invoke();
    expect(resumed.body.items!.map(item => `${item.id}:${item.action}:${item.outcome}`)).toEqual(["2:snapshot:succeeded", "2:requestRandomness:succeeded"]);
    expect(await phase(raced.id)).toBe(3);
  }, 60_000);

  it("does not close a raffle with no memberships", async () => {
    const empty = await listed(3n, 0);
    await chain.warp(empty.salesEnd + 1n);
    const result = await invoke();
    expect(result.body).toMatchObject({ ok: true, status: "complete", sends: 0, items: [] });
    expect(await phase(empty.id)).toBe(1);
  }, 60_000);

  it("refuses to run with the owner's key and sends nothing", async () => {
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", anvilKey(0));
    const pending = await listed(4n, 1);
    await chain.warp(pending.salesEnd);
    const before = await chain.client.getTransactionCount({ address: chain.operator });
    const refused = await invoke();
    expect(refused).toEqual({ status: 503, body: { ok: false, error: "The draw runner key must not belong to the LABx owner, a Safe signer or the treasury." } });
    expect(await chain.client.getTransactionCount({ address: chain.operator })).toBe(before);
    expect(await phase(pending.id)).toBe(1);
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", anvilKey(5));
  }, 60_000);

  it("refuses when the owner is a contract whose signers cannot be read", async () => {
    const executor = await chain.deploy("Mocks.sol", "OwnerExecutorFixture");
    await chain.write(chain.raffle, "transferOwnership", [executor.address]);
    await chain.write(executor, "execute", [chain.raffle.address, encodeFunctionData({ abi: raffleAbi, functionName: "acceptOwnership" })]);
    expect((await chain.service.readOwner()).owner).toBe(executor.address);
    const before = await runnerNonce();
    const refused = await invoke();
    expect(refused).toEqual({ status: 503, body: { ok: false, error: "The draw runner could not check the deployment." } });
    expect(await runnerNonce()).toBe(before);
  }, 60_000);
});
