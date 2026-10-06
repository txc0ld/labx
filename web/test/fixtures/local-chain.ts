import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createPublicClient, encodeDeployData, encodeFunctionData, getAddress, http, isHex, keccak256, type Abi, type Address, type Hex } from "viem";
import { WalletSession } from "../../lib/chain/wallet-session";
import { createRaffleService } from "../../lib/chain/service";
import { PUBLISHED_TERMS_HASH } from "../../lib/published-terms";
import type { DeploymentManifest, WalletProvider } from "../../lib/chain/types";

type Artifact = { abi: Abi; bytecode: { object: Hex } };
function artifact(file: string, name: string): Artifact {
  return JSON.parse(readFileSync(resolve(process.cwd(), `../contracts/out/${file}/${name}.json`), "utf8"));
}
export async function localChain() {
  const port = await new Promise<number>((done, reject) => {
    const server = createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const at = server.address(); if (!at || typeof at === "string") return reject(new Error("No fixture port.")); server.close(() => done(at.port)); });
  });
  const node: ChildProcess = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  let requestId = 0;
  async function rpc(method: string, params: readonly unknown[] = []): Promise<unknown> {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }) });
    const body = await response.json(); if (body.error) throw new Error(body.error.message); return body.result;
  }
  for (let attempt = 0; ; attempt++) {
    try { await rpc("eth_chainId"); break; } catch (error) { if (attempt > 100) { node.kill(); throw error; } await new Promise(done => setTimeout(done, 30)); }
  }
  const client = createPublicClient({ transport: http(url, { retryCount: 0 }), pollingInterval: 20, cacheTime: 0 });
  const accounts = await rpc("eth_accounts"); if (!Array.isArray(accounts)) throw new Error("Fixture accounts missing.");
  const [operator, seller, buyer, treasury, stranger] = accounts.map(value => getAddress(value));
  async function send(from: Address, to: Address | undefined, data: Hex, value = 0n) {
    const tx = await rpc("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, value: `0x${value.toString(16)}`, gas: "0x989680" }]);
    if (typeof tx !== "string" || !isHex(tx)) throw new Error("Fixture transaction missing.");
    const receipt = await client.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") throw new Error(`Fixture transaction reverted: ${tx}`);
    return receipt;
  }
  async function deploy(file: string, name: string, args: readonly unknown[] = []) {
    const compiled = artifact(file, name);
    const receipt = await send(operator, undefined, encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode.object, args }));
    if (!receipt.contractAddress) throw new Error("Fixture deployment failed.");
    return { address: getAddress(receipt.contractAddress), abi: compiled.abi, block: receipt.blockNumber };
  }
  const usdc = await deploy("Mocks.sol", "MockERC20", ["USD Coin", "USDC", 6]);
  const nft = await deploy("Mocks.sol", "MockERC721");
  const vrf = await deploy("Mocks.sol", "MockVRF");
  const weth = await deploy("Mocks.sol", "MockWETH");
  const router = await deploy("Mocks.sol", "MockRouter", [weth.address, usdc.address]);
  const feed = await deploy("Mocks.sol", "MockFeed");
  const raffle = await deploy("LabxRaffle.sol", "LabxRaffle", [{ treasury, usdc: usdc.address, router: router.address, weth: weth.address, ethUsdFeed: feed.address, poolFee: 3000, vrfCoordinator: vrf.address, keyHash: keccak256("0x1234"), subscriptionId: 1n, termsHash: PUBLISHED_TERMS_HASH, callbackGasLimit: 500_000, requestConfirmations: 3 }]);
  const code = await client.getCode({ address: raffle.address }); if (!code) throw new Error("Fixture code missing.");
  const manifest: DeploymentManifest = { chainId: 31337, version: 2, address: raffle.address, usdc: usdc.address, runtimeCodeHash: keccak256(code), deploymentBlock: raffle.block };
  async function write(contract: { address: Address; abi: Abi }, name: string, args: readonly unknown[] = [], from = operator) {
    return send(from, contract.address, encodeFunctionData({ abi: contract.abi, functionName: name, args }));
  }
  function wallet(account: Address) {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let current = account, chain = "0x7a69", refusal = false;
    const provider: WalletProvider = {
      async request({ method, params }) {
        if (method === "eth_chainId") return chain;
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [current];
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_sendTransaction" && refusal) throw Object.assign(new Error("User rejected request."), { code: 4001 });
        return rpc(method, params);
      },
      on(event, listener) { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); },
      removeListener(event, listener) { listeners.get(event)?.delete(listener); }
    };
    const session = new WalletSession(provider, 31337);
    return { session, reject(value: boolean) { refusal = value; }, changeAccount(value: Address) { current = value; for (const fn of listeners.get("accountsChanged") ?? []) fn([value]); }, changeChain(value: string) { chain = value; for (const fn of listeners.get("chainChanged") ?? []) fn(value); } };
  }
  return { client, rpc, operator, seller, buyer, treasury, stranger, usdc, nft, vrf, weth, router, feed, raffle, manifest, write, wallet,
    service: createRaffleService(client, manifest), async mine() { await rpc("evm_mine"); }, async warp(timestamp: bigint) { await rpc("evm_setNextBlockTimestamp", [Number(timestamp)]); await rpc("evm_mine"); },
    close() { node.kill(); } };
}
export type LocalChain = Awaited<ReturnType<typeof localChain>>;
