import { fixtureTrust } from "./fixtures/deployment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http } from "viem";
import { configuredBrowserService } from "../lib/chain/browser";
import { createRaffleService } from "../lib/chain/service";
import { createCommitment, readPrivateRecords, recoverCommitment, saveAgreement, sendPurchaseReceipt } from "../lib/chain/api";
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
