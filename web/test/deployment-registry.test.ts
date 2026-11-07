import { readFileSync } from "node:fs";
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
// Mainnet deployment of 7 Nov 2026 from main 972f46c, checked by `mainnet-deploy.sh verify`; ownership offered to the Safe.
// The address equals the Sepolia v2 contract's because the same deployer created both at nonce 19.
const verifiedMainnetManifest = {
  chainId: 1,
  address: "0xef27306567a5ADA354fe9403008D041d0b468213",
  runtimeCodeHash: "0xf7f4938d3c482fbde58a8eaec069d245d2869526ddcf0ac2a6547bd17a97929c",
  version: 3,
  deploymentBlock: 26364574n,
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  expectedOwner: "0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1",
  expectedPolicy: {
    coordinator: "0xD7f86b4b8Cae7D942340FF628F82735b7a20893a",
    treasury: "0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1",
    termsHash: "0x60b0227346cc2217a96c89385ca06119826c2d8493afe9134974c0324db0c06a",
    keyHash: "0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9",
    subscriptionId: 1165680495283281968999919437712128416672482874038033204695721395610623963137n,
    callbackGasLimit: 400000,
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

describe("verified Sepolia and mainnet deployment registration", () => {
  it("registers only the canonical v3 runtime, creation block, Safe authority and complete opening policy", () => {
    expect(APPROVED_DEPLOYMENTS).toEqual([verifiedManifest, verifiedMainnetManifest]);
    expect(verifiedManifest.expectedPolicy.termsHash).toBe(PUBLISHED_TERMS_HASH);
  });

  it("registers the mainnet deployment exactly as the deployment record and the mainnet terms describe it", async () => {
    const record = JSON.parse(readFileSync(new URL("../../deployments/mainnet.json", import.meta.url), "utf8"));
    expect(record.chainId).toBe(1);
    expect(record.create.address.toLowerCase()).toBe(verifiedMainnetManifest.address.toLowerCase());
    expect(BigInt(record.create.block)).toBe(verifiedMainnetManifest.deploymentBlock);
    expect(BigInt(record.stage1.subscriptionId)).toBe(verifiedMainnetManifest.expectedPolicy.subscriptionId);
    expect(record.safe).toBe(verifiedMainnetManifest.expectedOwner);
    expect(record.termsHash).toBe(verifiedMainnetManifest.expectedPolicy.termsHash);
    expect(record.coordinator).toBe(verifiedMainnetManifest.expectedPolicy.coordinator);
    expect(record.usdc).toBe(verifiedMainnetManifest.usdc);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "1");
    const mainnetTerms = await import("../lib/published-terms");
    expect(mainnetTerms.PUBLISHED_TERMS_HASH).toBe(verifiedMainnetManifest.expectedPolicy.termsHash);
  });

  it("selects the mainnet entry for the shared address only in a chain 1 build", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "1");
    vi.stubEnv("NEXT_PUBLIC_RAFFLE_ADDRESS", verifiedMainnetManifest.address);
    const deployment = await import("../lib/chain/deployment");
    const attest = vi.spyOn(deployment, "attestDeployment").mockResolvedValue({ kind: "verified", manifest: verifiedMainnetManifest, block: checkedBlock });
    const { configuredBrowserService } = await import("../lib/chain/browser");
    const browser = configuredBrowserService();
    expect(browser.kind).toBe("configured");
    if (browser.kind !== "configured") throw new Error(browser.reason);
    expect(browser.service.manifest).toEqual(verifiedMainnetManifest);
    const { serverWorkflow } = await import("../lib/chain/server");
    const server = await serverWorkflow();
    expect(server.manifest).toEqual(verifiedMainnetManifest);
    expect(server.context).toMatchObject({ chainId: 1, contract: verifiedMainnetManifest.address, termsHash: verifiedMainnetManifest.expectedPolicy.termsHash });
    expect(attest).toHaveBeenCalledExactlyOnceWith(expect.any(Object), verifiedMainnetManifest);
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
