import { afterEach, describe, expect, it, vi } from "vitest";
import { localDevelopmentManifest } from "../lib/chain/browser";
import { serverWorkflow } from "../lib/chain/server";

const expectedOwner = "0x1111111111111111111111111111111111111111";
const manifest = {
  chainId: 31337,
  version: 3,
  address: "0x2222222222222222222222222222222222222222",
  usdc: "0x3333333333333333333333333333333333333333",
  runtimeCodeHash: `0x${"44".repeat(32)}`,
  deploymentBlock: "17",
  expectedOwner,
  expectedPolicy: {
    coordinator: "0x5555555555555555555555555555555555555555",
    treasury: "0x6666666666666666666666666666666666666666",
    termsHash: `0x${"77".repeat(32)}`,
    keyHash: `0x${"88".repeat(32)}`,
    subscriptionId: "9",
    callbackGasLimit: 500_000,
    requestConfirmations: 3,
    nativePayment: true,
    buyerFeeBps: 200,
    sellerFeeBps: 200,
    minBuyerFeeUsdc: "2500000"
  }
};
type ManifestFixture = typeof manifest;
type Malformation = readonly [string, (value: ManifestFixture) => unknown];
const malformations: readonly Malformation[] = [
  ["missing expected owner", ({ expectedOwner: _ignored, ...value }) => value],
  ["invalid expected owner", value => ({ ...value, expectedOwner: "0x1234" })],
  ["missing expected policy", ({ expectedPolicy: _ignored, ...value }) => value],
  ["numeric subscription", value => ({ ...value, expectedPolicy: { ...value.expectedPolicy, subscriptionId: 9 } })],
  ["numeric minimum fee", value => ({ ...value, expectedPolicy: { ...value.expectedPolicy, minBuyerFeeUsdc: 2_500_000 } })],
  ["string callback gas", value => ({ ...value, expectedPolicy: { ...value.expectedPolicy, callbackGasLimit: "500000" } })],
  ["fractional buyer fee", value => ({ ...value, expectedPolicy: { ...value.expectedPolicy, buyerFeeBps: 200.5 } })],
  ["string native billing", value => ({ ...value, expectedPolicy: { ...value.expectedPolicy, nativePayment: "true" } })],
  ["missing policy member", value => {
    const { requestConfirmations: _ignored, ...expectedPolicy } = value.expectedPolicy;
    return { ...value, expectedPolicy };
  }]
];

describe("independent v3 authority manifest parsing", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("retains every required authority and policy field with exact numeric semantics", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(localDevelopmentManifest(JSON.stringify(manifest))).toMatchObject({
      expectedOwner,
      expectedPolicy: {
        ...manifest.expectedPolicy,
        subscriptionId: 9n,
        minBuyerFeeUsdc: 2_500_000n
      }
    });
  });

  it.each(malformations)("rejects %s instead of silently weakening the reviewed manifest", async (_label, alter) => {
    vi.stubEnv("NODE_ENV", "development");
    const raw = JSON.stringify(alter(manifest));
    expect(() => localDevelopmentManifest(raw)).toThrow(/invalid local fixture manifest/i);

    vi.stubEnv("NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST", raw);
    vi.stubEnv("NEXT_PUBLIC_LOCAL_RPC_URL", "http://127.0.0.1:1");
    await expect(serverWorkflow()).rejects.toThrow(/configuration is invalid/i);
  });
});
