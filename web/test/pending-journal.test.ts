import { fixtureTrust } from "./fixtures/deployment";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPendingJournal, transactionIntent } from "../lib/chain/pending-journal";
import type { DeploymentManifest } from "../lib/chain/types";
const address = "0x1111111111111111111111111111111111111111", other = "0x2222222222222222222222222222222222222222", hash = `0x${"ab".repeat(32)}` as const;
const manifest: DeploymentManifest = { ...fixtureTrust, chainId: 31337, address, usdc: other, runtimeCodeHash: hash, deploymentBlock: 1n, version: 3 };
afterEach(() => vi.unstubAllGlobals());
describe("nonsecret browser pending journal", () => {
  it("survives adapter recreation and separates accounts/deployments without persisting calldata", async () => {
    const map = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => map.delete(key) }, navigator: { locks: { request: (_key: string, run: () => unknown) => run() } } });
    const first = browserPendingJournal(manifest), digest = transactionIntent({ to: address, value: 1n, data: "0xdeadbeef" });
    await first.exclusive(address, async () => first.write(address, { id: "fixture", intentHash: digest, nonce: 2, startedBlock: "10", hash: null }));
    expect(browserPendingJournal(manifest).read(address)?.intentHash).toBe(digest);
    expect(browserPendingJournal(manifest).read(other)).toBeNull(); expect(browserPendingJournal({ ...manifest, address: other }).read(address)).toBeNull();
    const persisted = [...map.values()].join(); expect(persisted).not.toMatch(/deadbeef|salt|signature|privateCommitment|calldata/);
    expect(Object.keys(JSON.parse(persisted)).sort()).toEqual(["hash", "id", "intentHash", "nonce", "startedBlock"]);
  });
  it("reads an unreadable cleared-send marker as one below every nonce, so the next send stops once and removes it", () => {
    const map = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => map.delete(key) }, navigator: { locks: { request: (_key: string, run: () => unknown) => run() } } });
    const journal = browserPendingJournal(manifest);
    journal.writeCleared(address, { nonce: 4, startedBlock: "12" });
    expect(journal.readCleared(address)).toEqual({ nonce: 4, startedBlock: "12" });
    for (const key of map.keys()) map.set(key, "{tampered");
    expect(journal.readCleared(address)).toEqual({ nonce: -1, startedBlock: "0" });
    journal.writeCleared(address, null);
    expect(journal.readCleared(address)).toBeNull();
    expect(map.size).toBe(0);
  });
  it("fails closed when Web Locks or durable storage are unavailable", async () => {
    vi.stubGlobal("window", { navigator: {} }); expect(() => browserPendingJournal(manifest).read(address)).toThrow(/Web Locks/);
    vi.stubGlobal("window", { navigator: { locks: { request: (_key: string, run: () => unknown) => run() } }, get localStorage() { throw new Error("Storage denied"); } });
    expect(() => browserPendingJournal(manifest).read(address)).toThrow(/Storage denied/);
  });
});
