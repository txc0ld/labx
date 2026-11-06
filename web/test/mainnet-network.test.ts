import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { keccak256, toBytes, verifyMessage, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowContext } from "../lib/chain/api-types";
import { workflowMessage } from "../lib/chain/messages";
import { chainName, configuredChainId, explorerAddress, explorerToken, NETWORKS, safeQueue } from "../lib/chain/networks";
import type { WalletSessionPort } from "../lib/chain/ports";
import type { BlockRef, DeploymentManifest, RaffleSnapshot, WalletProvider, WalletSnapshot } from "../lib/chain/types";
import { BrowserWalletSession, type WalletChooser } from "../lib/chain/wallet-connectors";
import { consentKey, readWalletConsent, saveWalletConsent } from "../lib/chain/wallet-consent";
import { WalletSession } from "../lib/chain/wallet-session";
import { COMMIT_VECTOR, hashCommitment } from "../lib/commitment";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { requestContext } from "../lib/request-auth";
import { MemoryStore } from "../lib/store";
import { recoverAuthenticatedCommitment, saveAuthenticatedCommitment } from "../lib/workflow-records";
import { fixtureTrust } from "./fixtures/deployment";

// Vitest compiles the wallet gate's TSX with the classic JSX runtime, which looks React up globally.
Object.assign(globalThis, { React });

/** A mainnet deployment as a later manifest entry would register it. Nothing is deployed at this address. */
const MAINNET_FIXTURE: DeploymentManifest = {
  ...fixtureTrust,
  chainId: 1,
  address: "0x1000000000000000000000000000000000000001",
  runtimeCodeHash: keccak256(toBytes("mainnet fixture runtime")),
  version: 3,
  deploymentBlock: 21_000_000n,
  usdc: "0x2000000000000000000000000000000000000002"
};
const SEPOLIA_ADDRESS = "0x8b0332D0ca48908e174F42eA1b3123e63f3F4327";
/** The terms hash the live Sepolia v3 contract pins. */
const SEPOLIA_TERMS_HASH: Hex = "0x653a59619128ccbd7b75b40db072ff9aab5c5a547caf1ccaf9de67079c463f25";
const V2_TERMS_HASH: Hex = "0xb3c83a96bc5e11afd2758d8b515bd495d83294a24d44c15c42b9aa970f4a75d1";
/** The mainnet publication's hash, pinned so any change to its text is deliberate. */
const MAINNET_TERMS_HASH: Hex = "0x60b0227346cc2217a96c89385ca06119826c2d8493afe9134974c0324db0c06a";
const block: BlockRef = { number: 21_000_100n, hash: keccak256(toBytes("block")), timestamp: 1_800_000_000n };
const account: Address = "0x1111111111111111111111111111111111111111";

function stubWindow(storage = new Map<string, string>()) {
  const local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  const tab = new Map<string, string>();
  vi.stubGlobal("window", {
    location: { hostname: "labx.example", origin: "https://labx.example" },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    localStorage: local,
    sessionStorage: { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); }, removeItem: (key: string) => { tab.delete(key); } }
  });
}

/** The registry with the mainnet fixture added, and attestation answering for whichever manifest is selected. */
async function withMainnetRegistry() {
  vi.doMock("../lib/chain/deployment", async importOriginal => {
    const actual = await importOriginal<typeof import("../lib/chain/deployment")>();
    return {
      ...actual,
      APPROVED_DEPLOYMENTS: [...actual.APPROVED_DEPLOYMENTS, MAINNET_FIXTURE],
      attestDeployment: vi.fn(async (_client: unknown, manifest: DeploymentManifest) => ({ kind: "verified", manifest, block }))
    };
  });
  const [{ configuredBrowserService }, { serverWorkflow }] = await Promise.all([import("../lib/chain/browser"), import("../lib/chain/server")]);
  return { configuredBrowserService, serverWorkflow };
}

