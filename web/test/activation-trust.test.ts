import { describe, expect, it } from "vitest";
import { parseLocalManifest } from "../lib/chain/manifest";
import { requireExpectedPolicy } from "../lib/chain/action-trust";
import { fixtureTrust } from "./fixtures/deployment";
import type { RafflePolicy } from "../lib/chain/types";

const raw = {
  chainId: 31337, version: 3, address: fixtureTrust.expectedOwner, usdc: fixtureTrust.expectedPolicy.coordinator,
  runtimeCodeHash: fixtureTrust.expectedPolicy.keyHash, deploymentBlock: "1", expectedOwner: fixtureTrust.expectedOwner,
  expectedPolicy: { ...fixtureTrust.expectedPolicy, subscriptionId: "1", minBuyerFeeUsdc: "2500000" }
};
const policyChanges = {
  coordinator: fixtureTrust.expectedOwner, treasury: fixtureTrust.expectedOwner,
  termsHash: `0x${"ab".repeat(32)}`, keyHash: `0x${"ab".repeat(32)}`,
  subscriptionId: 2n, callbackGasLimit: 500_001, requestConfirmations: 4, nativePayment: true,
  buyerFeeBps: 201, sellerFeeBps: 201, minBuyerFeeUsdc: 2_500_001n
} satisfies RafflePolicy;
export const changedPolicies = Object.entries(policyChanges).map(([name, value]) => ({ name, policy: { ...fixtureTrust.expectedPolicy, [name]: value } }));

describe("activation manifest and complete policy comparison", () => {
  it("retains the exact expected authority and ABI-derived policy", () => {
    expect(parseLocalManifest(raw)).toMatchObject(fixtureTrust);
    const uppercase = { ...fixtureTrust.expectedPolicy, termsHash: `0x${fixtureTrust.expectedPolicy.termsHash.slice(2).toUpperCase()}`, keyHash: `0x${fixtureTrust.expectedPolicy.keyHash.slice(2).toUpperCase()}` } satisfies RafflePolicy;
    expect(() => requireExpectedPolicy(uppercase, fixtureTrust.expectedPolicy)).not.toThrow();
  });
  it.each(changedPolicies)("rejects differing $name", ({ policy }) => {
    expect(() => requireExpectedPolicy(policy, fixtureTrust.expectedPolicy)).toThrow(/policy does not match/);
  });
  it.each(Object.keys(raw.expectedPolicy))("requires policy member %s", name => {
    const policy: Record<string, unknown> = { ...raw.expectedPolicy }; delete policy[name];
    expect(() => parseLocalManifest({ ...raw, expectedPolicy: policy })).toThrow();
  });
  it.each([
    {}, { expectedOwner: undefined }, { expectedOwner: "0x" + "0".repeat(40) }, { expectedPolicy: undefined },
    { expectedPolicy: [] }, { deploymentBlock: "-1" }, { deploymentBlock: "1.5" }, { deploymentBlock: "01" }, { deploymentBlock: (2n ** 256n).toString() },
    { expectedPolicy: { ...raw.expectedPolicy, nativePayment: "false" } },
    { expectedPolicy: { ...raw.expectedPolicy, subscriptionId: 1 } },
    { expectedPolicy: { ...raw.expectedPolicy, subscriptionId: "-1" } },
    { expectedPolicy: { ...raw.expectedPolicy, minBuyerFeeUsdc: (2n ** 256n).toString() } },
    { expectedPolicy: { ...raw.expectedPolicy, buyerFeeBps: "200" } },
    { expectedPolicy: { ...raw.expectedPolicy, sellerFeeBps: 65536 } },
    { expectedPolicy: { ...raw.expectedPolicy, requestConfirmations: 0.5 } },
    { expectedPolicy: { ...raw.expectedPolicy, callbackGasLimit: 2 ** 32 } },
    { expectedPolicy: { ...raw.expectedPolicy, termsHash: "0x12" } },
    { expectedPolicy: { ...raw.expectedPolicy, coordinator: "invalid" } }
  ])("rejects malformed authority/policy values %#", changed => {
    expect(() => parseLocalManifest(Object.keys(changed).length ? { ...raw, ...changed } : {})).toThrow();
  });
});
