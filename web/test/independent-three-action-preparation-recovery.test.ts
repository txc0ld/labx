import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, verifyMessage, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MemoryStore } from "../lib/store";
import { workflowMessage } from "../lib/chain/messages";
import type { CommitmentInput, PreparationRecoveryInput, WorkflowContext } from "../lib/chain/api-types";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { recoverAuthenticatedPreparation, saveAuthenticatedCommitment } from "../lib/workflow-records";

const now = 1_791_000_000_000;
const seller = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const context: WorkflowContext = {
  origin: "https://labx.example",
  chainId: 11155111,
  contract: "0x1111111111111111111111111111111111111111",
  termsHash: PUBLISHED_TERMS_HASH,
  termsVersion: TERMS_VERSION
};
const input: CommitmentInput = {
  nft: "0x2222222222222222222222222222222222222222",
  tokenId: "982451653",
  publicSummary: "Independent lost-response recovery",
  privateCommitment: "independent-private-value-that-must-never-be-returned"
};

function requestIdentity(scope: WorkflowContext, account = seller.address, value = input) {
  return keccak256(toBytes(JSON.stringify([
    scope.chainId,
    scope.contract.toLowerCase(),
    account.toLowerCase(),
    { ...value, nft: value.nft, tokenId: BigInt(value.tokenId).toString(), publicSummary: value.publicSummary.trim(), privateCommitment: value.privateCommitment.trim() }
  ])));
}

async function signed<T>(operation: Parameters<typeof workflowMessage>[0], value: T, account = seller, scope = context, deadline = String(now / 1000 + 120)) {
  return {
    address: account.address,
    input: value,
    deadline,
    signature: await account.signMessage({ message: workflowMessage(operation, scope, account.address, value, deadline) })
  };
}

function recovery(overrides: Partial<PreparationRecoveryInput> = {}): PreparationRecoveryInput {
  return { requestIdentity: requestIdentity(context), nft: input.nft, tokenId: input.tokenId, ...overrides };
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => vi.restoreAllMocks());

describe("independent lost preparation response recovery", () => {
  it("recovers the exact public preparation after a successful write whose response was lost", async () => {
    const store = new MemoryStore();
    const created = await saveAuthenticatedCommitment(store, await signed("commitment", input), context, verifyMessage);

    // Simulate a client that persisted only requestIdentity before dispatch and never received `created`.
    const recovered = await recoverAuthenticatedPreparation(
      store,
      await signed("preparation recovery", recovery()),
      context,
      verifyMessage
    );

    expect(recovered).toEqual(created);
    expect(recovered).not.toHaveProperty("salt");
    expect(recovered).not.toHaveProperty("privateHash");
    expect(recovered).not.toHaveProperty("privateCommitment");
    expect(JSON.stringify(recovered)).not.toContain(input.privateCommitment);
    expect(await store.get(`reserve-request:v3:${requestIdentity(context)}`)).toBe(created.commit);
  });

  it("treats requestIdentity as untrusted and rejects a valid signature from the wrong wallet", async () => {
    const store = new MemoryStore();
    await saveAuthenticatedCommitment(store, await signed("commitment", input), context, verifyMessage);
    const attackerInput = recovery();

    await expect(recoverAuthenticatedPreparation(
      store,
      await signed("preparation recovery", attackerInput, stranger),
      context,
      verifyMessage
    )).rejects.toThrow(/integrity|does not belong/i);
  });

  it("rejects signatures bound to another operation, origin, deployment, NFT, token or deadline", async () => {
    const store = new MemoryStore();
    await saveAuthenticatedCommitment(store, await signed("commitment", input), context, verifyMessage);
    const exact = recovery();

    const wrongOperation = await signed("commitment recovery", exact);
    await expect(recoverAuthenticatedPreparation(store, wrongOperation, context, verifyMessage)).rejects.toThrow(/authorization/i);

    const otherOrigin = { ...context, origin: "https://other.example" };
    await expect(recoverAuthenticatedPreparation(store, await signed("preparation recovery", exact, seller, otherOrigin), context, verifyMessage)).rejects.toThrow(/authorization/i);

    const otherDeployment = { ...context, contract: "0x3333333333333333333333333333333333333333" as const };
    await expect(recoverAuthenticatedPreparation(store, await signed("preparation recovery", exact, seller, otherDeployment), otherDeployment, verifyMessage)).rejects.toThrow(/does not belong/i);

    for (const changed of [
      recovery({ nft: "0x4444444444444444444444444444444444444444" }),
      recovery({ tokenId: "982451654" })
    ]) {
      await expect(recoverAuthenticatedPreparation(store, await signed("preparation recovery", changed), context, verifyMessage)).rejects.toThrow(/does not belong/i);
    }

    const expired = await signed("preparation recovery", exact, seller, context, "1");
    await expect(recoverAuthenticatedPreparation(store, expired, context, verifyMessage)).rejects.toThrow(/expired/i);
  });

  it("does not leak private fields from a stored record and fails closed on missing or mismatched metadata", async () => {
    const store = new MemoryStore();
    const created = await saveAuthenticatedCommitment(store, await signed("commitment", input), context, verifyMessage);
    const raw = await store.get(`reserve:${created.commit}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(input.privateCommitment);

    const missingIdentity = `0x${"ab".repeat(32)}` as Hex;
    await expect(recoverAuthenticatedPreparation(
      store,
      await signed("preparation recovery", recovery({ requestIdentity: missingIdentity })),
      context,
      verifyMessage
    )).rejects.toThrow(/not yet available|without creating a new setup/i);

    if (raw === null) throw new Error("Fixture preparation record missing.");
    await store.set(`reserve:${created.commit}`, JSON.stringify({ ...JSON.parse(raw), tokenId: "7" }));
    await expect(recoverAuthenticatedPreparation(
      store,
      await signed("preparation recovery", recovery()),
      context,
      verifyMessage
    )).rejects.toThrow(/integrity|does not belong/i);
  });
});