function provider(chain: string) {
  const calls: string[] = [];
  const result: WalletProvider = {
    async request({ method }) {
      calls.push(method);
      if (method === "eth_chainId") return chain;
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
      if (method === "wallet_switchEthereumChain") return null;
      throw new Error(`Unexpected wallet request ${method}`);
    },
    on() {}, removeListener() {}
  };
  return { result, calls };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", undefined);
  vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", undefined);
  vi.stubEnv("NEXT_PUBLIC_RPC_URL", undefined);
  vi.stubEnv("NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST", undefined);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://labx.example");
});
afterEach(() => { vi.doUnmock("../lib/chain/deployment"); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("network facts", () => {
  it("names each chain's explorer, Safe prefix, public RPC, full-history RPC and NFT API host", () => {
    expect(NETWORKS[1]).toMatchObject({ name: "Ethereum", shortName: "Ethereum", explorer: "https://etherscan.io", safePrefix: "eth", rpc: "https://ethereum-rpc.publicnode.com", history: { rpc: "https://mainnet.gateway.tenderly.co" }, nftApiHost: "eth-mainnet" });
    expect(NETWORKS[11155111]).toMatchObject({ name: "Ethereum Sepolia", shortName: "Sepolia", explorer: "https://sepolia.etherscan.io", safePrefix: "sep", rpc: "https://ethereum-sepolia-rpc.publicnode.com", history: { rpc: "https://sepolia.gateway.tenderly.co" }, nftApiHost: "eth-sepolia" });
    expect(NETWORKS[31337]).toMatchObject({ name: "Isolated local chain", explorer: null, safePrefix: null, history: null, nftApiHost: null });
    expect([NETWORKS[1].chain.id, NETWORKS[11155111].chain.id, NETWORKS[31337].chain.id]).toEqual([1, 11155111, 31337]);
  });

  it("uses the exact network objects AppKit exports", async () => {
    const appKit = await import("@reown/appkit/networks");
    expect(NETWORKS[1].chain).toBe(appKit.mainnet);
    expect(NETWORKS[11155111].chain).toBe(appKit.sepolia);
  });

  it.each(["0x1", "137", "1 ", "01", "31337"])("refuses NEXT_PUBLIC_CHAIN_ID %j instead of serving Sepolia", value => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", value);
    expect(() => configuredChainId()).toThrow("NEXT_PUBLIC_CHAIN_ID must be 1 (Ethereum) or 11155111 (Sepolia).");
  });

  it.each([[undefined, 11155111], ["", 11155111], ["11155111", 11155111], ["1", 1]] as const)("reads NEXT_PUBLIC_CHAIN_ID %s as chain %s", (value, expected) => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", value);
    expect(configuredChainId()).toBe(expected);
  });

  it("builds explorer and Safe queue links for the deployment's chain only", () => {
    const nft = "0x3333333333333333333333333333333333333333", safe = "0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1";
    expect(explorerAddress(1, nft)).toBe(`https://etherscan.io/address/${nft}`);
    expect(explorerAddress(11155111, nft)).toBe(`https://sepolia.etherscan.io/address/${nft}`);
    expect(explorerToken(1, nft, 7n)).toBe(`https://etherscan.io/token/${nft}?a=7`);
    expect(explorerToken(11155111, nft, 7n)).toBe(`https://sepolia.etherscan.io/token/${nft}?a=7`);
    expect(safeQueue(1, safe)).toBe(`https://app.safe.global/transactions/queue?safe=eth:${safe}`);
    expect(safeQueue(11155111, safe)).toBe(`https://app.safe.global/transactions/queue?safe=sep:${safe}`);
    for (const chainId of [31337, 137]) {
      expect([explorerAddress(chainId, nft), explorerToken(chainId, nft, 7n), safeQueue(chainId, safe)]).toEqual([null, null, null]);
    }
    expect([chainName(1), chainName(11155111), chainName(31337), chainName(137)]).toEqual(["Ethereum", "Ethereum Sepolia", "Isolated local chain", "Chain 137"]);
  });
});

