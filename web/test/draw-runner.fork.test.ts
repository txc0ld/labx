import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { concat, createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http, parseAbi, parseEther, toHex, zeroAddress, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { APPROVED_DEPLOYMENTS } from "../lib/chain/deployment";
import { GET } from "../app/api/cron/draw/route";

// Opt-in check against a loopback anvil fork of Sepolia. Nothing is broadcast to Sepolia; the fork only reads from
// LABX_FORK_RPC_URL. Set LABX_FORK_BLOCK to pin a block. Anvil's public test keys hold nothing outside the fork.
const anvilMnemonic = "test test test test test test test test test test test junk";
const runnerAccount = mnemonicToAccount(anvilMnemonic, { addressIndex: 5 });
const runner = runnerAccount.address;
const secret = "draw-runner-fork-check-secret";
const deployment = APPROVED_DEPLOYMENTS[0]!;
const PRIVILEGED = "The draw runner key must not belong to the LABx owner, a Safe signer or the treasury.";
const UNCHECKED = "The draw runner could not check the deployment.";
// Safe v1.4.1 on Sepolia, the same singleton and fallback handler as the LABx owner Safe.
const SAFE_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2_SINGLETON: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const SAFE_FALLBACK: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function enableModule(address module)",
  "function addOwnerWithThreshold(address owner, uint256 threshold)",
  "function getOwners() view returns (address[])",
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)"
]);
const ownerAbi = parseAbi(["function owner() view returns (address)", "function transferOwnership(address next)", "function setTreasury(address next)"]);

function hexKey(): Hex {
  const key = runnerAccount.getHdKey().privateKey;
  if (!key) throw new Error("Anvil key missing.");
  return toHex(key);
}

type Body = { ok: boolean; status?: string; sends?: number; items?: { id: string; action: string; outcome: string; error: string | null }[]; error?: string };

