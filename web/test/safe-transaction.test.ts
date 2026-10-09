import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { raffleAbi } from "../lib/chain/abi";
import { parseSafeTransactionFile, safeTransactionChecksum, safeTransactionFile } from "../lib/chain/safe-transaction";
import type { DeploymentManifest, OwnerExecutionIntent } from "../lib/chain/types";

const SAFE: Address = "0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1";
const RAFFLE: Address = "0x8b0332D0ca48908e174F42eA1b3123e63f3F4327";
const DIGEST: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUNTIME = keccak256("0x1234");

const manifest: DeploymentManifest = {
  chainId: 11155111,
  address: RAFFLE,
  runtimeCodeHash: RUNTIME,
  version: 3,
  deploymentBlock: 1n,
  usdc: "0x1111111111111111111111111111111111111111",
  expectedOwner: SAFE,
  expectedPolicy: {
    coordinator: zeroAddress,
    treasury: zeroAddress,
    termsHash: zeroHash,
    keyHash: zeroHash,
    subscriptionId: 1n,
    callbackGasLimit: 500_000,
    requestConfirmations: 3,
    nativePayment: false,
    buyerFeeBps: 200,
    sellerFeeBps: 200,
    minBuyerFeeUsdc: 2_500_000n
  }
};

const intent: OwnerExecutionIntent = {
  action: {
    kind: "approveRaffle",
    id: 17n,
    expectedReviewHash: DIGEST,
    attestations: { canonicalProvenance: true, transferRestrictions: true, drawFunding: true }
  },
  runtimeCodeHash: RUNTIME,
  chainId: 11155111,
  from: SAFE,
  to: RAFFLE,
  value: 0n,
  data: encodeFunctionData({ abi: raffleAbi, functionName: "approveRaffle", args: [17n, DIGEST] }),
  reviewBlock: { number: 100n, hash: zeroHash, timestamp: 1_800_000_000n },
  ownerGeneration: 2n,
  openingPolicyGeneration: 3n,
  reviewRevision: 4n
};

describe("Safe Transaction Builder handoff", () => {
  it("matches the pinned Transaction Builder 2.0.1 checksum fixture", () => {
    const fixture = {
      version: "1.0",
      chainId: "11155111",
      createdAt: 0,
      meta: {
        name: "LABx raffle approval fixture",
        description: "Compatibility fixture only",
        txBuilderVersion: "2.0.1",
        createdFromSafeAddress: SAFE,
        createdFromOwnerAddress: "",
        checksum: "0x4c0d280f7eb9c37c57c271709470469fbb3a6576d677b827835adbf9262ff871" as Hex
      },
      transactions: [{ to: RAFFLE, value: "0", data: "0x1234" as Hex }]
    };
    expect(safeTransactionChecksum(fixture)).toBe(fixture.meta.checksum);
  });

  it("serializes one exact zero-ETH CALL for the displayed owner intent", () => {
    const file = safeTransactionFile({ intent, manifest, createdAt: 1_800_000_000_000 });
    expect(file.filename).toMatch(/^labx-approve-raffle-17-[a-f0-9]{12}\.json$/);
    expect(file.batch).toMatchObject({
      version: "1.0",
      chainId: "11155111",
      createdAt: 1_800_000_000_000,
      meta: {
        txBuilderVersion: "2.0.1",
        createdFromSafeAddress: SAFE,
        createdFromOwnerAddress: ""
      },
      transactions: [{ to: RAFFLE, value: "0", data: intent.data }]
    });
    expect(file.batch.transactions).toHaveLength(1);
    expect(file.content).not.toMatch(/contractMethod|contractInputsValues|operation|delegatecall/i);
    expect(parseSafeTransactionFile(file.content, { intent, manifest })).toEqual(file.batch);
  });

  it.each([
    ["chain", (batch: Record<string, unknown>) => { batch.chainId = "1"; }],
    ["Safe", (batch: Record<string, unknown>) => { (batch.meta as Record<string, unknown>).createdFromSafeAddress = zeroAddress; }],
    ["target", (batch: Record<string, unknown>) => { ((batch.transactions as Record<string, unknown>[])[0]).to = SAFE; }],
    ["value", (batch: Record<string, unknown>) => { ((batch.transactions as Record<string, unknown>[])[0]).value = "1"; }],
    ["calldata", (batch: Record<string, unknown>) => { ((batch.transactions as Record<string, unknown>[])[0]).data = "0x1234"; }],
    ["checksum", (batch: Record<string, unknown>) => { (batch.meta as Record<string, unknown>).checksum = zeroHash; }]
  ])("rejects an altered %s instead of authorizing arbitrary Safe data", (_field, alter) => {
    const file = safeTransactionFile({ intent, manifest, createdAt: 1_800_000_000_000 });
    const parsed = JSON.parse(file.content) as Record<string, unknown>;
    alter(parsed);
    expect(() => parseSafeTransactionFile(JSON.stringify(parsed), { intent, manifest })).toThrow();
  });
});