describe("deployment selection", () => {
  it("selects the mainnet manifest in browser and server only on a mainnet build", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "1");
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", MAINNET_FIXTURE.address);
    stubWindow();
    const { configuredBrowserService, serverWorkflow } = await withMainnetRegistry();
    const browser = configuredBrowserService();
    if (browser.kind !== "configured") throw new Error(browser.reason);
    expect(browser.service.manifest).toBe(MAINNET_FIXTURE);
    const server = await serverWorkflow();
    expect(server.manifest).toBe(MAINNET_FIXTURE);
    expect(server.context).toEqual({ origin: "https://labx.example", chainId: 1, contract: MAINNET_FIXTURE.address, termsHash: MAINNET_TERMS_HASH, termsVersion: "labx-membership-2026-10-19-mainnet-v1" });
    expect(server.client.transport.url).toBe("https://ethereum-rpc.publicnode.com");
    expect(server.history?.transport.url).toBe("https://mainnet.gateway.tenderly.co");
  });

  it.each([
    { name: "a Sepolia build given the mainnet address", chain: undefined, address: MAINNET_FIXTURE.address },
    { name: "a mainnet build given the Sepolia address", chain: "1", address: SEPOLIA_ADDRESS }
  ])("leaves $name unavailable in browser and server", async ({ chain, address }) => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", chain);
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", address);
    stubWindow();
    const { configuredBrowserService, serverWorkflow } = await withMainnetRegistry();
    expect(configuredBrowserService().kind).toBe("unavailable");
    await expect(serverWorkflow()).rejects.toThrow(/reviewed raffle deployment is not configured/);
  });

  it("keeps the Sepolia build on Sepolia's RPCs", async () => {
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", SEPOLIA_ADDRESS);
    const { serverWorkflow } = await withMainnetRegistry();
    const server = await serverWorkflow();
    expect(server.context.chainId).toBe(11155111);
    expect(server.client.transport.url).toBe("https://ethereum-sepolia-rpc.publicnode.com");
    expect(server.history?.transport.url).toBe("https://sepolia.gateway.tenderly.co");
  });
});