const run = process.env.RUN_DRAW_RUNNER_FORK === "1" ? describe : describe.skip;
run("draw runner on a loopback fork of Sepolia", () => {
  let node: ChildProcess;
  let url = "";
  let id = 0;
  let offset = 0;
  const realNow = Date.now.bind(Date);
  let client: ReturnType<typeof createPublicClient>;
  let owner: Address;
  let delegation: Hex;

  async function rpc(method: string, params: readonly unknown[] = []): Promise<unknown> {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const body = await response.json(); if (body.error) throw new Error(body.error.message); return body.result;
  }
  async function sendAs(from: Address, to: Address, data: Hex) {
    await rpc("anvil_impersonateAccount", [from]);
    await rpc("anvil_setBalance", [from, toHex(parseEther("1"))]);
    const hash = await rpc("eth_sendTransaction", [{ from, to, data, gas: "0x2dc6c0" }]) as Hex;
    const receipt = await client.waitForTransactionReceipt({ hash });
    await rpc("anvil_stopImpersonatingAccount", [from]);
    if (receipt.status !== "success") throw new Error("Fork setup transaction reverted.");
  }
  async function newSafe(owners: Address[]): Promise<Address> {
    const initializer = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [owners, 1n, zeroAddress, "0x", SAFE_FALLBACK, zeroAddress, 0n, zeroAddress] });
    const data = encodeFunctionData({ abi: safeAbi, functionName: "createProxyWithNonce", args: [SAFE_L2_SINGLETON, initializer, BigInt(realNow())] });
    const deployer = mnemonicToAccount(anvilMnemonic, { addressIndex: 1 }).address;
    const result = await rpc("eth_call", [{ from: deployer, to: SAFE_FACTORY, data }, "latest"]) as Hex;
    const proxy = getAddress(decodeFunctionResult({ abi: safeAbi, functionName: "createProxyWithNonce", data: result }));
    await sendAs(deployer, SAFE_FACTORY, data);
    expect(await client.readContract({ address: proxy, abi: safeAbi, functionName: "getOwners" })).toEqual(owners);
    return proxy;
  }
  async function invoke(): Promise<{ status: number; body: Body }> {
    offset += 600_000;
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await GET(new Request("https://labx.art/api/cron/draw", { headers: { Authorization: `Bearer ${secret}` } }));
      const body = await response.json();
      const output = `${JSON.stringify(body)}\n${JSON.stringify(logged.mock.calls)}`.toLowerCase();
      expect(output).not.toContain(hexKey().slice(2).toLowerCase());
      expect(output).not.toContain(secret);
      return { status: response.status, body };
    } finally { logged.mockRestore(); }
  }
  const runnerNonce = () => client.getTransactionCount({ address: runner });
  async function isolated(work: () => Promise<void>) {
    const saved = await rpc("evm_snapshot");
    try { await work(); } finally { await rpc("evm_revert", [saved]); }
  }

  beforeAll(async () => {
    const upstream = process.env.LABX_FORK_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
    const port = await new Promise<number>((done, reject) => {
      const server = createServer(); server.on("error", reject);
      server.listen(0, "127.0.0.1", () => { const at = server.address(); if (!at || typeof at === "string") return reject(new Error("No fork port.")); server.close(() => done(at.port)); });
    });
    const pinned = process.env.LABX_FORK_BLOCK ? ["--fork-block-number", process.env.LABX_FORK_BLOCK] : [];
    node = spawn("anvil", ["--fork-url", upstream, ...pinned, "--host", "127.0.0.1", "--port", String(port), "--silent"], { stdio: "ignore" });
    url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try { await rpc("eth_chainId"); break; } catch (error) { if (attempt > 300) throw error; await new Promise(done => setTimeout(done, 100)); }
    }
    client = createPublicClient({ transport: http(url, { retryCount: 0 }), pollingInterval: 50, cacheTime: 0 });
    expect(await client.getChainId()).toBe(11155111);
    owner = await client.readContract({ address: deployment.address, abi: ownerAbi, functionName: "owner" });
    // Every public anvil test address carries an EIP-7702 delegation on Sepolia. A production runner is a fresh wallet
    // without code, so the fork clears it. With the delegation in place, the runner still counts as the privileged wallet.
    delegation = await client.getCode({ address: runner }) ?? "0x";
    await rpc("anvil_setCode", [runner, "0x"]);
    vi.stubEnv("LABX_STORE", "memory");
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("LABX_KEEPER_PRIVATE_KEY", hexKey());
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", deployment.address);
    vi.stubEnv("NEXT_PUBLIC_RPC_URL", url);
    vi.stubEnv("NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST", "");
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  }, 120_000);
  afterAll(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); node?.kill(); });

  it("reads the deployed owner Safe and sends nothing for the existing raffles", async () => {
    expect(owner).toBe(deployment.expectedOwner);
    expect((await client.getCode({ address: owner }))?.length).toBeGreaterThan(2);
    const before = await runnerNonce();
    const result = await invoke();
    console.log(`fork block ${await client.getBlockNumber()}: ${JSON.stringify(result.body)}`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, status: "complete", sends: 0 });
    expect(await runnerNonce()).toBe(before);
  }, 120_000);

  it.each([
    ["the pending owner", PRIVILEGED, async () => {
      await sendAs(owner, deployment.address, encodeFunctionData({ abi: ownerAbi, functionName: "transferOwnership", args: [runner] }));
    }],
    ["an enabled module of the owner Safe", PRIVILEGED, async () => {
      await sendAs(owner, owner, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [runner] }));
    }],
    ["a signer of a treasury Safe that is not the owner", PRIVILEGED, async () => {
      const treasury = await newSafe([runner]);
      await sendAs(owner, deployment.address, encodeFunctionData({ abi: ownerAbi, functionName: "setTreasury", args: [treasury] }));
    }],
    ["a signer of a Safe that signs for the owner Safe", PRIVILEGED, async () => {
      const signer = await newSafe([runner]);
      await sendAs(owner, owner, encodeFunctionData({ abi: safeAbi, functionName: "addOwnerWithThreshold", args: [signer, 1n] }));
    }],
    ["a pending owner with an EIP-7702 delegation, which counts as the wallet itself", PRIVILEGED, async () => {
      expect(delegation.startsWith("0xef0100")).toBe(true);
      await rpc("anvil_setCode", [runner, delegation]);
      await sendAs(owner, deployment.address, encodeFunctionData({ abi: ownerAbi, functionName: "transferOwnership", args: [runner] }));
    }],
    ["an enabled module of a treasury that is an EIP-7702 account delegated to the Safe singleton", PRIVILEGED, async () => {
      const account: Address = "0x7702000000000000000000000000000000007702";
      const signer = mnemonicToAccount(anvilMnemonic, { addressIndex: 1 }).address;
      await rpc("anvil_setCode", [account, concat(["0xef0100", SAFE_L2_SINGLETON])]);
      await sendAs(signer, account, encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [[signer], 1n, zeroAddress, "0x", SAFE_FALLBACK, zeroAddress, 0n, zeroAddress] }));
      await sendAs(account, account, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [runner] }));
      expect(await client.getCode({ address: account })).toBe(concat(["0xef0100", SAFE_L2_SINGLETON]).toLowerCase());
      expect(await client.readContract({ address: account, abi: safeAbi, functionName: "getOwners" })).toEqual([signer]);
      await sendAs(owner, deployment.address, encodeFunctionData({ abi: ownerAbi, functionName: "setTreasury", args: [account] }));
    }],
    ["unknown, because the treasury is a contract that is not a Safe", UNCHECKED, async () => {
      await sendAs(owner, deployment.address, encodeFunctionData({ abi: ownerAbi, functionName: "setTreasury", args: [deployment.usdc] }));
    }]
  ] as const)("refuses with 503 and sends nothing when the runner is %s", async (_, error, setup) => {
    await isolated(async () => {
      await setup();
      const before = await runnerNonce();
      expect(await invoke()).toEqual({ status: 503, body: { ok: false, error } });
      expect(await runnerNonce()).toBe(before);
    });
  }, 120_000);
});
