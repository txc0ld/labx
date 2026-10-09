import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http, zeroHash } from "viem";
import { createRaffleService } from "../lib/chain/service";
import { WalletSession } from "../lib/chain/wallet-session";
import { advanceCreateGeneration, assertCreateGeneration, captureCreateGeneration, encodeDraft, readCreateRecord, retireCompletedCreate, retireUnsentCreate, writeCreateRecord, type CreateRecord } from "../lib/chain/create-flow";
import type { DeploymentManifest } from "../lib/chain/types";
import { fixtureTrust } from "./fixtures/deployment";
class StorageFixture implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const manifest: DeploymentManifest = { ...fixtureTrust, chainId: 31337, version: 3, address: "0x4444444444444444444444444444444444444444", usdc: "0x5555555555555555555555555555555555555555", runtimeCodeHash: zeroHash, deploymentBlock: 1n };
const data = encodeDraft({ nft: manifest.usdc, tokenId: 1n, title: "Retained public draft", salesEnd: 2_000_000_000n, reserveNonce: zeroHash, reserveCommit: zeroHash, packs: [{ name: "Entry", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 }] });
function setup(expected: CreateRecord) {
  const storage = new StorageFixture(), key = "creation";
  writeCreateRecord(storage, key, expected);
  const wallet = new WalletSession(undefined, 31337);
  const service = createRaffleService(createPublicClient({ transport: http("http://127.0.0.1:1") }), manifest);
  const pending = vi.spyOn(service, "pending").mockResolvedValue(null);
  const submit = vi.spyOn(service, "submit");
  return { storage, key, wallet, service, pending, submit, expected, assertIntent: () => {} };
}
afterEach(() => vi.restoreAllMocks());
describe("explicit unsent creation recovery", () => {
  it.each<CreateRecord>([{ kind: "preparing", data, requestIdentity: zeroHash }, { kind: "draft", data, creationHash: null, id: null, pending: null }])("archives only public preparation/draft data before retirement", async expected => {
    const input = setup(expected), clicked = captureCreateGeneration(input.storage, input.key);
    await retireUnsentCreate(input);
    expect(input.storage.getItem(input.key)).toBeNull();
    expect([...input.storage.values.entries()].filter(([key]) => key.includes(":retired:")).map(([, raw]) => JSON.parse(raw))).toEqual([expected]);
    expect(() => assertCreateGeneration(input.storage, input.key, clicked)).toThrow(/changed/);
    expect(input.submit).not.toHaveBeenCalled();
  });
  it.each([{ id: "1", creationHash: null, pending: null }, { id: null, creationHash: zeroHash, pending: null }, { id: null, creationHash: null, pending: { step: "createDraft" as const, hash: null } }])("does not reset any on-chain footprint", async fields => {
    const input = setup({ kind: "draft", data, ...fields });
    await expect(retireUnsentCreate(input)).rejects.toThrow(/on-chain creation/);
    expect(readCreateRecord(input.storage, input.key)).toEqual(input.expected);
  });
  it("retains the record when a global journal exists or the scope retires during its read", async () => {
    const input = setup({ kind: "preparing", data, requestIdentity: zeroHash });
    input.pending.mockResolvedValueOnce({ id: "unknown-send", nonce: 8, hash: null });
    await expect(retireUnsentCreate(input)).rejects.toThrow(/unresolved wallet/);
    let current = true;
    input.pending.mockImplementationOnce(async () => { current = false; return null; });
    await expect(retireUnsentCreate({ ...input, assertIntent: () => { if (!current) throw new Error("retired scope"); } })).rejects.toThrow("retired scope");
    expect(readCreateRecord(input.storage, input.key)).toEqual(input.expected);
    expect(input.submit).not.toHaveBeenCalled();
  });
  it("does not remove recovery when archival storage fails", async () => {
    const input = setup({ kind: "preparing", data, requestIdentity: zeroHash });
    vi.spyOn(input.storage, "setItem").mockImplementation(() => { throw new Error("storage refused"); });
    await expect(retireUnsentCreate(input)).rejects.toThrow("storage refused");
    expect(readCreateRecord(input.storage, input.key)).toEqual(input.expected);
  });
  it("rejects queued null-to-null creation even if the first tab has completed", () => {
    const storage = new StorageFixture(), key = "creation";
    const clicked = captureCreateGeneration(storage, key);
    advanceCreateGeneration(storage, key);
    const completed: Extract<CreateRecord, { kind: "draft" }> = { kind: "draft", data, id: "1", creationHash: zeroHash, pending: null };
    writeCreateRecord(storage, key, completed);
    retireCompletedCreate(storage, key, completed, 1n);
    expect(storage.getItem(key)).toBeNull();
    expect(() => assertCreateGeneration(storage, key, clicked)).toThrow(/another tab/);
    const next = captureCreateGeneration(storage, key);
    expect(() => assertCreateGeneration(storage, key, next)).not.toThrow();
  });
});