describe("published terms by chain", () => {
  /** An open raffle whose policy pins termsHash, as the catalog and the purchase builder read it. */
  function openRaffle(termsHash: `0x${string}`): RaffleSnapshot {
    return {
      id: 1n, block, policy: { ...fixtureTrust.expectedPolicy, termsHash },
      raffle: {
        seller: account, nft: MAINNET_FIXTURE.usdc, tokenId: 7n, salesEnd: block.timestamp + 3_600n, createdAt: 1n, drawnAt: 0n, vrfRequestedAt: 0n, phase: 1,
        escrowed: true, snapshotted: false, revealed: false, reserveNonce: block.hash, reserveCommit: block.hash, publicHash: block.hash,
        lotCursor: 0n, snapshotTotal: 0n, principalEscrow: 0n, feeEscrow: 0n, vrfRequestId: 0n, randomWord: 0n, winner: MAINNET_FIXTURE.usdc, packCount: 1, title: "Night garden"
      },
      packs: [{ name: "Entry", priceUsdc: 10_000_000n, bonusEntries: 1, maxSupply: 10, sold: 0, active: true }],
      admission: { status: "opened", reviewHash: null, record: { reviewRevision: 1n, approvedReviewHash: block.hash, approvedBy: fixtureTrust.expectedOwner, approvedAtOpening: true } },
      accounting: { grossPrincipal: 0n, buyerFees: 0n }, lotCount: 0n, paused: false, owner: fixtureTrust.expectedOwner, ethEnabled: false,
      drawStartGrace: 604_800n, randomnessGrace: 604_800n, revealGrace: 604_800n
    } as RaffleSnapshot;
  }
  /** Builds a purchase of raffle 1 on the build's modules, with a reader that reports the given raffle. */
  async function buy(snapshot: RaffleSnapshot) {
    const { actionBuilder } = await import("../lib/chain/actions");
    const reader = { checkedBlock: async () => block, readAccount: async () => ({ snapshot }), assertActionTrust: vi.fn(async () => {}) };
    const build = actionBuilder({} as PublicClient, MAINNET_FIXTURE, reader as unknown as Parameters<typeof actionBuilder>[2]);
    return build({ kind: "buyMembership", id: 1n, packId: 0, quantity: 1, acceptedTerms: snapshot.policy.termsHash, agreements: { terms: true, rules: true, age: true }, payment: { kind: "usdc" } }, { kind: "connected", account, chainId: 1, revision: 1 });
  }

  it("keeps the Sepolia build's terms byte-identical to the hash the live contract pins", async () => {
    const terms = await import("../lib/published-terms");
    expect(terms.PUBLISHED_TERMS_HASH).toBe(SEPOLIA_TERMS_HASH);
    expect(keccak256(toBytes(terms.PUBLISHED_TERMS_CONTENT))).toBe(SEPOLIA_TERMS_HASH);
    expect(terms.TERMS_VERSION).toBe("labx-membership-2026-10-07-v3");
    expect(terms.PUBLISHED_TERMS_CONTENT).toContain("The v3 contract blocks Ethereum mainnet chain 1.");
    expect(() => terms.requirePublishedTerms(SEPOLIA_TERMS_HASH)).not.toThrow();
    expect(() => terms.requirePublishedTerms(MAINNET_TERMS_HASH)).toThrow(/do not match/);
    const { catalogAvailability } = await import("../components/workflow/format");
    expect(catalogAvailability(openRaffle(SEPOLIA_TERMS_HASH)).label).toBe("Open");
    expect(catalogAvailability(openRaffle(MAINNET_TERMS_HASH)).label).toBe("Terms unavailable");
  });

  it("publishes the mainnet terms on a mainnet build, changing only the Network section and the ETH route", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "1");
    const terms = await import("../lib/published-terms");
    expect(terms.TERMS_VERSION).toBe("labx-membership-2026-10-19-mainnet-v1");
    expect(terms.PUBLISHED_TERMS_HASH).toBe(MAINNET_TERMS_HASH);
    expect(keccak256(toBytes(terms.PUBLISHED_TERMS_CONTENT))).toBe(MAINNET_TERMS_HASH);
    const sepolia = terms.publishedTermsByHash(SEPOLIA_TERMS_HASH);
    expect(terms.DRAW_RULES).toEqual(sepolia.rules);
    expect(terms.MEMBERSHIP_TERMS.map(section => section.heading)).toEqual(sepolia.terms.map(section => section.heading));
    expect(terms.MEMBERSHIP_TERMS.filter(section => section.heading !== "Network" && section.heading !== "Fees")).toEqual(sepolia.terms.filter(section => section.heading !== "Network" && section.heading !== "Fees"));
    const fees = terms.MEMBERSHIP_TERMS.find(section => section.heading === "Fees")?.paragraphs ?? [], sepoliaFees = sepolia.terms.find(section => section.heading === "Fees")?.paragraphs ?? [];
    expect(fees.slice(0, 2)).toEqual(sepoliaFees.slice(0, 2));
    expect(fees[2]).toBe("Cancellation refunds outstanding principal only; the successful purchase processing fee is nonrefundable. No seller commission is charged on cancellation. Purchases are paid in USDC only. Gas costs are not refunded. USDC is the unit of account.");
    expect(terms.MEMBERSHIP_TERMS.find(section => section.heading === "Network")?.paragraphs).toEqual(["These terms describe the LABx v3 contract on Ethereum mainnet, chain ID 1. The website permits only approved Ethereum mainnet deployments. Ethereum mainnet is not a test network."]);
    expect(terms.PUBLISHED_TERMS_CONTENT).toContain("These terms are a product draft for counsel, not a legal opinion.");
    expect(terms.PUBLISHED_TERMS_CONTENT).not.toMatch(/Sepolia|5-USDC|blocks Ethereum mainnet|unpublished|Uniswap|ETH-route|swap/);
  });

  it.each([undefined, "1"])("resolves the Sepolia v3, mainnet and historical v2 publications on a NEXT_PUBLIC_CHAIN_ID=%s build", async value => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", value);
    const { publishedTermsByHash } = await import("../lib/published-terms");
    expect([SEPOLIA_TERMS_HASH, MAINNET_TERMS_HASH, V2_TERMS_HASH].map(hash => publishedTermsByHash(hash).version))
      .toEqual(["labx-membership-2026-10-07-v3", "labx-membership-2026-10-19-mainnet-v1", "labx-membership-2026-10-06-v2"]);
  });

  it("refuses to sell a raffle pinned to the Sepolia terms on a mainnet build", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "1");
    const terms = await import("../lib/published-terms");
    expect(() => terms.requirePublishedTerms(SEPOLIA_TERMS_HASH)).toThrow(/do not match/);
    expect(() => terms.requirePublishedTerms(MAINNET_TERMS_HASH)).not.toThrow();
    const { catalogAvailability } = await import("../components/workflow/format");
    expect(catalogAvailability(openRaffle(SEPOLIA_TERMS_HASH))).toMatchObject({ label: "Terms unavailable", purchasable: false });
    expect(catalogAvailability(openRaffle(MAINNET_TERMS_HASH))).toMatchObject({ label: "Open", purchasable: true });
    await expect(buy(openRaffle(SEPOLIA_TERMS_HASH))).rejects.toThrow(/do not match the published membership terms/);
  });
});

