import { createPublicClient, http, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVED_DEPLOYMENTS, LEGACY_RAFFLE } from "../lib/chain/deployment";
import { PUBLISHED_TERMS_HASH } from "../lib/published-terms";
import type { BlockRef, DeploymentManifest } from "../lib/chain/types";

// Canonical deployment and Safe acceptance verified on 2026-10-08.
const verifiedManifest = {
  chainId: 11155111,
  address: "0x8b0332D0ca48908e174F42eA1b3123e63f3F4327",
  runtimeCodeHash: "0x566af43a3c4310211e5214168fab8c72c2996e01ebd4351f154bf88f1453eb31",
  version: 3,
  deploymentBlock: 11865781n,
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  expectedOwner: "0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1",
  expectedPolicy: {
    coordinator: "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B",
    treasury: "0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1",
    termsHash: "0x653a59619128ccbd7b75b40db072ff9aab5c5a547caf1ccaf9de67079c463f25",
    keyHash: "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae",
    subscriptionId: 87872268328198099397228888276383491550742527734296569403303774370612241641662n,
    callbackGasLimit: 500000,
    requestConfirmations: 3,
    nativePayment: true,
    buyerFeeBps: 200,
    sellerFeeBps: 200,
    minBuyerFeeUsdc: 2500000n,
  }
} satisfies DeploymentManifest;
const checkedBlock = { number: 11865827n, hash: "0x11cb316da9f58a5df51f07170704c2f17586032127a50b5535164fe0904c04fd", timestamp: 1791410352n } satisfies BlockRef;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", undefined);
  vi.stubEnv("NEXT_PUBLIC_RPC_URL", "http://127.0.0.1:1");
  vi.stubEnv("NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST", undefined);
  vi.stubGlobal("window", { location: { hostname: "labx.example", origin: "https://labx.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn(), localStorage: { getItem: () => null } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("verified Sepolia deployment registration", () => {
  it("registers only the canonical v3 runtime, creation block, Safe authority and complete opening policy", () => {
    expect(APPROVED_DEPLOYMENTS).toEqual([verifiedManifest]);
    expect(verifiedManifest.expectedPolicy.termsHash).toBe(PUBLISHED_TERMS_HASH);
    expect(APPROVED_DEPLOYMENTS.every(item => item.chainId === 11155111)).toBe(true);
  });

  it.each([verifiedManifest.address, verifiedManifest.address.toLowerCase()])("selects %s consistently in production browser and server configuration", async selected => {
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", selected);
    const deployment = await import("../lib/chain/deployment");
    const attest = vi.spyOn(deployment, "attestDeployment").mockResolvedValue({ kind: "verified", manifest: verifiedManifest, block: checkedBlock });
    const { configuredBrowserService } = await import("../lib/chain/browser");
    const browser = configuredBrowserService();
    expect(browser.kind).toBe("configured");
    if (browser.kind !== "configured") throw new Error(browser.reason);
    expect(browser.service.manifest).toEqual(verifiedManifest);
    expect(browser.wallet.getSnapshot().kind).toBe("disconnected");
    const { serverWorkflow } = await import("../lib/chain/server");
    const server = await serverWorkflow();
    expect(server.manifest).toEqual(browser.service.manifest);
    expect(server.context).toMatchObject({ chainId: 11155111, contract: verifiedManifest.address, termsHash: PUBLISHED_TERMS_HASH });
    expect(attest).toHaveBeenCalledExactlyOnceWith(expect.any(Object), verifiedManifest);
  });

  it.each([undefined, LEGACY_RAFFLE, "0xef27306567a5ADA354fe9403008D041d0b468213", verifiedManifest.expectedOwner, "0x1111111111111111111111111111111111111111"])("leaves unregistered selection %s unavailable in browser and server", async selected => {
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", selected);
    const deployment = await import("../lib/chain/deployment");
    const attest = vi.spyOn(deployment, "attestDeployment");
    const { configuredBrowserService } = await import("../lib/chain/browser");
    expect(configuredBrowserService().kind).toBe("unavailable");
    const { serverWorkflow } = await import("../lib/chain/server");
    await expect(serverWorkflow()).rejects.toThrow(/reviewed raffle deployment is not configured/);
    expect(attest).not.toHaveBeenCalled();
  });

  it.each(["expected", "wrong-owner", "pending-owner", "wrong-approver", "wrong-policy"])("applies the registered Safe and pinned policy to membership trust: %s", async scenario => {
    const deployment = await import("../lib/chain/deployment");
    const [manifest] = deployment.APPROVED_DEPLOYMENTS;
    if (!manifest) throw new Error("Verified deployment missing.");
    vi.spyOn(deployment, "blockRef").mockResolvedValue(checkedBlock);
    vi.spyOn(deployment, "attestDeployment").mockResolvedValue({ kind: "verified", manifest, block: checkedBlock });
    const client = createPublicClient({ transport: http("http://127.0.0.1:1") });
    vi.spyOn(client, "getChainId").mockResolvedValue(11155111);
    const other = "0x1111111111111111111111111111111111111111";
    vi.spyOn(client, "readContract").mockImplementation(async input => {
      switch (input.functionName) {
        case "owner": return scenario === "wrong-owner" ? other : verifiedManifest.expectedOwner;
        case "pendingOwner": return scenario === "pending-owner" ? other : zeroAddress;
        case "getRaffleAdmission": return { approvedAtOpening: true, approvedBy: scenario === "wrong-approver" ? other : verifiedManifest.expectedOwner };
        case "getRafflePolicy": return { ...verifiedManifest.expectedPolicy, nativePayment: scenario !== "wrong-policy" };
        default: throw new Error(`Unexpected read: ${input.functionName}`);
      }
    });
    const { createReader } = await import("../lib/chain/reader");
    const trust = createReader(client, manifest).assertActionTrust({ kind: "membership", id: 1n });
    if (scenario === "expected") await expect(trust).resolves.toBeUndefined();
    else await expect(trust).rejects.toThrow(/owner differs|pending ownership|not opened with approval|policy does not match/);
  });

  it("retains runtime attestation after selecting the registered deployment and ignores production local overrides", async () => {
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", verifiedManifest.address);
    vi.stubEnv("NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST", "invalid local override");
    const deployment = await import("../lib/chain/deployment");
    const attest = vi.spyOn(deployment, "attestDeployment").mockResolvedValue({ kind: "mismatch", reason: "Contract bytecode does not match the reviewed deployment." });
    const { configuredBrowserService } = await import("../lib/chain/browser");
    const browser = configuredBrowserService();
    expect(browser.kind).toBe("configured");
    if (browser.kind !== "configured") throw new Error(browser.reason);
    expect(browser.service.manifest).toEqual(verifiedManifest);
    const { serverWorkflow } = await import("../lib/chain/server");
    await expect(serverWorkflow()).rejects.toThrow(/bytecode does not match/);
    expect(attest).toHaveBeenCalledExactlyOnceWith(expect.any(Object), verifiedManifest);
  });
});
