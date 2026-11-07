import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage, keccak256, toBytes, type Hex } from "viem";
import { MemoryStore } from "../lib/store";
import { saveAuthenticatedCommitment, recoverAuthenticatedCommitment, recoverAuthenticatedPreparation } from "../lib/workflow-records";
import { privateRecords } from "../lib/private-records";
import { workflowMessage } from "../lib/chain/messages";
import type { CommitmentInput, WorkflowContext } from "../lib/chain/api-types";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { agreementMessage, recordAgreement, type AgreementRequest } from "../lib/agreement-record";
import { hashCommitment } from "../lib/commitment";
import { signatureVerifier } from "../lib/chain/server";

const now = 1_791_000_000_000;
const seller = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const context: WorkflowContext = { origin: "https://labx.example", chainId: 11155111, contract: "0x1111111111111111111111111111111111111111", termsHash: PUBLISHED_TERMS_HASH, termsVersion: TERMS_VERSION };
const input: CommitmentInput = { nft: "0x2222222222222222222222222222222222222222", tokenId: "1", publicSummary: "Escrowed NFT prize.", privateCommitment: "Private fixture description" };
const deadline = String(now / 1000 + 120);
async function signed<T>(operation: Parameters<typeof workflowMessage>[0], value: T, account = seller, scope = context) {
  return { address: account.address, input: value, deadline, signature: await account.signMessage({ message: workflowMessage(operation, scope, account.address, value, deadline) }) };
}
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); });
afterEach(() => vi.restoreAllMocks());
describe("authenticated durable workflow records", () => {
  it("atomically recovers one commitment across concurrent requests and signed retries", async () => {
    const store = new MemoryStore(), request = await signed("commitment", input);
    const results = await Promise.all(Array.from({ length: 8 }, () => saveAuthenticatedCommitment(store, request, context, verifyMessage)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).not.toHaveProperty("salt"); expect(results[0]).not.toHaveProperty("privateHash");
    const raw = await store.get(`reserve:${results[0].commit}`); expect(raw).not.toContain(input.privateCommitment);
    const recovered = await recoverAuthenticatedCommitment(store, await signed("commitment recovery", { commit: results[0].commit }), context, verifyMessage);
    expect(hashCommitment({ ...recovered, chainId: BigInt(recovered.chainId), tokenId: BigInt(recovered.tokenId) })).toBe(results[0].commit);
  });
  it("rejects victim impersonation, changed commitments, other origins, networks and expired requests", async () => {
    const store = new MemoryStore(), request = await signed("commitment", input);
    await expect(saveAuthenticatedCommitment(store, { ...request, address: other.address }, context, verifyMessage)).rejects.toThrow(/authorization/);
    await expect(saveAuthenticatedCommitment(store, { ...request, input: { ...input, tokenId: "2" } }, context, verifyMessage)).rejects.toThrow(/authorization/);
    for (const scope of [{ ...context, origin: "https://other.example" }, { ...context, chainId: 31337 as const }]) await expect(saveAuthenticatedCommitment(store, request, scope, verifyMessage)).rejects.toThrow(/authorization/);
    await expect(saveAuthenticatedCommitment(store, { ...request, deadline: "1" }, context, verifyMessage)).rejects.toThrow(/expired/);
  });
  it("never acknowledges failed writes or corrupt commitment records", async () => {
    const store = new MemoryStore(), request = await signed("commitment", input);
    vi.spyOn(store, "setIfAbsent").mockRejectedValueOnce(new Error("storage offline"));
    await expect(saveAuthenticatedCommitment(store, request, context, verifyMessage)).rejects.toThrow(/storage offline/);
    const created = await saveAuthenticatedCommitment(store, request, context, verifyMessage);
    await store.set(`reserve:${created.commit}`, JSON.stringify({ ...created, privateHash: "0x", salt: "0x" }));
    await expect(recoverAuthenticatedCommitment(store, await signed("commitment recovery", { commit: created.commit }), context, verifyMessage)).rejects.toThrow();
  });
  it("keeps recovered secrets wallet-bound even with a valid attacker signature", async () => {
    const store = new MemoryStore(); const created = await saveAuthenticatedCommitment(store, await signed("commitment", input), context, verifyMessage);
    await expect(recoverAuthenticatedCommitment(store, await signed("commitment recovery", { commit: created.commit }, other), context, verifyMessage)).rejects.toThrow(/does not belong/);
  });
  it("recovers only public preparation data after a lost response and binds identity to seller, deployment and NFT", async () => {
    const store = new MemoryStore();
    const created = await saveAuthenticatedCommitment(store, await signed("commitment", input), context, verifyMessage);
    const requestIdentity = keccak256(toBytes(JSON.stringify([context.chainId, context.contract.toLowerCase(), seller.address.toLowerCase(), input])));
    const recovery = { requestIdentity, nft: input.nft, tokenId: input.tokenId };
    const recovered = await recoverAuthenticatedPreparation(store, await signed("preparation recovery", recovery), context, verifyMessage);
    expect(recovered).toEqual(created);
    expect(recovered).not.toHaveProperty("salt");
    expect(recovered).not.toHaveProperty("privateHash");
    expect(JSON.stringify(recovered)).not.toContain(input.privateCommitment);
    await expect(recoverAuthenticatedPreparation(store, await signed("preparation recovery", recovery, other), context, verifyMessage)).rejects.toThrow(/does not belong/);
    await expect(recoverAuthenticatedPreparation(store, await signed("preparation recovery", { ...recovery, tokenId: "2" }), context, verifyMessage)).rejects.toThrow(/does not belong/);
    await expect(recoverAuthenticatedPreparation(store, await signed("preparation recovery", recovery), { ...context, origin: "https://other.example" }, verifyMessage)).rejects.toThrow(/authorization/);
    await expect(recoverAuthenticatedPreparation(store, await signed("preparation recovery", { ...recovery, requestIdentity: keccak256(toBytes("missing")) }), context, verifyMessage)).rejects.toThrow(/not yet available/);
  });
  it("retrieves only authenticated wallet agreements and rejects unpublished legal hashes", async () => {
    const store = new MemoryStore();
    const agreement: AgreementRequest = { address: seller.address, pieceId: "1", terms: true, rules: true, age: true, termsHash: PUBLISHED_TERMS_HASH, deadline, signature: "0x" };
    agreement.signature = await seller.signMessage({ message: agreementMessage(agreement, context) });
    await recordAgreement(store, agreement, context, now);
    const selection = { raffleIds: ["1", "2"], purchases: [] };
    const records = await privateRecords(store, await signed("private records", selection), context, verifyMessage);
    expect(records.agreements).toEqual([{ raffleId: "1", recorded: true, at: new Date(now).toISOString() }, { raffleId: "2", recorded: false, at: null }]);
    const victimRequest = await signed("private records", selection, other);
    await expect(privateRecords(store, { ...victimRequest, address: seller.address }, context, verifyMessage)).rejects.toThrow(/authorization/);
    expect((await privateRecords(store, victimRequest, context, verifyMessage)).agreements.every(record => !record.recorded)).toBe(true);
    const different: Hex = `0x${"ab".repeat(32)}`;
    await expect(recordAgreement(store, { ...agreement, termsHash: different }, { ...context, termsHash: different }, now)).rejects.toThrow(/published/);
  });
  it("leaves out a stored agreement its contract signer no longer validates and returns the other records", async () => {
    const store = new MemoryStore();
    const wallet = "0x5555555555555555555555555555555555555555" as const;
    const agreementSignature: Hex = `0x${"ab".repeat(40)}`, recordsSignature: Hex = `0x${"cd".repeat(40)}`;
    // The wallet contract's verdict on the stored agreement signature, as after the Safe owners who made it were removed.
    let storedVerdict: "valid" | "invalid" | "no answer" = "valid";
    const verify = signatureVerifier({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_getCode") return "0x";
        if (method !== "eth_call") throw new Error("unsupported");
        if (!JSON.stringify(params).includes(agreementSignature.slice(2))) return "0x01";
        if (storedVerdict === "no answer") throw new Error("socket hang up");
        return storedVerdict === "valid" ? "0x01" : "0x00";
      }
    } as Parameters<typeof signatureVerifier>[0]);
    const agreement: AgreementRequest = { address: wallet, pieceId: "1", terms: true, rules: true, age: true, termsHash: PUBLISHED_TERMS_HASH, deadline, signature: agreementSignature };
    await recordAgreement(store, agreement, context, now, verify);
    const selection = { raffleIds: ["1", "2"], purchases: [{ transactionHash: `0x${"12".repeat(32)}` as Hex, logIndex: 0 }] };
    const request = { address: wallet, input: selection, deadline, signature: recordsSignature };
    expect((await privateRecords(store, request, context, verify)).agreements[0]).toEqual({ raffleId: "1", recorded: true, at: new Date(now).toISOString() });

    storedVerdict = "invalid";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await privateRecords(store, request, context, verify)).toEqual({
      agreements: [{ raffleId: "1", recorded: false, at: null }, { raffleId: "2", recorded: false, at: null }],
      receipts: [{ ...selection.purchases[0], sent: [], full: false }]
    });
    expect(warn).toHaveBeenCalledWith("private-records stored-agreement-unverified", { raffleId: "1" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(agreementSignature.slice(2));

    // A node that gives no verdict is still a failure the caller can retry, not a missing agreement.
    storedVerdict = "no answer";
    await expect(privateRecords(store, request, context, verify)).rejects.toThrow(/did not check the signature/);
  });
});