describe("request authorization context", () => {
  const signer = privateKeyToAccount(generatePrivateKey());

  it("binds signed workflow requests to the deployment's chain and the mainnet terms", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "1");
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", MAINNET_FIXTURE.address);
    const { serverWorkflow } = await withMainnetRegistry();
    const { verifyWorkflowAuthorization } = await import("../lib/chain/server");
    const { context } = await serverWorkflow();
    const deadline = String(Math.floor(Date.now() / 1000) + 120), input = { commit: keccak256(toBytes("commit")) };
    const message = workflowMessage("commitment recovery", context, signer.address, input, deadline);
    expect(message).toContain('"chainId":1,');
    const verify = (args: Parameters<typeof verifyMessage>[0]) => verifyMessage(args);
    const sign = (scope: WorkflowContext) => signer.signMessage({ message: workflowMessage("commitment recovery", scope, signer.address, input, deadline) });
    await expect(verifyWorkflowAuthorization({ operation: "commitment recovery", context, account: signer.address, input, deadline, signature: await sign(context), verify })).resolves.toBe(message);
    for (const other of [{ ...context, chainId: 11155111 as const }, { ...context, termsHash: SEPOLIA_TERMS_HASH, termsVersion: "labx-membership-2026-10-07-v3" }]) {
      await expect(verifyWorkflowAuthorization({ operation: "commitment recovery", context, account: signer.address, input, deadline, signature: await sign(other), verify })).rejects.toThrow(/refused/);
    }
  });

  it.each([["1", 1], ["11155111", 11155111]] as const)("reads the private-record context for NEXT_PUBLIC_CHAIN_ID %s", (value, chainId) => {
    expect(requestContext({ NEXT_PUBLIC_CHAIN_ID: value, NEXT_PUBLIC_RAFFLE_ADDRESS: MAINNET_FIXTURE.address } as unknown as NodeJS.ProcessEnv))
      .toEqual({ origin: "https://labx.example", chainId, contract: MAINNET_FIXTURE.address });
  });

  it.each([undefined, "", "31337", "0x1", "137"])("refuses a private-record context for NEXT_PUBLIC_CHAIN_ID %s", value => {
    expect(() => requestContext({ NEXT_PUBLIC_CHAIN_ID: value, NEXT_PUBLIC_RAFFLE_ADDRESS: MAINNET_FIXTURE.address } as unknown as NodeJS.ProcessEnv)).toThrow(/not configured/);
  });
});

