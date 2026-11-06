import { fixtureTrust } from "./fixtures/deployment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http, type Address } from "viem";
import { configuredBrowserService } from "../lib/chain/browser";
import { createRaffleService } from "../lib/chain/service";
import { recoverCommitment } from "../lib/chain/api";
import { WalletSession } from "../lib/chain/wallet-session";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import type { DeploymentManifest, WalletProvider } from "../lib/chain/types";

vi.mock("../lib/chain/browser", () => ({ configuredBrowserService: vi.fn() }));
const seller: Address = "0x1111111111111111111111111111111111111111";
const manifest: DeploymentManifest = { ...fixtureTrust, address: "0x3333333333333333333333333333333333333333", usdc: "0x4444444444444444444444444444444444444444", runtimeCodeHash: PUBLISHED_TERMS_HASH, chainId: 31337, version: 3, deploymentBlock: 1n };
const context = { origin: "https://labx.example", chainId: 31337, contract: manifest.address, termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
beforeEach(() => vi.stubGlobal("window", { location: { origin: context.origin } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Confirm the draw's first step: one signature, then the draw setup request, which answers `reveal`. */
async function confirmDraw(reveal: Response) {
  const provider: WalletProvider = { request: vi.fn(async ({ method }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [seller];
    if (method === "eth_chainId") return "0x7a69";
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "personal_sign") return "0xab";
    throw new Error(`Unexpected method ${method}`);
  }) };
  const wallet = new WalletSession(provider, 31337); await wallet.connect();
  const service = createRaffleService(createPublicClient({ transport: http("http://127.0.0.1:1") }), manifest);
  vi.mocked(configuredBrowserService).mockReturnValue({ kind: "configured", service, wallet });
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, context }))).mockResolvedValueOnce(reveal);
  vi.stubGlobal("fetch", fetcher);
  const result = await recoverCommitment(wallet, { commit: PUBLISHED_TERMS_HASH }).then(() => null, (error: unknown) => error);
  const signatures = vi.mocked(provider.request).mock.calls.filter(([request]) => request.method === "personal_sign").length;
  return { message: result instanceof Error ? result.message : null, signatures, requests: fetcher.mock.calls.length };
}

describe("Confirm the draw when the draw setup request fails", () => {
  it("shows the server's plain retry message and asks for one signature only", async () => {
    const failed = await confirmDraw(Response.json({ ok: false, error: "The draw setup couldn't be loaded right now. Try again in a minute." }, { status: 503 }));
    expect(failed).toEqual({ message: "The draw setup couldn't be loaded right now. Try again in a minute.", signatures: 1, requests: 2 });
  });

  it("shows a plain retry message when the platform answers with an error page instead of JSON", async () => {
    const failed = await confirmDraw(new Response("An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT", { status: 504 }));
    expect(failed).toEqual({ message: "LABx didn't respond. Try again in a minute.", signatures: 1, requests: 2 });
  });
});
