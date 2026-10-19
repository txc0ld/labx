import { fixtureTrust } from "./fixtures/deployment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http, keccak256, toBytes } from "viem";
import { configuredBrowserService } from "../lib/chain/browser";
import { createRaffleService } from "../lib/chain/service";
import { createCommitment, readPrivateRecords, recoverCommitment, saveAgreement, sendPurchaseReceipt } from "../lib/chain/api";
import { PreparationNotDispatchedError } from "../lib/chain/submission-errors";
import { WalletSession } from "../lib/chain/wallet-session";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import type { Address } from "viem";
import type { DeploymentManifest, WalletProvider } from "../lib/chain/types";

vi.mock("../lib/chain/browser", () => ({ configuredBrowserService: vi.fn() }));
const first: Address = "0x1111111111111111111111111111111111111111", second: Address = "0x2222222222222222222222222222222222222222";
const digest = PUBLISHED_TERMS_HASH;
const manifest: DeploymentManifest = { ...fixtureTrust, address: "0x3333333333333333333333333333333333333333", usdc: "0x4444444444444444444444444444444444444444", runtimeCodeHash: digest, chainId: 31337, version: 3, deploymentBlock: 1n };
const context = { origin: "https://labx.example", chainId: 31337, contract: manifest.address, termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
const actions = [
  { name: "commitment", invoke: (wallet: WalletSession) => createCommitment(wallet, { nft: manifest.address, tokenId: "1", publicSummary: "Summary", privateCommitment: "Private" }) },
  { name: "recovery", invoke: (wallet: WalletSession) => recoverCommitment(wallet, { commit: digest }) },
  { name: "agreement", invoke: (wallet: WalletSession) => saveAgreement(wallet, { raffleId: "1", terms: true, rules: true, age: true }) },
  { name: "receipt", invoke: (wallet: WalletSession) => sendPurchaseReceipt(wallet, { transactionHash: digest, logIndex: 0, to: "person@example.com" }) },
  { name: "records", invoke: (wallet: WalletSession) => readPrivateRecords(wallet, { raffleIds: ["1"], purchases: [] }) }
];
beforeEach(() => vi.stubGlobal("window", { location: { origin: context.origin } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  let account = first;
  const provider: WalletProvider = { request: vi.fn(async ({ method }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
    if (method === "eth_chainId") return "0x7a69";
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "personal_sign") return "0xab";
    throw new Error(`Unexpected method ${method}`);
  }) };
  const wallet = new WalletSession(provider, 31337); await wallet.connect();
  const service = createRaffleService(createPublicClient({ transport: http("http://127.0.0.1:1") }), manifest);
  vi.mocked(configuredBrowserService).mockReturnValue({ kind: "configured", service, wallet });
  return { wallet, provider, async changeAccount() { account = second; await wallet.refresh(); } };
}
describe("private API wallet binding before context fetch", () => {
  it.each(actions)("$name rejects a wallet switch while context is pending without prompting wallet B", async ({ invoke }) => {
    const control = await fixture();
    let release!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; })).mockRejectedValue(new Error("Unexpected post-sign request"));
    vi.stubGlobal("fetch", fetcher);
    const result = invoke(control.wallet);
    const assertion = expect(result).rejects.toThrow(/changed/);
    await control.changeAccount();
    release(new Response(JSON.stringify({ ok: true, context })));
    await assertion;
    expect(vi.mocked(control.provider.request).mock.calls.some(([request]) => request.method === "personal_sign")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("classifies an expired signature before POST as proven non-dispatch", async () => {
    const control = await fixture();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(control.wallet, "signMessage").mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue(now + 301_000); return "0xab"; });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, context })));
    vi.stubGlobal("fetch", fetcher);
    const beforeRequest = vi.fn();
    await expect(createCommitment(control.wallet, { nft: manifest.address, tokenId: "1", publicSummary: "Summary", privateCommitment: "Private" }, { assertIntent: () => {}, beforeRequest })).rejects.toBeInstanceOf(PreparationNotDispatchedError);
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("allows unchanged-wallet records and preserves origin/terms/deployment validation", async () => {
    const control = await fixture();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, context }))).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, agreements: [], receipts: [] })));
    vi.stubGlobal("fetch", fetcher);
    expect(await readPrivateRecords(control.wallet, { raffleIds: [], purchases: [] })).toEqual({ agreements: [], receipts: [] });
    expect(vi.mocked(control.provider.request).mock.calls.filter(([request]) => request.method === "personal_sign")).toHaveLength(1);
    for (const changed of [{ ...context, origin: "https://other.example" }, { ...context, termsVersion: "wrong" }, { ...context, contract: first }, { ...context, chainId: 11155111 }]) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, context: changed })));
      await expect(readPrivateRecords(control.wallet, { raffleIds: [], purchases: [] })).rejects.toThrow(/do not match/);
    }
    expect(vi.mocked(control.provider.request).mock.calls.filter(([request]) => request.method === "personal_sign")).toHaveLength(1);
  });
});

describe("Create on a mainnet build", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("signs for chain 1 with the mainnet terms and accepts the chain 1 commitment", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "1");
    vi.resetModules();
    const [{ configuredBrowserService: browserService }, api, terms, { WalletSession: Session }, { createRaffleService: raffleService }] = await Promise.all([
      import("../lib/chain/browser"), import("../lib/chain/api"), import("../lib/published-terms"), import("../lib/chain/wallet-session"), import("../lib/chain/service")
    ]);
    const mainnet: DeploymentManifest = { ...manifest, chainId: 1 };
    const signed: string[] = [];
    const provider: WalletProvider = { request: vi.fn(async ({ method, params }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [first];
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "personal_sign") { signed.push(String((params as unknown[])[0])); return "0xab"; }
      throw new Error(`Unexpected method ${method}`);
    }) };
    const wallet = new Session(provider, 1); await wallet.connect();
    vi.mocked(browserService).mockReturnValue({ kind: "configured", service: raffleService(createPublicClient({ transport: http("http://127.0.0.1:1") }), mainnet), wallet });
    const mainnetContext = { ...context, chainId: 1, termsHash: terms.PUBLISHED_TERMS_HASH, termsVersion: terms.TERMS_VERSION };
    const stored = { seller: first, nft: manifest.address, tokenId: "1", chainId: "1", labx: manifest.address, publicSummary: "Summary", publicHash: keccak256(toBytes("Summary")), nonce: digest, commit: digest };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, context: mainnetContext })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ...stored })));
    vi.stubGlobal("fetch", fetcher);

    expect(terms.TERMS_VERSION).toBe("labx-membership-2026-10-19-mainnet-v1");
    await expect(api.createCommitment(wallet, { nft: manifest.address, tokenId: "1", publicSummary: "Summary", privateCommitment: "Private" })).resolves.toMatchObject({ chainId: "1" });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/workflow/context", "/api/reserve"]);
    expect(signed).toHaveLength(1);
  });
});