describe("commitment chain binding", () => {
  it("hashes the same commitment differently on Ethereum and Sepolia", () => {
    const mainnet = hashCommitment({ ...COMMIT_VECTOR, chainId: 1n });
    expect(hashCommitment(COMMIT_VECTOR)).toBe(COMMIT_VECTOR.expected);
    expect(mainnet).not.toBe(COMMIT_VECTOR.expected);
  });

  it("stores and recovers a mainnet commitment bound to chain 1", async () => {
    const seller = privateKeyToAccount(generatePrivateKey()), store = new MemoryStore();
    const context: WorkflowContext = { origin: "https://labx.example", chainId: 1, contract: MAINNET_FIXTURE.address, termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
    const deadline = String(Math.floor(Date.now() / 1000) + 120);
    const signed = async <T>(operation: Parameters<typeof workflowMessage>[0], input: T) => ({ address: seller.address, input, deadline, signature: await seller.signMessage({ message: workflowMessage(operation, context, seller.address, input, deadline) }) });
    const input = { nft: "0x3333333333333333333333333333333333333333" as Address, tokenId: "7", publicSummary: "Escrowed NFT prize.", privateCommitment: "Private fixture description" };
    const reserve = await saveAuthenticatedCommitment(store, await signed("commitment", input), context, verifyMessage);
    expect(reserve.chainId).toBe("1");
    const recovered = await recoverAuthenticatedCommitment(store, await signed("commitment recovery", { commit: reserve.commit }), context, verifyMessage);
    const parts = { ...recovered, tokenId: BigInt(recovered.tokenId) };
    expect(hashCommitment({ ...parts, chainId: 1n })).toBe(reserve.commit);
    expect(hashCommitment({ ...parts, chainId: 11155111n })).not.toBe(reserve.commit);
  });
});

describe("wallet chain", () => {
  const project = "a".repeat(32);

  it.each([[1, "0xaa36a7", /Ethereum to continue/], [11155111, "0x1", /Ethereum Sepolia to continue/]] as const)("a chain %s wallet session refuses a wallet on %s", async (chainId, walletChain, message) => {
    const chooser: WalletChooser = { connect: vi.fn(async () => provider(walletChain).result), disconnect: vi.fn(async () => {}) };
    const wallet = new BrowserWalletSession(undefined, chainId, project, async () => chooser);
    await expect(wallet.connect()).rejects.toThrow(message);
    expect(wallet.getSnapshot().kind).toBe("disconnected");
    expect(wallet.getConnectionStatus()).toMatchObject({ kind: "error", message: expect.stringContaining(`could not connect to ${chainName(chainId)}.`) });
  });

  it.each([[1, "0xaa36a7"], [11155111, "0x1"]] as const)("a chain %s session asks to switch to its chain and refuses %s", async (chainId, walletChain) => {
    const wrong = provider(walletChain);
    await expect(new WalletSession(wrong.result, chainId).connect()).rejects.toThrow(`Connect your wallet to ${chainName(chainId)} to continue.`);
    expect(wrong.calls[0]).toBe("wallet_switchEthereumChain");
    const right = provider(`0x${chainId.toString(16)}`), session = new WalletSession(right.result, chainId);
    const connected = await session.connect();
    expect(connected).toMatchObject({ kind: "connected", chainId });
    if (connected.kind !== "connected") throw new Error("Missing session");
    await expect(session.assertCurrent({ ...connected, chainId: chainId === 1 ? 11155111 : 1 })).rejects.toThrow(/changed/);
  });

  it("connects and remembers a mainnet wallet on a mainnet session", async () => {
    const chooser: WalletChooser = { connect: vi.fn(async () => provider("0x1").result), disconnect: vi.fn(async () => {}) };
    await expect(new BrowserWalletSession(undefined, 1, project, async () => chooser).connect()).resolves.toMatchObject({ kind: "connected", account, chainId: 1 });
  });

  it("restores a mainnet consent only on a mainnet session with the wallet still on mainnet", async () => {
    const storage = new Map<string, string>(), scope = `3:1:${MAINNET_FIXTURE.address.toLowerCase()}:${MAINNET_FIXTURE.runtimeCodeHash}`;
    stubWindow(storage);
    const key = consentKey(project, scope);
    saveWalletConsent(key, { connectorId: "metamask", account, chainId: 1 });
    expect(readWalletConsent(key)).toMatchObject({ chainId: 1 });
    const restoring = (chain: string): WalletChooser => ({ connect: vi.fn(), restore: vi.fn(async () => provider(chain).result), release: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) });

    await expect(new BrowserWalletSession(undefined, 1, project, async () => restoring("0x1"), scope).restore()).resolves.toMatchObject({ kind: "connected", chainId: 1 });
    await expect(new BrowserWalletSession(undefined, 1, project, async () => restoring("0xaa36a7"), scope).restore()).resolves.toMatchObject({ kind: "disconnected" });
    const load = vi.fn();
    await expect(new BrowserWalletSession(undefined, 11155111, project, load, scope).restore()).resolves.toMatchObject({ kind: "disconnected" });
    expect(load).not.toHaveBeenCalled();
  });

  it.each([["1", 11155111, "Ethereum."], [undefined, 1, "Ethereum Sepolia."]] as const)("the wallet gate on a NEXT_PUBLIC_CHAIN_ID=%s build refuses a chain %s wallet", async (value, walletChain, expected) => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", value);
    const { WalletGate } = await import("../components/workflow/WalletGate");
    const gate = (chainId: number) => {
      const snapshot: WalletSnapshot = { kind: "connected", account, chainId, revision: 1 };
      const wallet = { getSnapshot: () => snapshot, subscribe: () => () => {} } as unknown as WalletSessionPort;
      return renderToStaticMarkup(createElement(WalletGate, { wallet, children: createElement("p", null, "allowed") }));
    };
    const refused = gate(walletChain);
    expect(refused).toContain("Wrong network");
    expect(refused).toContain(`Switch your wallet to ${expected}`);
    expect(refused).not.toContain("allowed");
    expect(gate(configuredChainId())).toContain("allowed");
  });
});

