import { afterEach, expect, it, vi } from "vitest";
import { keccak256, toBytes, verifyMessage, parseTransaction } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WalletSession } from "../lib/chain/wallet-session";
import { browserPendingJournal } from "../lib/chain/pending-journal";
import { APPROVED_DEPLOYMENTS, attestDeployment } from "../lib/chain/deployment";
import { workflowMessage } from "../lib/chain/messages";
import { verifyWorkflowAuthorization } from "../lib/chain/server";
import { createDrawChain } from "../lib/draw-runner/chain";
import { hasAuthorizedRestoreSession } from "../lib/chain/appkit-provider";
const address = "0x1000000000000000000000000000000000000001";
const hash = keccak256(toBytes("fixture"));
const manifest = { ...APPROVED_DEPLOYMENTS[0], chainId: 1, address };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
it.each([[1,11155111],[11155111,1]])("manifest chain %s refuses RPC chain %s before code reads", async (expected, actual) => {
  const getCode = vi.fn();
  const client = { getBlock: async () => ({ number: 30_000_000n, hash, timestamp: 1n }), getChainId: async () => actual, getCode };
  expect(await attestDeployment(client as never, { ...manifest, chainId: expected } as never)).toMatchObject({ kind: "mismatch", reason: "The RPC network does not match this deployment." });
  expect(getCode).not.toHaveBeenCalled();
});
it.each([1,11155111])("chain %s scopes journal records and Web Locks even with identical addresses and bytecode", async chainId => {
  const map = new Map(), locks: string[] = [];
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string,v: string) => map.set(k,v), removeItem: (k: string) => map.delete(k) }, navigator: { locks: { request: (k: string, run: () => unknown) => { locks.push(k); return run(); } } } });
  const a = browserPendingJournal({ ...manifest, chainId } as never), b = browserPendingJournal({ ...manifest, chainId: chainId === 1 ? 11155111 : 1 } as never);
  const intent = { id: "fixture", intentHash: hash, nonce: 0, startedBlock: "1", hash: null };
  await a.exclusive(address, async () => a.write(address, intent));
  expect(b.read(address)).toBeNull();
  await b.exclusive(address, async () => {});
  expect(locks[0]).not.toBe(locks[1]);
  expect(a.read(address)).toEqual(intent);
});
it.each([1,11155111])("chain %s sends its explicit chain and refuses drift before signing or after journal wait", async chainId => {
  let currentChain = chainId; const calls: any[] = [];
  const provider = { request: async (args: any) => {
    calls.push(args);
    if (args.method === "eth_chainId") return `0x${currentChain.toString(16)}`;
    if (args.method === "eth_accounts") return [address];
    if (args.method === "eth_sendTransaction") return hash;
    throw new Error("unexpected call");
  } };
  const wallet = new WalletSession(provider, chainId);
  const snapshot = await wallet.refresh();
  const tx = { to: address, data: "0x", value: 0n };
  await wallet.requestTransaction(snapshot as never, tx as never);
  expect(calls.find(c => c.method === "eth_sendTransaction").params[0].chainId).toBe(`0x${chainId.toString(16)}`);
  calls.length = 0;
  await expect(wallet.requestTransaction(snapshot as never, tx as never, async () => { currentChain = chainId === 1 ? 11155111 : 1; })).rejects.toThrow(/changed/);
  await expect(wallet.signMessage({ expected: snapshot as never, message: "LABx test" })).rejects.toThrow(/changed/);
  expect(calls.some(c => ["eth_sendTransaction", "personal_sign"].includes(c.method))).toBe(false);
});
it.each([1,11155111])("WalletConnect restore on chain %s rejects opposite-chain namespaces", chainId => {
  const consent = { version: 1, connectorId: "walletConnect", account: address, chainId, id: "fixture" };
  const provider = (chain: number) => ({ session: { expiry: Math.floor(Date.now()/1000)+1000, namespaces: { eip155: { accounts: [`eip155:${chain}:${address}`], methods: ["personal_sign","eth_sendTransaction"], events: ["accountsChanged","chainChanged"] } } } });
  expect(hasAuthorizedRestoreSession(provider(chainId), consent as never)).toBe(true);
  expect(hasAuthorizedRestoreSession(provider(chainId === 1 ? 11155111 : 1), consent as never)).toBe(false);
});
it.each([1,11155111])("workflow chain %s rejects signatures with changed origin, chain, contract, terms hash or version", async chainId => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const context = { origin: "https://labx.example", chainId, contract: address, termsHash: hash, termsVersion: "fixture" };
  const input = { commit: hash }, deadline = String(Math.floor(Date.now()/1000)+100);
  const signature = await signer.signMessage({ message: workflowMessage("commitment recovery", context as never, signer.address, input, deadline) });
  const params = { operation: "commitment recovery", context, account: signer.address, input, deadline, signature, verify: verifyMessage };
  await expect(verifyWorkflowAuthorization(params as never)).resolves.toBeTypeOf("string");
  for (const change of [{ origin: "https://other.example" }, { chainId: chainId === 1 ? 11155111 : 1 }, { contract: "0x2000000000000000000000000000000000000002" }, { termsHash: keccak256(toBytes("other")) }, { termsVersion: "other" }]) {
    await expect(verifyWorkflowAuthorization({ ...params, context: { ...context, ...change } } as never)).rejects.toThrow(/refused/);
  }
});
it.each([1,11155111])("runner raw transaction is EIP-1559 bound to chain %s", async chainId => {
  let captured: any;
  const account = privateKeyToAccount(generatePrivateKey());
  const client = { sendRawTransaction: async (args: any) => { captured = parseTransaction(args.serializedTransaction); return hash; } };
  const chain = createDrawChain({ client, manifest: { ...manifest, chainId }, account } as never);
  const result = await chain.send({ to: address, data: "0x", value: 0n } as never, 0, { gasLimit: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }, 1000);
  expect(result.kind).toBe("sent");
  expect(captured.chainId).toBe(chainId);
  expect(captured.to.toLowerCase()).toBe(address);
});