describe("wallet NFT discovery", () => {
  const owner = "0x4444444444444444444444444444444444444444", nft = "0x3333333333333333333333333333333333333333";
  const ownedNfts = [{ contract: { address: nft, name: "Collection" }, tokenId: "7", tokenType: "ERC721", name: "Token seven" }];

  it.each([["1", "eth-mainnet", 1], [undefined, "eth-sepolia", 11155111]] as const)("a NEXT_PUBLIC_CHAIN_ID=%s build asks Alchemy's %s API and labels the page chain %s", async (value, host, chainId) => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", value);
    const { createWalletNftHandler } = await import("../lib/wallet-nfts-server");
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ownedNfts, pageKey: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const response = await createWalletNftHandler({ apiKey: "test_key_never_real", fetcher })(new Request(`https://labx.example/api/wallet-nfts?owner=${owner}`));
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://${host}.g.alchemy.com/nft/v3/getNFTsForOwner?owner=${owner}&withMetadata=true&pageSize=24&tokenUriTimeoutInMs=0`);
    expect(await response.json()).toEqual({ ok: true, items: [{ contract: nft, tokenId: "7", name: "Token seven", collection: "Collection", image: null }], nextCursor: null, chainId });
  });

  it.each([["1", 11155111], [undefined, 1]] as const)("a NEXT_PUBLIC_CHAIN_ID=%s browser refuses an inventory page from chain %s", async (value, chainId) => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", value);
    const { fetchWalletNfts } = await import("../lib/wallet-nfts");
    const answer = (pageChain: number) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, items: [], nextCursor: null, chainId: pageChain }), { status: 200 }));
    answer(chainId);
    await expect(fetchWalletNfts({ owner, signal: new AbortController().signal })).rejects.toThrow(/invalid response/);
    answer(configuredChainId());
    await expect(fetchWalletNfts({ owner, signal: new AbortController().signal })).resolves.toEqual({ items: [], nextCursor: null, chainId: configuredChainId() });
  });
});
